"use client";

import { useEffect, useMemo, useState } from "react";
import { BOOKABLE_ROOMS, FLOORS, ROOM_BY_ID } from "@/data/campus";
import { alternatives, PURPOSE_LABEL, type Notice } from "@/lib/engine";
import { fmtDate, fmtTime, parse24 } from "@/lib/time";
import { HOLDING, type Booking, type Purpose, type Role } from "@/lib/types";
import { myNotices, roomName, useStore } from "@/store/useStore";

const H3 = ({ children }: { children: React.ReactNode }) => <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">{children}</h3>;
const Btn = ({ onClick, children, tone = "plain", disabled }: { onClick: () => void; children: React.ReactNode; tone?: "plain" | "ok" | "bad" | "blue"; disabled?: boolean }) => (
  <button
    disabled={disabled}
    onClick={onClick}
    className={`rounded-md px-2.5 py-1 text-xs font-medium disabled:opacity-50 ${tone === "ok" ? "bg-free text-white" : tone === "bad" ? "bg-busy text-white" : tone === "blue" ? "bg-inuse text-white" : "border border-[var(--line)] hover:bg-black/5"}`}
  >
    {children}
  </button>
);

const ICON: Record<Notice["kind"], string> = { bump: "↻", approval: "✓", negotiation: "💬", swap: "⇄", free: "◎", counter: "↔", info: "i" };

// ---------------------------------------------------------------- notifications

export function useUnread() {
  const engine = useStore((s) => s.engine);
  const me = useStore((s) => s.me);
  const role = useStore((s) => s.role);
  const readIds = useStore((s) => s.readIds);
  return useMemo(() => myNotices({ engine, me, role }).filter((n) => !readIds.includes(n.id)).length, [engine, me, role, readIds]);
}

export function Notifications() {
  const engine = useStore((s) => s.engine);
  const me = useStore((s) => s.me);
  const role = useStore((s) => s.role);
  const markRead = useStore((s) => s.markRead);
  const dispatch = useStore((s) => s.dispatch);
  const book = useStore((s) => s.book);
  const set = useStore((s) => s.set);
  const toast = useStore((s) => s.toast);
  const list = useMemo(() => myNotices({ engine, me, role }).slice(0, 60), [engine, me, role]);
  useEffect(() => {
    const t = setTimeout(() => markRead(list.map((n) => n.id)), 1500);
    return () => clearTimeout(t);
  }, [list, markRead]);

  if (!list.length) return <p className="text-sm text-muted">No notifications yet. Bumps, approvals, negotiations, swaps and free-room alerts land here.</p>;
  return (
    <ul className="space-y-2">
      {list.map((n) => {
        const counter = n.kind === "counter" ? engine.counters.find((c) => c.id === n.ref && c.status === "open") : undefined;
        const bumped = n.kind === "bump" || (n.kind === "approval" && n.alts?.length) ? engine.bookings.find((b) => b.id === n.ref) : undefined;
        return (
          <li key={n.id} className="rounded-lg border border-[var(--line)] p-3 text-xs">
            <div className="flex gap-2">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-black/5">{ICON[n.kind]}</span>
              <div className="min-w-0 flex-1">
                <p className="leading-relaxed">{n.text}</p>
                <p className="mt-0.5 font-mono text-[10px] text-muted">{new Date(n.at).toLocaleTimeString("en-IN", { hour12: false })}</p>
              </div>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 pl-8">
              {n.alts?.map((a, i) => (
                <Btn
                  key={i}
                  onClick={async () => {
                    const r = await book({ roomIds: [a.roomId], date: a.date, start: a.start, end: a.end, title: bumped?.title ?? "Rebooked", purpose: bumped?.purpose ?? "casual", attendees: bumped?.attendees ?? 4 });
                    toast({ title: r.ok ? "Rebooked" : "Couldn't rebook", body: r.event.text, tone: r.ok ? "ok" : "bad" });
                  }}
                >
                  {ROOM_BY_ID.get(a.roomId)?.short} {fmtTime(a.start)}
                </Btn>
              ))}
              {counter && (
                <>
                  <Btn tone="ok" onClick={() => dispatch({ type: "counter_reply", bookingId: counter.id, accept: true })}>
                    Accept {ROOM_BY_ID.get(counter.roomId)?.short} {fmtTime(counter.start)}
                  </Btn>
                  <Btn onClick={() => dispatch({ type: "counter_reply", bookingId: counter.id, accept: false })}>Decline</Btn>
                </>
              )}
              {n.kind === "free" && n.free && !n.free.claimedBy && n.free.date === useStore.getState().today && (
                <Btn tone="blue" onClick={() => dispatch({ type: "claim_free", noticeId: n.id })}>
                  Claim it (+5)
                </Btn>
              )}
              {n.kind === "negotiation" && <Btn onClick={() => set({ panel: "conflicts" })}>Open thread</Btn>}
              {n.kind === "swap" && n.to === "*" && <Btn onClick={() => set({ panel: "swaps" })}>View marketplace</Btn>}
              {n.kind === "approval" && n.to.startsWith("role:") && <Btn onClick={() => set({ panel: "approvals" })}>Review</Btn>}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------- swap marketplace

export function Swaps() {
  const engine = useStore((s) => s.engine);
  const me = useStore((s) => s.me);
  const dispatch = useStore((s) => s.dispatch);
  const listed = engine.swaps.filter((w) => w.status === "listed");
  const byId = new Map(engine.bookings.map((b) => [b.id, b]));
  const done = engine.swaps.filter((w) => w.status === "claimed").slice(0, 8);
  return (
    <div className="space-y-5 text-xs">
      <p className="text-muted">Can&apos;t use a slot? List it here instead of cancelling. Anyone eligible can claim it atomically, and the hand-over is protected by the same no-double-booking guarantee. Listing earns you +5 when it&apos;s claimed.</p>
      <section>
        <H3>Available slots ({listed.length})</H3>
        {!listed.length && <p className="text-muted">Nothing listed. Use &quot;List for swap&quot; in My bookings.</p>}
        <ul className="space-y-2">
          {listed.map((w) => {
            const b = byId.get(w.bookingId);
            if (!b || !HOLDING.includes(b.status)) return null;
            return (
              <li key={w.id} className="flex items-center gap-2 rounded-lg border border-[var(--line)] p-3">
                <div className="min-w-0 flex-1">
                  <b className="text-sm">{b.roomIds.map(roomName).join(" + ")}</b>
                  <div className="text-muted">
                    {fmtDate(b.date, { weekday: "short", day: "numeric", month: "short" })} · {fmtTime(b.start)}–{fmtTime(b.end)} · from {w.owner}
                  </div>
                </div>
                {w.owner === me ? <Btn onClick={() => dispatch({ type: "swap_withdraw", id: w.id })}>Withdraw</Btn> : <Btn tone="ok" onClick={() => dispatch({ type: "swap_claim", id: w.id })}>Claim</Btn>}
              </li>
            );
          })}
        </ul>
      </section>
      {done.length > 0 && (
        <section>
          <H3>Recent hand-overs</H3>
          <ul className="space-y-1 text-muted">
            {done.map((w) => (
              <li key={w.id}>
                {w.owner} → {w.claimedBy} · {roomName(byId.get(w.bookingId)?.roomIds[0] ?? "")}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- negotiation threads

export function Negotiations() {
  const engine = useStore((s) => s.engine);
  const me = useStore((s) => s.me);
  const role = useStore((s) => s.role);
  const dispatch = useStore((s) => s.dispatch);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const mine = engine.negotiations.filter((n) => role === "admin" || n.holder === me || n.requester === me).slice(0, 12);
  if (!mine.length) return <p className="text-xs text-muted">No negotiations involving you. They open automatically when two requests are within 15 priority points.</p>;
  return (
    <ul className="space-y-3">
      {mine.map((n) => (
        <li key={n.id} className="rounded-lg border border-[var(--line)] p-3 text-xs">
          <div className="mb-2 flex items-center justify-between">
            <b>
              {n.requester} ↔ {n.holder}
            </b>
            <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${n.status === "open" ? "bg-pending/15 text-pending" : n.status === "accepted" ? "bg-free/15 text-free" : "bg-busy/15 text-busy"}`}>{n.status}</span>
          </div>
          <div className="mb-2 text-muted">
            {n.req.roomIds.map(roomName).join(" + ")} · {fmtTime(n.req.start)}–{fmtTime(n.req.end)} · {PURPOSE_LABEL[n.req.purpose]}
          </div>
          <ol className="space-y-1.5">
            {n.messages.map((m, i) => (
              <li key={i} className={`max-w-[85%] rounded-lg px-2.5 py-1.5 ${m.from === me ? "ml-auto bg-brand text-white" : "bg-black/5"}`}>
                <div className="text-[10px] opacity-70">{m.from}</div>
                {m.text}
              </li>
            ))}
          </ol>
          {n.status === "open" && (
            <div className="mt-2 space-y-2">
              {(n.holder === me || role === "admin") && (
                <div className="flex gap-1.5">
                  <Btn tone="ok" onClick={() => dispatch({ type: "neg_reply", id: n.id, accept: true })}>
                    Accept (+15)
                  </Btn>
                  <Btn tone="bad" onClick={() => dispatch({ type: "neg_reply", id: n.id, accept: false })}>
                    Decline
                  </Btn>
                </div>
              )}
              {(n.holder === me || n.requester === me || role === "admin") && (
                <form
                  className="flex gap-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const text = draft[n.id]?.trim();
                    if (!text) return;
                    void dispatch({ type: "neg_msg", id: n.id, text }, true);
                    setDraft((d) => ({ ...d, [n.id]: "" }));
                  }}
                >
                  <input value={draft[n.id] ?? ""} onChange={(e) => setDraft((d) => ({ ...d, [n.id]: e.target.value }))} placeholder="Reply…" className="min-w-0 flex-1 rounded-md border border-[var(--line)] bg-transparent px-2 py-1" aria-label="Negotiation message" />
                  <Btn onClick={() => {}}>Send</Btn>
                </form>
              )}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------- approver counter-proposal

export function CounterPicker({ b }: { b: Booking }) {
  const engine = useStore((s) => s.engine);
  const today = useStore((s) => s.today);
  const nowMin = useStore((s) => s.nowMin);
  const dispatch = useStore((s) => s.dispatch);
  const [open, setOpen] = useState(false);
  const existing = engine.counters.find((c) => c.id === b.id && c.status === "open");
  if (existing) return <span className="text-[11px] text-inuse">Counter-offer sent: {roomName(existing.roomId)} {fmtTime(existing.start)}</span>;
  if (!open) return <Btn onClick={() => setOpen(true)}>Counter-propose</Btn>;
  const alts = alternatives({ ...engine, bookings: engine.bookings.filter((x) => x.id !== b.id) }, b, { today, nowMin }, 3).filter((a) => !(a.roomId === b.roomIds[0] && a.start === b.start));
  return (
    <div className="w-full space-y-1">
      {alts.map((a, i) => (
        <button key={i} onClick={() => dispatch({ type: "counter", bookingId: b.id, roomId: a.roomId, start: a.start, end: a.end })} className="block w-full rounded border border-[var(--line)] px-2 py-1 text-left hover:border-brand">
          Offer <b>{roomName(a.roomId)}</b> {fmtTime(a.start)}–{fmtTime(a.end)} <span className="text-muted">· {a.reason}</span>
        </button>
      ))}
      {!alts.length && <span className="text-muted">No alternatives free.</span>}
    </div>
  );
}

// ---------------------------------------------------------------- gamification

export function Badges() {
  const engine = useStore((s) => s.engine);
  const me = useStore((s) => s.me);
  const mine = engine.bookings.filter((b) => b.requester === me);
  const pts = engine.points[me] ?? 0;
  const badges = [
    { on: mine.filter((b) => b.checkedIn).length >= 1, icon: "⏱", label: "On time", hint: "Checked in via QR" },
    { on: engine.events.some((e) => e.kind === "released" && e.text.startsWith(me) && e.text.includes("early")), icon: "🌱", label: "Early releaser", hint: "Released a room early" },
    { on: engine.negotiations.some((n) => n.holder === me && n.status === "accepted"), icon: "🤝", label: "Good sport", hint: "Accepted a reschedule" },
    { on: engine.swaps.some((w) => w.owner === me && w.status === "claimed"), icon: "⇄", label: "Swapper", hint: "Handed a slot to someone" },
    { on: mine.filter((b) => b.status === "no_show").length === 0 && mine.length >= 3, icon: "★", label: "Reliable", hint: "3+ bookings, no no-shows" },
  ];
  return (
    <div className="rounded-lg bg-black/[.03] p-3">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-widest text-muted">Points</span>
        <b className="font-display text-2xl">{pts}</b>
      </div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {badges.map((b) => (
          <span key={b.label} title={b.hint} className={`rounded-full border px-2 py-0.5 text-[11px] ${b.on ? "border-free bg-free/10 text-free" : "border-[var(--line)] text-muted opacity-60"}`}>
            {b.icon} {b.label}
          </span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- admin tools

const SCOPES: Record<string, () => string[]> = {
  "Floor 2 lecture halls + Seminar Hall": () => FLOORS[2].filter((r) => r.kind === "lh" || r.kind === "seminar").map((r) => r.id),
  "All labs": () => BOOKABLE_ROOMS.filter((r) => r.kind === "lab").map((r) => r.id),
  "All lecture halls": () => BOOKABLE_ROOMS.filter((r) => r.kind === "lh").map((r) => r.id),
  "Whole campus": () => BOOKABLE_ROOMS.map((r) => r.id),
};

export function AdminTools() {
  const engine = useStore((s) => s.engine);
  const today = useStore((s) => s.today);
  const role = useStore((s) => s.role);
  const remote = useStore((s) => s.remote);
  const dispatch = useStore((s) => s.dispatch);
  const [form, setForm] = useState({ label: "Exam blackout", date: today, start: "09:00", end: "13:00", scope: Object.keys(SCOPES)[0], examOnly: true });
  const [room, setRoom] = useState(BOOKABLE_ROOMS[0].id);
  if (role !== "admin" && role !== "approver") return <p className="text-xs text-muted">Admin tools need the approver or admin role.</p>;
  return (
    <div className="space-y-5 text-xs">
      <section>
        <H3>Rules editor · blackouts</H3>
        <ul className="mb-2 space-y-1">
          {engine.blackouts.map((b) => (
            <li key={b.id} className="flex items-center gap-2 rounded border border-[var(--line)] px-2 py-1.5">
              <span className="min-w-0 flex-1">
                <b>{b.label}</b> · {fmtDate(b.date, { day: "numeric", month: "short" })} {fmtTime(b.start)}–{fmtTime(b.end)} · {b.roomIds.length} rooms · allows {b.allow.map((p) => PURPOSE_LABEL[p]).join(", ") || "nothing"}
              </span>
              <Btn tone="bad" onClick={() => dispatch({ type: "blackout_remove", id: b.id })}>
                Remove
              </Btn>
            </li>
          ))}
        </ul>
        <form
          className="grid grid-cols-2 gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            void dispatch({ type: "blackout_add", blackout: { label: form.label, date: form.date, start: parse24(form.start), end: parse24(form.end), roomIds: SCOPES[form.scope](), allow: form.examOnly ? (["exam"] as Purpose[]) : [] } });
          }}
        >
          <input className="col-span-2 rounded border border-[var(--line)] bg-transparent px-2 py-1" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} aria-label="Label" />
          <input type="date" className="rounded border border-[var(--line)] bg-transparent px-2 py-1" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} aria-label="Date" />
          <select className="rounded border border-[var(--line)] bg-transparent px-2 py-1" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} aria-label="Rooms">
            {Object.keys(SCOPES).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          <input type="time" className="rounded border border-[var(--line)] bg-transparent px-2 py-1" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} aria-label="From" />
          <input type="time" className="rounded border border-[var(--line)] bg-transparent px-2 py-1" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} aria-label="To" />
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={form.examOnly} onChange={(e) => setForm({ ...form, examOnly: e.target.checked })} /> Exams still allowed
          </label>
          <button className="rounded bg-brand py-1 font-semibold text-white">Add blackout</button>
        </form>
      </section>

      <section>
        <H3>Live occupancy</H3>
        <p className="mb-2 text-muted">Sensors POST to <code className="font-mono">/api/occupancy</code>. The simulator fakes Wi-Fi density: checked-in rooms busy, some ghosts empty, some free rooms occupied (purple squatter flag on the map).</p>
        <Btn tone="blue" disabled={role !== "admin"} onClick={() => dispatch({ type: "occupancy_sim" }, true)}>
          Run occupancy simulator
        </Btn>
      </section>

      <section>
        <H3>QR check-in</H3>
        <div className="flex flex-wrap items-center gap-1.5">
          <a href="/admin/qr" target="_blank" className="rounded-md border border-[var(--line)] px-2.5 py-1 font-medium hover:bg-black/5">
            Print QR sheet ↗
          </a>
          <select value={room} onChange={(e) => setRoom(e.target.value)} className="rounded border border-[var(--line)] bg-transparent px-2 py-1" aria-label="Room for door display">
            {BOOKABLE_ROOMS.map((r) => (
              <option key={r.id} value={r.id}>
                {r.id} {r.short}
              </option>
            ))}
          </select>
          <a href={`/display/${room}`} target="_blank" className="rounded-md border border-[var(--line)] px-2.5 py-1 font-medium hover:bg-black/5">
            Open door display ↗
          </a>
        </div>
      </section>

      {remote && role === "admin" && <RoleAssignment />}
    </div>
  );
}

function RoleAssignment() {
  const token = useStore((s) => s.session?.token);
  const toast = useStore((s) => s.toast);
  const [users, setUsers] = useState<{ id: string; email: string; full_name: string; role: Role }[] | null>(null);
  const load = () =>
    fetch("/api/admin/users", { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((d) => setUsers(d.users ?? []));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <section>
      <H3>Role assignment</H3>
      {!users && <p className="text-muted">Loading…</p>}
      <ul className="space-y-1">
        {users?.map((u) => (
          <li key={u.id} className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate">
              {u.full_name} <span className="text-muted">{u.email}</span>
            </span>
            <select
              value={u.role}
              onChange={async (e) => {
                const res = await fetch("/api/admin/users", { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ id: u.id, role: e.target.value }) });
                const d = await res.json();
                toast({ title: res.ok ? "Role updated" : "Couldn't update", body: res.ok ? `${u.full_name} is now ${e.target.value}` : d.error, tone: res.ok ? "ok" : "bad" });
                void load();
              }}
              className="rounded border border-[var(--line)] bg-transparent px-1.5 py-0.5"
              aria-label={`Role for ${u.full_name}`}
            >
              {["student", "faculty", "approver", "admin"].map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </li>
        ))}
      </ul>
    </section>
  );
}
