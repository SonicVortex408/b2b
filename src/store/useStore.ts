"use client";

import { create } from "zustand";
import { BOOKABLE_ROOMS, ROOM_BY_ID } from "@/data/campus";
import * as E from "@/lib/engine";
import { CLUBS, FACULTY, rng, seedState, STUDENTS } from "@/lib/seed";
import { addDays, DAY_END, DAY_START, nowMinutes, todayISO } from "@/lib/time";
import { HOLDING, type BookingRequest, type BookResult, type Purpose, type Role } from "@/lib/types";

export type Panel = "none" | "bookings" | "approvals" | "conflicts" | "chaos" | "admin";
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

interface State {
  ready: boolean;
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
  book: (req: Omit<BookingRequest, "requester" | "role"> & { requester?: string; role?: Role }) => BookResult;
  act: (kind: "approve" | "reject" | "cancel" | "release" | "checkin" | "noshow" | "escalate", id: string) => void;
  waitlist: (req: Omit<BookingRequest, "requester" | "role">) => void;
  reset: () => void;
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

  function toneOf(r: BookResult): Toast["tone"] {
    if (r.ok) return r.bumped ? "warn" : r.booking.status === "pending_approval" ? "warn" : "ok";
    return "bad";
  }

  return {
    ready: false,
    engine: { bookings: [], events: [], bumps: {}, waitlist: [], blackouts: [], points: {}, seq: 0 },
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
      let engine: E.EngineState | null = null;
      try {
        const raw = localStorage.getItem(KEY);
        if (raw) {
          const saved = JSON.parse(raw);
          if (saved.today === today) engine = saved.engine;
        }
      } catch {}
      engine ??= seedState(today, nowMin);
      const time = Math.min(DAY_END - 15, Math.max(DAY_START, Math.floor(nowMin / 15) * 15));
      set({ ready: true, engine, today, nowMin, date: today, time });
      save(engine, today);
      channel?.addEventListener("message", (e) => set({ engine: e.data.engine }));
    },

    tick() {
      const nowMin = nowMinutes();
      set({ nowMin });
      const n = mutate((s) => E.sweepNoShows(s, ctxOf(get())));
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
      set({ role });
      get().toast({ title: `Signed in as ${ME[role]}`, body: `Role: ${role}. Rules, advance windows and approval tiers now apply as ${role}.`, tone: "info" });
    },
    setFilters: (f) => set((st) => ({ filters: { ...st.filters, ...f } })),
    toast: (t) => {
      const id = ++toastSeq;
      set((st) => ({ toasts: [{ ...t, id }, ...st.toasts].slice(0, 4) }));
      setTimeout(() => get().dismiss(id), 5200);
    },
    dismiss: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),

    book(req) {
      const st = get();
      const full: BookingRequest = { ...req, requester: req.requester ?? ME[st.role], role: req.role ?? st.role };
      const res = mutate((s) => E.bookResources(s, full, ctxOf(st)));
      flash(full.roomIds, toneOf(res));
      return res;
    },

    act(kind, id) {
      const st = get();
      const ctx = ctxOf(st);
      const b = st.engine.bookings.find((x) => x.id === id);
      mutate((s) => {
        if (kind === "approve") E.approve(s, id, ME[st.role]);
        if (kind === "reject") E.reject(s, id, ME[st.role], "Not available for this purpose.", ctx);
        if (kind === "cancel") E.cancel(s, id, ctx);
        if (kind === "release") E.releaseEarly(s, id, ctx);
        if (kind === "checkin") E.checkIn(s, id);
        if (kind === "noshow") E.markNoShow(s, id, ctx);
        if (kind === "escalate") E.escalate(s, id);
      });
      if (b) flash(b.roomIds, kind === "approve" || kind === "checkin" ? "ok" : "warn");
      const ev = get().engine.events[0];
      if (ev) get().toast({ title: kind === "checkin" ? "Checked in" : kind[0].toUpperCase() + kind.slice(1), body: ev.text, tone: kind === "approve" || kind === "checkin" ? "ok" : "warn" });
    },

    waitlist(req) {
      const st = get();
      mutate((s) => E.joinWaitlist(s, { ...req, requester: ME[st.role], role: st.role }));
      get().toast({ title: "Joined waitlist", body: "You'll be auto-promoted the moment this slot frees up.", tone: "info" });
    },

    reset() {
      if (chaosTimer) clearInterval(chaosTimer);
      const st = get();
      const engine = seedState(st.today, nowMinutes());
      set({ engine, chaos: emptyChaos, flashes: {}, selected: null });
      save(engine, st.today);
      get().toast({ title: "Seed state restored", body: "Campus reset to the seeded schedule.", tone: "info" });
    },

    runChaos() {
      if (get().chaos.running) return;
      const st = get();
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
      chaosTimer = setInterval(() => {
        const req = reqs[i++];
        if (!req) {
          clearInterval(chaosTimer!);
          const dbl = E.countDoubleBookings(get().engine);
          set((s0) => ({ chaos: { ...s0.chaos, running: false, doubleBookings: dbl } }));
          get().toast({ title: "Chaos resolved", body: `50 requests processed. Double bookings: ${dbl}.`, tone: dbl ? "bad" : "ok" });
          return;
        }
        const ctx = ctxOf(get());
        const res = mutate((s) => {
          const out = E.bookResources(s, req, ctx);
          if (out.ok && out.booking.status === "pending_approval" && r() < 0.3) E.escalate(s, out.booking.id);
          return out;
        });
        flash(req.roomIds, toneOf(res));
        const kind = res.event.kind;
        set((s0) => {
          const c = { ...s0.chaos, sent: i, doubleBookings: E.countDoubleBookings(s0.engine) };
          if (res.ok) {
            if (res.booking.status === "pending_approval") c.pending++;
            else c.confirmed++;
            if (res.bumped) {
              c.bumped++;
              c.conflicts++;
            }
            if (s0.engine.events[0]?.kind === "escalated") c.escalated++;
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
            mutate((s) => {
              for (const a of out.assignments) {
                const src = s.bookings.find((b) => b.id === a.event_id);
                if (!src) continue;
                const start = DAY_START + a.slot * 30;
                const r = E.bookResources(s, { ...src, roomIds: [a.room], start, end: start + (src.end - src.start) }, ctx);
                if (r.ok) moved++;
              }
            });
          }
        } catch {}
        if (via === "greedy")
          mutate((s) => {
            for (const v of victims) {
              const src = s.bookings.find((b) => b.id === v.id);
              const alt = src && E.alternatives(s, src, ctx, 1)[0];
              if (!src || !alt) continue;
              if (E.bookResources(s, { ...src, roomIds: [alt.roomId], date: alt.date, start: alt.start, end: alt.end }, ctx).ok) moved++;
            }
          });
      }
      set((s0) => ({ chaos: { ...s0.chaos, optimised: { before, after: util(get().engine), moved, via } } }));
    },
  };
});

function fmt(min: number) {
  const h = Math.floor(min / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(min % 60).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
}

export const roomName = (id: string) => ROOM_BY_ID.get(id)?.name ?? id;
export { addDays };
