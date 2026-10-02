"use client";

import { create } from "zustand";
import { BOOKABLE_ROOMS, ROOM_BY_ID } from "@/data/campus";
import * as E from "@/lib/engine";
import { CLUBS, FACULTY, rng, seedState, STUDENTS } from "@/lib/seed";
import { addDays, DAY_END, DAY_START, nowMinutes, todayISO } from "@/lib/time";
import { browserClient, REMOTE } from "@/lib/remote/client";
import { ActionError, authorize, runAction, type Action, type ActionOutput } from "@/lib/actions";
import type { Op, OpResult } from "@/lib/remote/ops";
import { HOLDING, type BookingRequest, type BookResult, type Purpose, type Role } from "@/lib/types";

export type Panel = "none" | "bookings" | "approvals" | "conflicts" | "chaos" | "admin" | "notifications" | "swaps";
export type ColorMode = "state" | "type";

export const ME: Record<Role, string> = {
  student: "Demo Student",
  faculty: "Demo Faculty",
  approver: "Demo Approver",
  admin: "Demo Admin",
};

export interface Toast {
  id: number;
  title: string;
  body: string;
  tone: "info" | "ok" | "warn" | "bad";
}

export interface ChaosStats {
  running: boolean;
  sent: number;
  total: number;
  confirmed: number;
  pending: number;
  conflicts: number;
  bumped: number;
  negotiated: number;
  shared: number;
  rejected: number;
  escalated: number;
  doubleBookings: number;
  optimised?: { before: number; after: number; moved: number; via: "CP-SAT" | "greedy" };
}

export interface Session {
  email: string;
  name: string;
  role: Role;
  token: string;
}

export type BookInput = Omit<BookingRequest, "requester" | "role"> & { requester?: string; role?: Role; asAgent?: boolean };

interface State {
  ready: boolean;
  remote: boolean;
  session: Session | null;
  me: string;
  readIds: string[];
  markRead: (ids: string[]) => void;
  engine: E.EngineState;
  today: string;
  nowMin: number;
  date: string;
  time: number;
  floor: 1 | 2 | 3;
  role: Role;
  panel: Panel;
  colorMode: ColorMode;
  filters: { minCap: number; tag: string; kind: string };
  selected: string | null;
  flashes: Record<string, { tone: Toast["tone"]; at: number }>;
  toasts: Toast[];
  chaos: ChaosStats;
  liveFeed: boolean;

  init: () => void;
  tick: () => void;
  set: (p: Partial<Pick<State, "date" | "time" | "floor" | "panel" | "colorMode" | "selected" | "liveFeed">>) => void;
  setRole: (r: Role) => void;
  setFilters: (f: Partial<State["filters"]>) => void;
  toast: (t: Omit<Toast, "id">) => void;
  dismiss: (id: number) => void;
  book: (req: BookInput) => Promise<BookResult>;
  act: (kind: "approve" | "reject" | "cancel" | "release" | "checkin" | "noshow" | "escalate", id: string, quiet?: boolean) => Promise<void>;
  waitlist: (req: Omit<BookingRequest, "requester" | "role">) => Promise<void>;
  reset: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Run any engine action (negotiation, swap, counter, hold, claim, rules…) locally or via the API. */
  dispatch: (a: Action, quiet?: boolean) => Promise<ActionOutput & { error?: string }>;
  signIn: (email: string, password: string) => Promise<string | null>;
  signOut: () => Promise<void>;
  runChaos: () => void;
  optimise: () => Promise<void>;
}

const KEY = "xie-spaces-v1";
const channel = typeof window !== "undefined" && "BroadcastChannel" in window ? new BroadcastChannel(KEY) : null;
let chaosTimer: ReturnType<typeof setInterval> | null = null;
let toastSeq = 0;

const ctxOf = (s: { today: string; nowMin: number }): E.RuleContext => ({ today: s.today, nowMin: s.nowMin });

function save(engine: E.EngineState, today: string) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ today, engine }));
  } catch {}
  channel?.postMessage({ engine });
}

const emptyChaos: ChaosStats = { running: false, sent: 0, total: 50, confirmed: 0, pending: 0, conflicts: 0, bumped: 0, negotiated: 0, shared: 0, rejected: 0, escalated: 0, doubleBookings: 0 };

export const useStore = create<State>((set, get) => {
  /** Run a mutation against a copy of the engine state, persist and broadcast (our "Realtime"). */
  function mutate<T>(fn: (s: E.EngineState) => T): T {
    const s = structuredClone(get().engine);
    const out = fn(s);
    set({ engine: s });
    save(s, get().today);
    return out;
  }

  function flash(roomIds: string[], tone: Toast["tone"]) {
    const now = Date.now();
    set((st) => ({ flashes: { ...st.flashes, ...Object.fromEntries(roomIds.map((id) => [id, { tone, at: now }])) } }));
  }

  /** Remote write: the server re-runs rules with the caller's real role, then persists atomically. */
  async function exec(op: Op): Promise<OpResult & { error?: string }> {
    const token = get().session?.token;
    const res = await fetch("/api/engine", {
      method: "POST",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(op),
    }).catch(() => null);
    const out = res ? await res.json().catch(() => ({ error: "Bad response" })) : { error: "Network error" };
    if (op.type !== "sweep") void get().refresh();
    return out;
  }

  const failed = (roomIds: string[], text: string): BookResult => ({
    ok: false,
    code: "RULE",
    event: { id: `err-${Date.now()}`, at: Date.now(), kind: "rejected_rule", roomIds, text },
    alternatives: [],
  });

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleRefresh = () => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void get().refresh(), 250);
  };

  async function applySession(session: { access_token: string; user: { id: string; email?: string } } | null) {
    if (!session) return set({ session: null, me: "Guest", role: "student" });
    const { data } = await browserClient().from("profiles").select("full_name, role").eq("id", session.user.id).single();
    const name = data?.full_name ?? session.user.email ?? "User";
    const role = (data?.role ?? "student") as Role;
    set({ session: { email: session.user.email ?? "", name, role, token: session.access_token }, me: name, role });
  }

  function toneOf(r: BookResult): Toast["tone"] {
    if (r.ok) return r.bumped ? "warn" : r.booking.status === "pending_approval" ? "warn" : "ok";
    return "bad";
  }

  return {
    ready: false,
    remote: REMOTE,
    session: null,
    me: REMOTE ? "Guest" : ME.student,
    readIds: (() => {
      try {
        return JSON.parse(localStorage.getItem("xie-read") ?? "[]");
      } catch {
        return [];
      }
    })(),
    markRead: (ids) =>
      set((st) => {
        const readIds = [...new Set([...st.readIds, ...ids])].slice(-500);
        try {
          localStorage.setItem("xie-read", JSON.stringify(readIds));
        } catch {}
        return { readIds };
      }),
    engine: E.withDefaults({}),
    today: "",
    nowMin: DAY_START,
    date: "",
    time: DAY_START,
    floor: 1,
    role: "student",
    panel: "none",
    colorMode: "state",
    filters: { minCap: 0, tag: "", kind: "" },
    selected: null,
    flashes: {},
    toasts: [],
    chaos: emptyChaos,
    liveFeed: true,

    init() {
      const today = todayISO();
      const nowMin = nowMinutes();
      const time0 = Math.min(DAY_END - 15, Math.max(DAY_START, Math.floor(nowMin / 15) * 15));
      if (REMOTE) {
        if (get().ready || get().today) return;
        set({ today, nowMin, date: today, time: time0, liveFeed: false });
        const sb = browserClient();
        void sb.auth.getSession().then(({ data }) => applySession(data.session));
        sb.auth.onAuthStateChange((_e, session) => void applySession(session));
        void get().refresh().finally(() => set({ ready: true }));
        // Supabase Realtime: any booking/decision change anywhere recolours the map.
        sb.channel("live-map")
          .on("postgres_changes", { event: "*", schema: "public", table: "bookings" }, scheduleRefresh)
          .on("postgres_changes", { event: "INSERT", schema: "public", table: "conflict_events" }, scheduleRefresh)
          .on("postgres_changes", { event: "*", schema: "public", table: "engine_docs" }, scheduleRefresh)
          .subscribe();
        return;
      }
      let engine: E.EngineState | null = null;
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved.today === today) engine = E.withDefaults(saved.engine);
        }
      } catch {}
      engine ??= seedState(today, nowMin);
      try {
        const r = localStorage.getItem("xie-role") as Role | null;
        if (r && r in ME) set({ role: r, me: ME[r] });
      } catch {}
      const time = Math.min(DAY_END - 15, Math.max(DAY_START, Math.floor(nowMin / 15) * 15));
      set({ ready: true, engine, today, nowMin, date: today, time });
      save(engine, today);
      channel?.addEventListener("message", (e) => set({ engine: E.withDefaults(e.data.engine) }));
    },

    tick() {
      const nowMin = nowMinutes();
      set({ nowMin });
      if (REMOTE) {
        void exec({ type: "sweep" });
        return;
      }
      const n = mutate((s) => {
        const before = s.bookings.filter((b) => b.status === "no_show").length;
        runAction(s, { type: "sweep" }, { name: "system", role: "admin" }, ctxOf(get()));
        return s.bookings.filter((b) => b.status === "no_show").length - before;
      });
      if (n) get().toast({ title: "Ghost bookings released", body: `${n} room(s) freed after missed QR check-in.`, tone: "warn" });

      // Simulated realtime feed from other users (Skedda-style "@Alicia booked Desk 6").
      const st = get();
      if (st.liveFeed && !st.chaos.running && Math.random() < 0.5) {
        const r = Math.random;
        const room = BOOKABLE_ROOMS[Math.floor(r() * BOOKABLE_ROOMS.length)];
        const start = Math.max(Math.ceil(st.nowMin / 30) * 30, DAY_START) + Math.floor(r() * 6) * 30;
        if (start + 60 > DAY_END) return;
        const name = STUDENTS[Math.floor(r() * STUDENTS.length)];
        const res = mutate((s) =>
          E.bookResources(s, { roomIds: [room.id], date: st.today, start, end: start + 60, title: "Group Study", requester: name, role: room.kind === "tutorial" || room.kind === "study" ? "student" : "faculty", purpose: room.kind === "lab" ? "academic_class" : "casual", attendees: Math.min(room.capacity ?? 10, 8) }, ctxOf(st)),
        );
        if (res.ok) {
          flash(room.id ? [room.id] : [], "info");
          get().toast({ title: `@${name} booked ${room.short}`, body: `for ${fmt(start)} · floor ${room.floor}`, tone: "info" });
        }
      }
    },

    set: (p) => set(p),
    setRole: (role) => {
      if (REMOTE) return;
      set({ role, me: ME[role] });
      try {
        localStorage.setItem("xie-role", role);
      } catch {}
      get().toast({ title: `Signed in as ${ME[role]}`, body: `Role: ${role}. Rules, advance windows and approval tiers now apply as ${role}.`, tone: "info" });
    },
    setFilters: (f) => set((st) => ({ filters: { ...st.filters, ...f } })),
    toast: (t) => {
      const id = ++toastSeq;
      set((st) => ({ toasts: [{ ...t, id }, ...st.toasts].slice(0, 4) }));
      setTimeout(() => get().dismiss(id), 5200);
    },
    dismiss: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),

    async book(req) {
      const st = get();
      const { asAgent, ...rest } = req;
      const full: BookingRequest = { ...rest, requester: rest.requester ?? st.me, role: rest.role ?? st.role };
      let res: BookResult;
      if (REMOTE) {
        if (!st.session) return failed(full.roomIds, "Sign in to book rooms.");
        const out = await exec({ type: "book", req: full, asAgent });
        res = out.result ?? failed(full.roomIds, out.error ?? "Booking failed.");
      } else res = mutate((s) => E.bookResources(s, full, ctxOf(st)));
      flash(full.roomIds, toneOf(res));
      return res;
    },

    async act(kind, id, quiet) {
      const st = get();
      const ctx = ctxOf(st);
      const b = st.engine.bookings.find((x) => x.id === id);
      let text: string | undefined;
      if (REMOTE) {
        const out = await exec({ type: "act", kind, id });
        if (out.error) return get().toast({ title: "Not allowed", body: out.error, tone: "bad" });
        text = out.text;
      } else {
        mutate((s) => {
          if (kind === "approve") E.approve(s, id, st.me);
          if (kind === "reject") E.reject(s, id, st.me, "Not available for this purpose.", ctx);
          if (kind === "cancel") E.cancel(s, id, ctx);
          if (kind === "release") E.releaseEarly(s, id, ctx);
          if (kind === "checkin") E.checkIn(s, id);
          if (kind === "noshow") E.markNoShow(s, id, ctx);
          if (kind === "escalate") E.escalate(s, id);
        });
        text = get().engine.events[0]?.text;
      }
      if (b) flash(b.roomIds, kind === "approve" || kind === "checkin" ? "ok" : "warn");
      if (text && !quiet) get().toast({ title: kind === "checkin" ? "Checked in" : kind[0].toUpperCase() + kind.slice(1), body: text, tone: kind === "approve" || kind === "checkin" ? "ok" : "warn" });
    },

    async waitlist(req) {
      const st = get();
      if (REMOTE) {
        if (!st.session) return get().toast({ title: "Sign in first", body: "Sign in to join the waitlist.", tone: "warn" });
        const out = await exec({ type: "waitlist", req: { ...req, requester: st.me, role: st.role } });
        if (out.error) return get().toast({ title: "Waitlist failed", body: out.error, tone: "bad" });
      } else mutate((s) => E.joinWaitlist(s, { ...req, requester: st.me, role: st.role }));
      get().toast({ title: "Joined waitlist", body: "You'll be auto-promoted the moment this slot frees up.", tone: "info" });
    },

    async refresh() {
      if (!REMOTE) return;
      const res = await fetch("/api/engine", { cache: "no-store" }).catch(() => null);
      if (!res?.ok) {
        if (!get().ready) get().toast({ title: "Can't reach the database", body: "Check the Supabase env vars and that migrations ran (npm run db:setup).", tone: "bad" });
        return;
      }
      const next = E.withDefaults(await res.json());
      // Pulse rooms whose bookings changed elsewhere (other users, other tabs, chat channels).
      const prev = new Map(get().engine.bookings.map((b) => [b.id, b.status]));
      const changed = next.bookings.filter((b) => prev.size && prev.get(b.id) !== b.status).flatMap((b) => b.roomIds);
      set({ engine: next });
      if (changed.length) flash([...new Set(changed)], "info");
    },

    async dispatch(a, quiet) {
      const st = get();
      const actor = { name: st.me, role: st.role };
      let out: ActionOutput & { error?: string };
      if (REMOTE) {
        if (!st.session) out = { error: "Sign in first." };
        else {
          const r = await exec(a as Op);
          out = { result: r.result, message: r.message ?? r.text, error: r.error };
        }
      } else {
        try {
          out = mutate((s) => runAction(s, authorize(a, actor, s), actor, ctxOf(st)));
        } catch (e) {
          out = { error: e instanceof ActionError ? e.message : String(e) };
        }
      }
      if (!quiet && (out.error || out.message))
        get().toast({ title: out.error ? "Couldn't do that" : "Done", body: out.error ?? out.message!, tone: out.error ? "bad" : "ok" });
      return out;
    },

    async signIn(email, password) {
      const { error } = await browserClient().auth.signInWithPassword({ email, password });
      return error ? error.message : null;
    },

    async signOut() {
      await browserClient().auth.signOut();
    },

    async reset() {
      if (chaosTimer) clearInterval(chaosTimer);
      const st = get();
      if (REMOTE) {
        const res = await fetch("/api/admin/reset", { method: "POST", headers: { authorization: `Bearer ${st.session?.token ?? ""}` } });
        const out = await res.json();
        if (!res.ok) return get().toast({ title: "Reset failed", body: out.error, tone: "bad" });
        await get().refresh();
        set({ chaos: emptyChaos, flashes: {}, selected: null });
        return get().toast({ title: "Seed state restored", body: `Database reset in ${(out.ms / 1000).toFixed(1)} s.`, tone: "info" });
      }
      const engine = seedState(st.today, nowMinutes());
      set({ engine, chaos: emptyChaos, flashes: {}, selected: null });
      save(engine, st.today);
      get().toast({ title: "Seed state restored", body: "Campus reset to the seeded schedule.", tone: "info" });
    },

    runChaos() {
      if (get().chaos.running) return;
      const st = get();
      if (REMOTE && st.session?.role !== "admin")
        return get().toast({ title: "Admin only", body: "Sign in as admin@xie.demo to run Simulate Chaos against the live database.", tone: "warn" });
      set({ panel: "chaos", liveFeed: false, date: st.today, chaos: { ...emptyChaos, running: true } });
      const r = rng(Date.now() & 0xffff);
      const pickOne = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
      const base = Math.min(DAY_END - 180, Math.max(Math.ceil(st.nowMin / 30) * 30, DAY_START)) + 60;
      set({ time: base });
      const examBo = st.engine.blackouts[0];
      const purposes: Purpose[] = ["exam", "academic_class", "academic_class", "faculty_event", "club_event", "club_event", "casual"];
      const reqs: BookingRequest[] = Array.from({ length: 50 }, (_, i) => {
        const role = pickOne<Role>(["student", "student", "faculty", "faculty", "approver", "admin"]);
        const purpose = role === "student" ? pickOne<Purpose>(["club_event", "casual", "club_event"]) : pickOne(purposes);
        const hot = BOOKABLE_ROOMS.filter((x) => x.kind !== "outdoor");
        const room = pickOne(hot);
        const multi = i % 9 === 4;
        const blackout = i % 13 === 6 && examBo;
        const start = blackout ? examBo.start + 30 : base + (Math.floor(r() * 5) - 2) * 30;
        const dur = pickOne([60, 60, 90, 120]);
        const overCap = i % 11 === 3;
        const club = purpose === "club_event" ? pickOne(CLUBS) : undefined;
        return {
          roomIds: blackout ? [examBo.roomIds[0]] : multi ? ["F2-01", "F1-01"] : [room.id],
          date: blackout ? examBo.date : st.today,
          start,
          end: start + dur,
          title: purpose === "exam" ? "Exam: Unit Test" : purpose === "club_event" ? `${club} Workshop` : purpose === "academic_class" ? "Extra Lecture" : purpose === "faculty_event" ? "Faculty Meeting" : "Group Study",
          requester: role === "student" ? (club ? `${pickOne(STUDENTS)} (${club})` : pickOne(STUDENTS)) : role === "faculty" ? pickOne(FACULTY) : role === "admin" ? "Exam Cell" : "HOD Office",
          role,
          club,
          purpose,
          attendees: overCap ? (room.capacity ?? 20) + 25 : Math.max(5, Math.round((room.capacity ?? 20) * (0.3 + r() * 0.6))),
        };
      });

      let i = 0;
      let inFlight = 0;
      const finish = async () => {
        if (REMOTE) await get().refresh();
        const dbl = E.countDoubleBookings(get().engine);
        set((s0) => ({ chaos: { ...s0.chaos, running: false, doubleBookings: dbl } }));
        get().toast({ title: "Chaos resolved", body: `50 requests processed. Double bookings: ${dbl}.`, tone: dbl ? "bad" : "ok" });
      };
      chaosTimer = setInterval(async () => {
        const req = reqs[i++];
        if (!req) {
          clearInterval(chaosTimer!);
          const wait = setInterval(() => {
            if (inFlight) return;
            clearInterval(wait);
            void finish();
          }, 100);
          return;
        }
        const sent = i;
        inFlight++;
        const res = await get().book({ ...req, asAgent: true });
        inFlight--;
        if (res.ok && res.booking.status === "pending_approval" && r() < 0.3) await get().act("escalate", res.booking.id, true);
        const kind = res.event.kind;
        set((s0) => {
          const c = { ...s0.chaos, sent: Math.max(s0.chaos.sent, sent), doubleBookings: E.countDoubleBookings(s0.engine) };
          if (res.ok) {
            if (res.booking.status === "pending_approval") c.pending++;
            else c.confirmed++;
            if (res.bumped) {
              c.bumped++;
              c.conflicts++;
            }
            if (s0.engine.events.some((e) => e.kind === "escalated" && e.bookingId === res.booking.id)) c.escalated++;
          } else {
            if (res.code === "23P01") c.conflicts++;
            if (kind === "negotiate") c.negotiated++;
            else if (kind === "share") c.shared++;
            else c.rejected++;
          }
          return { chaos: c };
        });
      }, 200);
    },

    async optimise() {
      // Re-seat bumped bookings from this session. Uses the OR-Tools CP-SAT service (POST /api/solver → SOLVER_URL)
      // when configured; otherwise a greedy least-disruption pass.
      const st = get();
      const ctx = ctxOf(st);
      const util = (s: E.EngineState) => {
        const mins = s.bookings.filter((b) => b.date === st.today && HOLDING.includes(b.status)).reduce((m, b) => m + (b.end - b.start) * b.roomIds.length, 0);
        return Math.round((mins / (BOOKABLE_ROOMS.length * (DAY_END - DAY_START))) * 100);
      };
      const before = util(st.engine);
      const victims = st.engine.bookings.filter((b) => b.status === "bumped" && b.date === st.today && b.roomIds.length === 1);
      const slot = (m: number) => Math.floor((m - DAY_START) / 30);
      let moved = 0;
      let via: "CP-SAT" | "greedy" = "greedy";

      if (victims.length) {
        try {
          const blocked = st.engine.bookings
            .filter((b) => b.date === st.today && HOLDING.includes(b.status))
            .flatMap((b) => b.roomIds.flatMap((room) => Array.from({ length: Math.ceil((b.end - b.start) / 30) }, (_, k) => ({ room, slot: slot(b.start) + k }))));
          const minSlot = Math.max(0, slot(Math.ceil(st.nowMin / 30) * 30));
          const res = await fetch("/api/solver", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              rooms: BOOKABLE_ROOMS.filter((r) => r.kind !== "outdoor").map((r) => ({ id: r.id, type: r.kind, capacity: r.capacity ?? 0, floor: r.floor, tags: r.tags })),
              events: victims.map((b) => {
                const room = ROOM_BY_ID.get(b.roomIds[0])!;
                return {
                  id: b.id,
                  size: b.attendees,
                  duration_slots: Math.ceil((b.end - b.start) / 30),
                  room_types: [room.kind],
                  preferred_floor: room.floor,
                  current_room: room.id,
                  current_slot: slot(b.start),
                  allowed_slots: Array.from({ length: 24 - minSlot }, (_, k) => minSlot + k),
                };
              }),
              slots: 24,
              blocked,
            }),
          });
          if (res.ok) {
            const out: { assignments: { event_id: string; room: string; slot: number }[] } = await res.json();
            via = "CP-SAT";
            for (const a of out.assignments) {
              const src = victims.find((b) => b.id === a.event_id);
              if (!src) continue;
              const start = DAY_START + a.slot * 30;
              if ((await get().book({ ...reqOf(src), roomIds: [a.room], start, end: start + (src.end - src.start), asAgent: true })).ok) moved++;
            }
          }
        } catch {}
        if (via === "greedy")
          for (const src of victims) {
            const alt = E.alternatives(get().engine, src, ctx, 1)[0];
            if (alt && (await get().book({ ...reqOf(src), roomIds: [alt.roomId], date: alt.date, start: alt.start, end: alt.end, asAgent: true })).ok) moved++;
          }
      }
      set((s0) => ({ chaos: { ...s0.chaos, optimised: { before, after: util(get().engine), moved, via } } }));
    },
  };
});

const reqOf = (b: E.EngineState["bookings"][number]): BookingRequest => ({
  roomIds: b.roomIds,
  date: b.date,
  start: b.start,
  end: b.end,
  title: b.title,
  requester: b.requester,
  role: b.role,
  club: b.club,
  purpose: b.purpose,
  attendees: b.attendees,
});

function fmt(min: number) {
  const h = Math.floor(min / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(min % 60).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

export const roomName = (id: string) => ROOM_BY_ID.get(id)?.name ?? id;

/** Notices addressed to me, to everyone, or to my role (admins also see approver traffic). */
export function myNotices(s: Pick<State, "engine" | "me" | "role">) {
  const roles = s.role === "admin" ? ["role:admin", "role:approver"] : [`role:${s.role}`];
  return s.engine.notices.filter((n) => n.to === s.me || n.to === "*" || roles.includes(n.to));
}
export { addDays };
