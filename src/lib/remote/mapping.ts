/**
 * Mapping between the engine's in-memory model (date + minutes, Asia/Kolkata) and Postgres rows
 * (timestamptz, one row per resource). Also computes the diff an engine operation produced, which
 * apply_engine_changes() persists atomically.
 */
import { withDefaults, type Blackout, type EngineState, type WaitEntry } from "@/lib/engine";
import { pad } from "@/lib/time";
import type { Booking, BookingStatus, DecisionEvent, Purpose, Role, ScoreBreakdown } from "@/lib/types";

const IST_OFFSET_MIN = 330; // Asia/Kolkata has no DST

export const toTs = (date: string, min: number) => `${date}T${pad(Math.floor(min / 60))}:${pad(min % 60)}:00+05:30`;

export function fromTs(ts: string): { date: string; min: number } {
  const d = new Date(new Date(ts).getTime() + IST_OFFSET_MIN * 60000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

export interface BookingRow {
  id: string;
  resource_id: string;
  requester_id: string | null;
  requester_name: string;
  requester_role: Role;
  club: string | null;
  starts_at: string;
  ends_at: string;
  title: string;
  purpose: Purpose;
  priority_score: number;
  status: BookingStatus;
  attendee_count: number;
  checked_in: boolean;
  occupancy: number;
  created_at: string;
}

export interface EventRow {
  id: string;
  at: string;
  kind: DecisionEvent["kind"];
  resource_ids: string[];
  booking_id: string | null;
  loser_booking_id: string | null;
  winner_score: ScoreBreakdown | null;
  loser_score: ScoreBreakdown | null;
  explanation: string;
}

export interface LedgerRow {
  subject: string;
  bumps_suffered: number;
  points: number;
}

export interface WaitRow {
  id: string;
  resource_ids: string[];
  requester_name: string;
  requester_role: Role;
  club: string | null;
  starts_at: string;
  ends_at: string;
  title: string;
  purpose: Purpose;
  attendee_count: number;
  created_at: string;
}

export interface BlackoutRow {
  id: string;
  label: string;
  starts_at: string;
  ends_at: string;
  resource_ids: string[];
  allow: Purpose[];
}

/** Negotiations, swaps, counters, holds, notices and occupancy live in one generic table. */
export type DocKind = "neg" | "swap" | "counter" | "hold" | "notice" | "occ";
export interface DocRow {
  kind: DocKind;
  id: string;
  data: unknown;
}

export interface Rows {
  bookings: BookingRow[];
  events: EventRow[];
  ledger: LedgerRow[];
  waitlist: WaitRow[];
  blackouts: BlackoutRow[];
  docs?: DocRow[];
}

type DocState = Pick<EngineState, "negotiations" | "swaps" | "counters" | "holds" | "notices" | "occupancy">;

function docsOf(s: DocState): DocRow[] {
  return [
    ...s.negotiations.map((d) => ({ kind: "neg" as const, id: d.id, data: d })),
    ...s.swaps.map((d) => ({ kind: "swap" as const, id: d.id, data: d })),
    ...s.counters.map((d) => ({ kind: "counter" as const, id: d.id, data: d })),
    ...s.holds.map((d) => ({ kind: "hold" as const, id: d.id, data: d })),
    ...s.notices.map((d) => ({ kind: "notice" as const, id: d.id, data: d })),
    ...Object.entries(s.occupancy).map(([id, d]) => ({ kind: "occ" as const, id, data: d })),
  ];
}

function stateFromDocs(docs: DocRow[]): DocState {
  const by = <T,>(k: DocKind) => docs.filter((d) => d.kind === k).map((d) => d.data as T);
  const sortAt = <T extends { at: number }>(xs: T[]) => xs.sort((a, b) => b.at - a.at);
  return {
    negotiations: sortAt(by("neg")),
    swaps: sortAt(by("swap")),
    counters: sortAt(by("counter")),
    holds: by("hold"),
    notices: sortAt(by("notice")),
    occupancy: Object.fromEntries(docs.filter((d) => d.kind === "occ").map((d) => [d.id, d.data])) as EngineState["occupancy"],
  };
}

export function rowsToState(rows: Rows): EngineState {
  const byId = new Map<string, Booking>();
  for (const r of rows.bookings) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.roomIds.push(r.resource_id);
      continue;
    }
    const s = fromTs(r.starts_at);
    const e = fromTs(r.ends_at);
    byId.set(r.id, {
      id: r.id,
      roomIds: [r.resource_id],
      date: s.date,
      start: s.min,
      end: e.date === s.date ? e.min : 24 * 60,
      title: r.title,
      requester: r.requester_name,
      role: r.requester_role,
      club: r.club ?? undefined,
      purpose: r.purpose,
      attendees: r.attendee_count,
      status: r.status,
      priority: r.priority_score,
      createdAt: new Date(r.created_at).getTime(),
      checkedIn: r.checked_in,
      occupancy: r.occupancy,
    });
  }
  const bumps: Record<string, number> = {};
  const points: Record<string, number> = {};
  for (const l of rows.ledger) {
    if (l.bumps_suffered) bumps[l.subject] = l.bumps_suffered;
    if (l.points) points[l.subject] = l.points;
  }
  return withDefaults({
    ...stateFromDocs(rows.docs ?? []),
    bookings: [...byId.values()].map((b) => ({ ...b, roomIds: b.roomIds.sort() })),
    events: rows.events
      .map((e) => ({
        id: e.id,
        at: new Date(e.at).getTime(),
        kind: e.kind,
        roomIds: e.resource_ids,
        bookingId: e.booking_id ?? undefined,
        loserId: e.loser_booking_id ?? undefined,
        winnerScore: e.winner_score ?? undefined,
        loserScore: e.loser_score ?? undefined,
        text: e.explanation,
      }))
      .sort((a, b) => b.at - a.at),
    bumps,
    points,
    waitlist: rows.waitlist.map((w): WaitEntry => {
      const s = fromTs(w.starts_at);
      return {
        id: w.id,
        roomIds: w.resource_ids,
        date: s.date,
        start: s.min,
        end: fromTs(w.ends_at).min,
        title: w.title,
        requester: w.requester_name,
        role: w.requester_role,
        club: w.club ?? undefined,
        purpose: w.purpose,
        attendees: w.attendee_count,
        at: new Date(w.created_at).getTime(),
      };
    }),
    blackouts: rows.blackouts.map((b): Blackout => {
      const s = fromTs(b.starts_at);
      return { id: b.id, label: b.label, date: s.date, start: s.min, end: fromTs(b.ends_at).min, roomIds: b.resource_ids, allow: b.allow };
    }),
    // Random high seq so ids minted by concurrent server invocations don't collide.
    seq: Math.floor(Math.random() * 36 ** 6) * 36 ** 3 + (Date.now() % 36 ** 3),
  });
}

export interface Changes {
  actor: string;
  updates: { id: string; status?: BookingStatus; starts_at?: string; ends_at?: string; checked_in?: boolean; occupancy?: number }[];
  inserts: {
    id: string;
    resource_ids: string[];
    requester_id?: string;
    requester_name: string;
    requester_role: Role;
    club?: string;
    starts_at: string;
    ends_at: string;
    title: string;
    purpose: Purpose;
    priority: number;
    status: BookingStatus;
    attendees: number;
  }[];
  events: DecisionEvent[];
  ledger: { subject: string; bumps: number; points: number }[];
  waitlist_add: { id: string; resource_ids: string[]; requester_name: string; requester_role: Role; club?: string; starts_at: string; ends_at: string; title: string; purpose: Purpose; attendees: number }[];
  waitlist_remove: string[];
  docs_upsert?: DocRow[];
  docs_remove?: { kind: DocKind; id: string }[];
  blackouts_upsert?: BlackoutRow[];
  blackouts_remove?: string[];
}

export const isEmpty = (c: Changes) =>
  !c.updates.length && !c.inserts.length && !c.events.length && !c.ledger.length && !c.waitlist_add.length && !c.waitlist_remove.length &&
  !c.docs_upsert?.length && !c.docs_remove?.length && !c.blackouts_upsert?.length && !c.blackouts_remove?.length;

/** What an engine operation changed, in the shape apply_engine_changes() expects. */
export function diff(before: EngineState, after: EngineState, actor: string, requesterId?: string): Changes {
  const prev = new Map(before.bookings.map((b) => [b.id, b]));
  const updates: Changes["updates"] = [];
  const inserts: Changes["inserts"] = [];
  for (const b of after.bookings) {
    const p = prev.get(b.id);
    if (!p) {
      inserts.push({
        id: b.id,
        resource_ids: b.roomIds,
        requester_id: requesterId && b.requester === actor ? requesterId : undefined,
        requester_name: b.requester,
        requester_role: b.role,
        club: b.club,
        starts_at: toTs(b.date, b.start),
        ends_at: toTs(b.date, b.end),
        title: b.title,
        purpose: b.purpose,
        priority: b.priority,
        status: b.status,
        attendees: b.attendees,
      });
      continue;
    }
    const u: Changes["updates"][number] = { id: b.id };
    if (p.status !== b.status) u.status = b.status;
    if (p.start !== b.start) u.starts_at = toTs(b.date, b.start);
    if (p.end !== b.end) u.ends_at = toTs(b.date, b.end);
    if (!!p.checkedIn !== !!b.checkedIn) u.checked_in = !!b.checkedIn;
    if ((p.occupancy ?? 0) !== (b.occupancy ?? 0)) u.occupancy = b.occupancy ?? 0;
    if (Object.keys(u).length > 1) updates.push(u);
  }
  const seenEv = new Set(before.events.map((e) => e.id));
  const subjects = new Set([...Object.keys(after.bumps), ...Object.keys(after.points)]);
  const ledger = [...subjects]
    .filter((k) => (after.bumps[k] ?? 0) !== (before.bumps[k] ?? 0) || (after.points[k] ?? 0) !== (before.points[k] ?? 0))
    .map((k) => ({ subject: k, bumps: after.bumps[k] ?? 0, points: after.points[k] ?? 0 }));
  const beforeWl = new Set(before.waitlist.map((w) => w.id));
  const afterWl = new Set(after.waitlist.map((w) => w.id));
  return {
    actor,
    updates,
    inserts,
    events: after.events.filter((e) => !seenEv.has(e.id)),
    ledger,
    waitlist_add: after.waitlist
      .filter((w) => !beforeWl.has(w.id))
      .map((w) => ({ id: w.id, resource_ids: w.roomIds, requester_name: w.requester, requester_role: w.role, club: w.club, starts_at: toTs(w.date, w.start), ends_at: toTs(w.date, w.end), title: w.title, purpose: w.purpose, attendees: w.attendees })),
    waitlist_remove: [...beforeWl].filter((id) => !afterWl.has(id)),
    ...docsDiff(before, after),
    ...blackoutsDiff(before, after),
  };
}

function docsDiff(before: EngineState, after: EngineState) {
  const key = (d: DocRow) => `${d.kind}:${d.id}`;
  const prev = new Map(docsOf(before).map((d) => [key(d), JSON.stringify(d.data)]));
  const next = docsOf(after);
  const nextKeys = new Set(next.map(key));
  return {
    docs_upsert: next.filter((d) => prev.get(key(d)) !== JSON.stringify(d.data)),
    docs_remove: docsOf(before)
      .filter((d) => !nextKeys.has(key(d)))
      .map((d) => ({ kind: d.kind, id: d.id })),
  };
}

function blackoutsDiff(before: EngineState, after: EngineState) {
  const prev = new Map(before.blackouts.map((b) => [b.id, JSON.stringify(b)]));
  const ids = new Set(after.blackouts.map((b) => b.id));
  return {
    blackouts_upsert: after.blackouts
      .filter((b) => prev.get(b.id) !== JSON.stringify(b))
      .map((b) => ({ id: b.id, label: b.label, starts_at: toTs(b.date, b.start), ends_at: toTs(b.date, b.end), resource_ids: b.roomIds, allow: b.allow })),
    blackouts_remove: before.blackouts.filter((b) => !ids.has(b.id)).map((b) => b.id),
  };
}
