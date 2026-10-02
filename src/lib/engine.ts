/**
 * XIE Spaces booking + conflict engine.
 *
 * Every write goes through `bookResources`, which mirrors the Postgres RPC `book_resources(bundle)`:
 * rules gate → priority scoring → decision (bump / negotiate / share / reject) → guarded insert.
 * `insertGuarded` is the in-memory twin of the EXCLUDE USING gist constraint and is the final
 * arbiter: it throws SQLSTATE 23P01 if any holding booking overlaps, so app logic is never the
 * only defence (see supabase/migrations/0001_init.sql for the real constraint).
 */
import { BOOKABLE_ROOMS, ROOM_BY_ID } from "@/data/campus";
import { DAY_END, DAY_START, dayDiff, fmtDate, fmtTime, overlaps } from "@/lib/time";
import {
  HOLDING,
  type Alternative,
  type Booking,
  type BookingRequest,
  type BookResult,
  type DecisionEvent,
  type Purpose,
  type Role,
  type Room,
  type ScoreBreakdown,
} from "@/lib/types";

export interface Blackout {
  id: string;
  label: string;
  date: string;
  start: number;
  end: number;
  roomIds: string[];
  allow: Purpose[]; // purposes still permitted during the blackout
}

export interface WaitEntry extends BookingRequest {
  id: string;
  at: number;
}

export interface EngineState {
  bookings: Booking[];
  events: DecisionEvent[];
  bumps: Record<string, number>; // fairness ledger: bumps suffered per user/club
  waitlist: WaitEntry[];
  blackouts: Blackout[];
  points: Record<string, number>;
  seq: number;
}

export const PURPOSE_WEIGHT: Record<Purpose, number> = {
  exam: 100,
  academic_class: 80,
  faculty_event: 60,
  club_event: 40,
  casual: 20,
};
export const PURPOSE_LABEL: Record<Purpose, string> = {
  exam: "Exam",
  academic_class: "Academic class",
  faculty_event: "Faculty event",
  club_event: "Club event",
  casual: "Casual",
};
const ROLE_WEIGHT: Record<Role, number> = { admin: 100, approver: 90, faculty: 80, student: 40 };
const ADVANCE_DAYS: Record<Role, number> = { student: 3, faculty: 21, approver: 21, admin: Infinity };
const MAX_DURATION: Record<Role, number> = { student: 180, faculty: 240, approver: 300, admin: 600 };
export const BUMP_THRESHOLD = 15;
export const CHECKIN_WINDOW = 10;

export class ExclusionViolation extends Error {
  code = "23P01" as const;
  constructor(public conflicts: Booking[]) {
    super("conflicting key value violates exclusion constraint \"bookings_no_overlap\"");
  }
}

export const nextId = (s: EngineState, prefix: string) => `${prefix}-${(++s.seq).toString(36)}`;

export function holdingConflicts(s: EngineState, roomIds: string[], date: string, start: number, end: number, ignore?: string) {
  return s.bookings.filter(
    (b) =>
      b.id !== ignore &&
      b.date === date &&
      HOLDING.includes(b.status) &&
      b.roomIds.some((id) => roomIds.includes(id)) &&
      overlaps(b.start, b.end, start, end),
  );
}

/** The DB-level guard. Never bypassed. */
export function insertGuarded(s: EngineState, b: Booking) {
  if (HOLDING.includes(b.status)) {
    const clash = holdingConflicts(s, b.roomIds, b.date, b.start, b.end, b.id);
    if (clash.length) throw new ExclusionViolation(clash);
  }
  s.bookings.push(b);
}

/** Invariant check used by the Chaos panel and tests: count of overlapping holding pairs. */
export function countDoubleBookings(s: EngineState): number {
  const holding = s.bookings.filter((b) => HOLDING.includes(b.status));
  let n = 0;
  for (let i = 0; i < holding.length; i++)
    for (let j = i + 1; j < holding.length; j++) {
      const a = holding[i];
      const b = holding[j];
      if (a.date === b.date && overlaps(a.start, a.end, b.start, b.end) && a.roomIds.some((r) => b.roomIds.includes(r))) n++;
    }
  return n;
}

// ---------------------------------------------------------------- rules gate

export interface RuleContext {
  today: string;
  nowMin: number;
}

export function checkRules(s: EngineState, req: BookingRequest, ctx: RuleContext): string | null {
  for (const id of req.roomIds) {
    const room = ROOM_BY_ID.get(id);
    if (!room || !room.bookable) return `${room?.name ?? id} is not bookable.`;
    if (room.capacity != null && req.attendees > room.capacity && req.roomIds.length === 1)
      return `${room.name} seats ${room.capacity}; you need ${req.attendees}.`;
  }
  if (req.end <= req.start) return "End time must be after start time.";
  if (req.start < DAY_START || req.end > DAY_END) return "Bookings must fall within working hours (08:00–20:00).";
  const dur = req.end - req.start;
  if (dur > MAX_DURATION[req.role]) return `Max duration for ${req.role}s is ${MAX_DURATION[req.role] / 60} h.`;
  const ahead = dayDiff(ctx.today, req.date);
  if (ahead < 0 || (ahead === 0 && req.end <= ctx.nowMin)) return "That slot is in the past.";
  if (ahead > ADVANCE_DAYS[req.role]) return `${cap(req.role)}s can book up to ${ADVANCE_DAYS[req.role]} days ahead.`;
  for (const bo of s.blackouts) {
    if (bo.date === req.date && overlaps(bo.start, bo.end, req.start, req.end) && req.roomIds.some((r) => bo.roomIds.includes(r)) && !bo.allow.includes(req.purpose))
      return `${bo.label}: only ${bo.allow.map((p) => PURPOSE_LABEL[p].toLowerCase()).join(", ")} bookings allowed ${fmtTime(bo.start)}–${fmtTime(bo.end)}.`;
  }
  return null;
}

export function inBlackout(s: EngineState, roomId: string, date: string, min: number) {
  return s.blackouts.find((b) => b.date === date && b.roomIds.includes(roomId) && min >= b.start && min < b.end);
}

// ---------------------------------------------------------------- scoring

export function usageHours(s: EngineState, who: string): number {
  return s.bookings.filter((b) => b.requester === who && b.status !== "cancelled").reduce((h, b) => h + (b.end - b.start) / 60, 0);
}

export function score(s: EngineState, req: Pick<BookingRequest, "purpose" | "role" | "date" | "start" | "requester" | "club">, ctx: RuleContext): ScoreBreakdown {
  const purpose = PURPOSE_WEIGHT[req.purpose];
  const role = ROLE_WEIGHT[req.role];
  const hoursAway = dayDiff(ctx.today, req.date) * 24 + (req.start - ctx.nowMin) / 60;
  const urgency = Math.round(Math.max(0, Math.min(100, 100 - (hoursAway / (21 * 24)) * 100)));
  const who = req.club ?? req.requester;
  const bumps = s.bumps[who] ?? 0;
  const fairness = bumps >= 3 ? 100 : bumps * 20;
  const usage = Math.round(Math.max(0, 100 - usageHours(s, req.requester) * 4));
  const total = Math.round(0.4 * purpose + 0.2 * role + 0.15 * urgency + 0.15 * fairness + 0.1 * usage);
  return { purpose, role, urgency, fairness, usage, total };
}

// ---------------------------------------------------------------- approval tiers

export function initialStatus(req: BookingRequest): "confirmed" | "pending_approval" {
  if (req.role === "admin" || req.role === "approver") return "confirmed";
  const rooms = req.roomIds.map((id) => ROOM_BY_ID.get(id)!);
  const needs = rooms.some((room) => {
    if (!room.requiresApproval) return false;
    if (req.role === "faculty" && (room.kind === "lab" || room.kind === "lh") && (req.purpose === "exam" || req.purpose === "academic_class")) return false;
    return true;
  });
  return needs ? "pending_approval" : "confirmed";
}

// ---------------------------------------------------------------- alternatives

function isFree(s: EngineState, roomId: string, date: string, start: number, end: number) {
  return holdingConflicts(s, [roomId], date, start, end).length === 0 && !s.blackouts.some((b) => b.date === date && b.roomIds.includes(roomId) && overlaps(b.start, b.end, start, end));
}

export function alternatives(s: EngineState, req: BookingRequest, ctx: RuleContext, limit = 3): Alternative[] {
  const out: Alternative[] = [];
  const dur = req.end - req.start;
  const primary = ROOM_BY_ID.get(req.roomIds[0])!;
  const minStart = req.date === ctx.today ? Math.ceil(ctx.nowMin / 15) * 15 : DAY_START;

  // (a) same room, nearest free slot today
  for (let d = 30; d <= 6 * 60; d += 30) {
    for (const sign of [1, -1]) {
      const st = req.start + sign * d;
      if (st < Math.max(DAY_START, minStart) || st + dur > DAY_END) continue;
      if (req.roomIds.every((id) => isFree(s, id, req.date, st, st + dur))) {
        out.push({ roomId: primary.id, date: req.date, start: st, end: st + dur, disruption: Math.round((d / 30) * 8), reason: `Same room, ${sign > 0 ? "+" : "−"}${d >= 60 ? `${d / 60} h` : `${d} min`}` });
        break;
      }
    }
    if (out.length) break;
  }

  // (b) similar room at the same time
  const need = req.attendees;
  const similar = BOOKABLE_ROOMS.filter((r) => r.id !== primary.id && (r.capacity ?? 0) >= need && r.kind !== "outdoor")
    .map((r) => ({ r, d: similarity(primary, r) }))
    .sort((a, b) => a.d - b.d);
  for (const { r, d } of similar) {
    if (out.length >= limit + 1) break;
    if (isFree(s, r.id, req.date, req.start, req.end))
      out.push({ roomId: r.id, date: req.date, start: req.start, end: req.end, disruption: d, reason: r.floor === primary.floor ? `Similar ${r.kind === primary.kind ? "room" : "space"}, same floor` : `Similar room, floor ${r.floor}` });
  }

  // (c) adjacent time, similar room
  if (out.length < limit) {
    for (const { r, d } of similar.slice(0, 6)) {
      const st = req.end;
      if (st + dur <= DAY_END && isFree(s, r.id, req.date, st, st + dur)) {
        out.push({ roomId: r.id, date: req.date, start: st, end: st + dur, disruption: d + 20, reason: "Next slot, similar room" });
        break;
      }
    }
  }
  return out.sort((a, b) => a.disruption - b.disruption).slice(0, limit);
}

function similarity(a: Room, b: Room): number {
  let d = Math.abs(a.floor - b.floor) * 15;
  if (a.kind !== b.kind) d += 25;
  d += a.tags.filter((t) => !b.tags.includes(t)).length * 4;
  d += Math.min(20, Math.abs((b.capacity ?? 0) - (a.capacity ?? 0)) / 5);
  return Math.round(d);
}

// ---------------------------------------------------------------- the one write path

const who = (b: Pick<Booking, "requester" | "club">) => b.club ?? b.requester;
const roomNames = (ids: string[]) => ids.map((id) => ROOM_BY_ID.get(id)?.name ?? id).join(" + ");
const slot = (b: Pick<Booking, "date" | "start" | "end">) => `${fmtDate(b.date, { weekday: "short" })} ${fmtTime(b.start)}–${fmtTime(b.end)}`;

function pushEvent(s: EngineState, e: Omit<DecisionEvent, "id" | "at">): DecisionEvent {
  const ev = { ...e, id: nextId(s, "ev"), at: Date.now() };
  s.events.unshift(ev);
  if (s.events.length > 400) s.events.length = 400;
  return ev;
}

export function bookResources(s: EngineState, req: BookingRequest, ctx: RuleContext): BookResult {
  // 1. rules gate
  const rule = checkRules(s, req, ctx);
  if (rule) {
    const ev = pushEvent(s, { kind: "rejected_rule", roomIds: req.roomIds, text: `Blocked by rule: ${rule}` });
    return { ok: false, code: "RULE", event: ev, alternatives: alternatives(s, req, ctx) };
  }

  // 2. score
  const mine = score(s, req, ctx);
  const status = initialStatus(req);
  const booking: Booking = {
    ...req,
    id: nextId(s, "bk"),
    status,
    priority: mine.total,
    createdAt: Date.now(),
    occupancy: 0,
  };

  try {
    insertGuarded(s, booking);
    const ev = pushEvent(s, {
      kind: status === "confirmed" ? "confirmed" : "pending",
      roomIds: req.roomIds,
      bookingId: booking.id,
      winnerScore: mine,
      text:
        status === "confirmed"
          ? `${req.requester} booked ${roomNames(req.roomIds)} for ${slot(req)} (priority ${mine.total}).`
          : `${req.requester} requested ${roomNames(req.roomIds)} for ${slot(req)}; sent to ${ROOM_BY_ID.get(req.roomIds[0])?.pool ?? "approver"} pool.`,
    });
    return { ok: true, booking, event: ev };
  } catch (err) {
    if (!(err instanceof ExclusionViolation)) throw err;
    return resolveConflict(s, req, booking, mine, err.conflicts, ctx);
  }
}

// 3. decision: bump / negotiate / share / reject
function resolveConflict(s: EngineState, req: BookingRequest, booking: Booking, mine: ScoreBreakdown, conflicts: Booking[], ctx: RuleContext): BookResult {
  const theirs = conflicts.map((c) => ({ c, sc: score(s, c, ctx) }));
  const top = theirs.reduce((a, b) => (b.sc.total > a.sc.total ? b : a));
  const lockedIn = conflicts.some((c) => c.status === "checked_in");

  if (!lockedIn && mine.total - top.sc.total >= BUMP_THRESHOLD) {
    for (const { c, sc } of theirs) {
      c.status = "bumped";
      const loser = who(c);
      s.bumps[loser] = (s.bumps[loser] ?? 0) + 1;
      const alts = alternatives(s, { ...c, roomIds: c.roomIds }, ctx);
      const boost = s.bumps[loser] >= 3 ? 15 : 8;
      pushEvent(s, {
        kind: "bumped",
        roomIds: c.roomIds,
        bookingId: booking.id,
        loserId: c.id,
        winnerScore: mine,
        loserScore: sc,
        text: `${loser}'s ${roomNames(c.roomIds)} booking (${slot(c)}) was moved because ${PURPOSE_LABEL[req.purpose]}: ${req.title} (priority ${mine.total}) needed the room. ${alts.length} rebooking offers sent; +${boost} fairness boost for next time.`,
      });
    }
    insertGuarded(s, booking); // still guarded: the bumped rows no longer hold the slot
    return { ok: true, booking, event: s.events[0], bumped: conflicts };
  }

  const alts = alternatives(s, req, ctx);
  const single = req.roomIds.length === 1 && conflicts.length === 1 ? conflicts[0] : null;
  const room = single ? ROOM_BY_ID.get(single.roomIds[0]) : undefined;
  if (single && room?.capacity && single.attendees + req.attendees <= room.capacity && single.purpose !== "exam" && req.purpose !== "exam") {
    const ev = pushEvent(s, {
      kind: "share",
      roomIds: req.roomIds,
      loserId: single.id,
      winnerScore: top.sc,
      loserScore: mine,
      text: `${room.name} seats ${room.capacity}; you need ${req.attendees}, ${who(single)} needs ${single.attendees}. Share it? Share request sent.`,
    });
    return { ok: false, code: "23P01", event: ev, alternatives: alts, conflictWith: conflicts, share: { roomId: room.id, capacity: room.capacity, theirs: single.attendees, yours: req.attendees } };
  }

  const close = Math.abs(mine.total - top.sc.total) < BUMP_THRESHOLD && !lockedIn;
  const ev = pushEvent(s, {
    kind: close ? "negotiate" : "rejected_conflict",
    roomIds: req.roomIds,
    loserId: top.c.id,
    winnerScore: top.sc,
    loserScore: mine,
    text: close
      ? `Close call (${mine.total} vs ${top.sc.total}). Negotiation opened with ${who(top.c)}: "Can you shift 1 hour?" Auto-escalates to admin if unanswered.`
      : `${roomNames(req.roomIds)} is held by ${who(top.c)} (${top.c.title}, priority ${top.sc.total} vs your ${mine.total}). ${alts.length} alternatives offered.`,
  });
  return { ok: false, code: "23P01", event: ev, alternatives: alts, conflictWith: conflicts };
}

// ---------------------------------------------------------------- lifecycle

export function approve(s: EngineState, id: string, by: string) {
  const b = s.bookings.find((x) => x.id === id);
  if (!b || b.status !== "pending_approval") return;
  b.status = "confirmed";
  pushEvent(s, { kind: "approved", roomIds: b.roomIds, bookingId: id, text: `${by} approved ${b.requester}'s ${roomNames(b.roomIds)} request (${slot(b)}).` });
}

export function reject(s: EngineState, id: string, by: string, reason: string, ctx: RuleContext) {
  const b = s.bookings.find((x) => x.id === id);
  if (!b || b.status !== "pending_approval") return;
  b.status = "cancelled";
  pushEvent(s, { kind: "rejected", roomIds: b.roomIds, bookingId: id, text: `${by} rejected ${b.requester}'s ${roomNames(b.roomIds)} request: ${reason}` });
  promoteWaitlist(s, b, ctx);
}

export function escalate(s: EngineState, id: string) {
  const b = s.bookings.find((x) => x.id === id);
  if (!b || b.status !== "pending_approval") return;
  pushEvent(s, { kind: "escalated", roomIds: b.roomIds, bookingId: id, text: `No action on ${b.requester}'s ${roomNames(b.roomIds)} request within SLA; escalated to the secondary approver (Admin).` });
}

export function cancel(s: EngineState, id: string, ctx: RuleContext) {
  const b = s.bookings.find((x) => x.id === id);
  if (!b || !HOLDING.includes(b.status)) return;
  b.status = "cancelled";
  pushEvent(s, { kind: "released", roomIds: b.roomIds, bookingId: id, text: `${b.requester} cancelled ${roomNames(b.roomIds)} (${slot(b)}).` });
  promoteWaitlist(s, b, ctx);
}

export function releaseEarly(s: EngineState, id: string, ctx: RuleContext) {
  const b = s.bookings.find((x) => x.id === id);
  if (!b || !HOLDING.includes(b.status)) return;
  const freedFrom = Math.max(b.start, Math.ceil(ctx.nowMin / 15) * 15);
  const freed = { ...b, start: freedFrom };
  b.end = freedFrom;
  b.status = b.end > b.start ? "completed" : "cancelled";
  s.points[b.requester] = (s.points[b.requester] ?? 0) + 10;
  pushEvent(s, { kind: "released", roomIds: b.roomIds, bookingId: id, text: `${b.requester} released ${roomNames(b.roomIds)} early. Room free now: floor ${ROOM_BY_ID.get(b.roomIds[0])?.floor} notified (+10 points).` });
  promoteWaitlist(s, freed, ctx);
}

export function checkIn(s: EngineState, id: string) {
  const b = s.bookings.find((x) => x.id === id);
  if (!b || b.status !== "confirmed") return;
  b.status = "checked_in";
  b.checkedIn = true;
  b.occupancy = 0.8;
  s.points[b.requester] = (s.points[b.requester] ?? 0) + 5;
  pushEvent(s, { kind: "checked_in", roomIds: b.roomIds, bookingId: id, text: `${b.requester} checked in to ${roomNames(b.roomIds)} via QR (+5 points).` });
}

export function markNoShow(s: EngineState, id: string, ctx: RuleContext) {
  const b = s.bookings.find((x) => x.id === id);
  if (!b || b.status !== "confirmed") return;
  b.status = "no_show";
  s.points[b.requester] = (s.points[b.requester] ?? 0) - 10;
  pushEvent(s, { kind: "no_show", roomIds: b.roomIds, bookingId: id, text: `No QR check-in within ${CHECKIN_WINDOW} min: ${b.requester}'s ${roomNames(b.roomIds)} slot released (reliability −10).` });
  promoteWaitlist(s, b, ctx);
}

export function joinWaitlist(s: EngineState, req: BookingRequest) {
  s.waitlist.push({ ...req, id: nextId(s, "wl"), at: Date.now() });
}

function promoteWaitlist(s: EngineState, freed: Pick<Booking, "roomIds" | "date" | "start" | "end">, ctx: RuleContext) {
  const idx = s.waitlist.findIndex((w) => w.date === freed.date && w.roomIds.some((r) => freed.roomIds.includes(r)) && overlaps(w.start, w.end, freed.start, freed.end));
  if (idx < 0) return;
  const [w] = s.waitlist.splice(idx, 1);
  const res = bookResources(s, w, ctx);
  if (res.ok) pushEvent(s, { kind: "promoted", roomIds: w.roomIds, bookingId: res.booking.id, text: `Waitlist promoted: ${w.requester} now holds ${roomNames(w.roomIds)} (${slot(w)}).` });
}

/** Ghost-booking sweep: confirmed bookings past their check-in window with no check-in become no-shows. */
export function sweepNoShows(s: EngineState, ctx: RuleContext): number {
  let n = 0;
  for (const b of [...s.bookings]) {
    if (b.status === "confirmed" && b.date === ctx.today && !b.checkedIn && ctx.nowMin > b.start + CHECKIN_WINDOW && ctx.nowMin < b.end && (b.occupancy ?? 0) === 0 && b.requester !== "Exam Cell") {
      markNoShow(s, b.id, ctx);
      n++;
    }
  }
  return n;
}

const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
