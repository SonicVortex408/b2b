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

export interface NegMessage {
  from: string;
  text: string;
  at: number;
  offer?: { start: number; end: number };
}

/** Close-call conflict: the requester asks the holder to shift. Auto-escalates to admin if unanswered. */
export interface Negotiation {
  id: string;
  holderBookingId: string;
  holder: string;
  requester: string;
  req: BookingRequest;
  messages: NegMessage[];
  status: "open" | "accepted" | "declined" | "escalated";
  at: number;
}

export interface SwapOffer {
  id: string;
  bookingId: string;
  owner: string;
  status: "listed" | "claimed" | "withdrawn";
  claimedBy?: string;
  at: number;
}

/** Approver's counter-proposal on a pending request. One click accepts it. */
export interface Counter {
  id: string; // = booking id
  by: string;
  roomId: string;
  start: number;
  end: number;
  status: "open" | "accepted" | "declined";
  at: number;
}

/** 90-second soft-hold while a user confirms (Upstash in the spec; engine state here). */
export interface Hold {
  id: string;
  roomIds: string[];
  date: string;
  start: number;
  end: number;
  by: string;
  expires: number;
}

export type NoticeKind = "bump" | "approval" | "negotiation" | "swap" | "free" | "counter" | "info";

/** In-app notification. `to` is a user name, "*" (everyone) or "role:approver". */
export interface Notice {
  id: string;
  to: string;
  kind: NoticeKind;
  text: string;
  at: number;
  ref?: string;
  roomIds?: string[];
  alts?: Alternative[];
  free?: { roomId: string; date: string; start: number; end: number; claimedBy?: string };
}

export interface Occupancy {
  density: number;
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
  negotiations: Negotiation[];
  swaps: SwapOffer[];
  counters: Counter[];
  holds: Hold[];
  notices: Notice[];
  occupancy: Record<string, Occupancy>;
}

export const HOLD_MS = 90_000;

/** Fill fields added after a state was saved (older localStorage snapshots). */
export function withDefaults(s: Partial<EngineState>): EngineState {
  return {
    bookings: [],
    events: [],
    bumps: {},
    waitlist: [],
    blackouts: [],
    points: {},
    seq: 0,
    ...s,
    negotiations: s.negotiations ?? [],
    swaps: s.swaps ?? [],
    counters: s.counters ?? [],
    holds: s.holds ?? [],
    notices: s.notices ?? [],
    occupancy: s.occupancy ?? {},
  };
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
  const now = Date.now();
  for (const h of s.holds) {
    if (h.by !== req.requester && h.expires > now && h.date === req.date && overlaps(h.start, h.end, req.start, req.end) && h.roomIds.some((r) => req.roomIds.includes(r)))
      return `${h.by} is confirming this slot (soft-hold, ${Math.ceil((h.expires - now) / 1000)} s left).`;
  }
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

export function notify(s: EngineState, n: Omit<Notice, "id" | "at">): Notice {
  const notice = { ...n, id: nextId(s, "nt"), at: Date.now() };
  s.notices.unshift(notice);
  if (s.notices.length > 300) s.notices.length = 300;
  return notice;
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
    s.holds = s.holds.filter((h) => !(h.by === req.requester && h.date === req.date && h.roomIds.some((r) => req.roomIds.includes(r))));
    if (status === "pending_approval")
      notify(s, { to: "role:approver", kind: "approval", text: `${req.requester} requested ${roomNames(req.roomIds)} (${slot(req)}) for ${PURPOSE_LABEL[req.purpose].toLowerCase()}.`, ref: booking.id, roomIds: req.roomIds });
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
      notify(s, {
        to: c.requester,
        kind: "bump",
        text: `Your ${roomNames(c.roomIds)} booking (${slot(c)}) was moved because ${PURPOSE_LABEL[req.purpose]}: ${req.title} (priority ${mine.total} vs your ${sc.total}) needed the room. You've been given a +${boost} fairness boost. Pick a rebooking offer:`,
        ref: c.id,
        roomIds: c.roomIds,
        alts,
      });
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
  if (close) openNegotiation(s, req, top.c, ctx);
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
  notify(s, { to: b.requester, kind: "approval", text: `Approved: ${roomNames(b.roomIds)} (${slot(b)}) by ${by}.`, ref: id, roomIds: b.roomIds });
  pushEvent(s, { kind: "approved", roomIds: b.roomIds, bookingId: id, text: `${by} approved ${b.requester}'s ${roomNames(b.roomIds)} request (${slot(b)}).` });
}

export function reject(s: EngineState, id: string, by: string, reason: string, ctx: RuleContext) {
  const b = s.bookings.find((x) => x.id === id);
  if (!b || b.status !== "pending_approval") return;
  b.status = "cancelled";
  notify(s, { to: b.requester, kind: "approval", text: `Rejected: ${roomNames(b.roomIds)} (${slot(b)}). ${reason}`, ref: id, roomIds: b.roomIds, alts: alternatives(s, b, ctx) });
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
  if (freed.end > freed.start && freed.date === ctx.today)
    notify(s, {
      to: "*",
      kind: "free",
      text: `${roomNames(b.roomIds)} on floor ${ROOM_BY_ID.get(b.roomIds[0])?.floor} is free now until ${fmtTime(freed.end)}. Tap to claim it (+5 points).`,
      roomIds: b.roomIds,
      free: { roomId: b.roomIds[0], date: freed.date, start: freed.start, end: freed.end },
    });
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

// ---------------------------------------------------------------- negotiation

function openNegotiation(s: EngineState, req: BookingRequest, holder: Booking, ctx: RuleContext) {
  if (s.negotiations.some((n) => n.status === "open" && n.holderBookingId === holder.id && n.requester === req.requester)) return;
  const shift = holder.end - holder.start;
  const offerStart = holder.start + 60;
  const free = offerStart + shift <= DAY_END && holdingConflicts(s, holder.roomIds, holder.date, offerStart, offerStart + shift, holder.id).every((c) => c.id === holder.id);
  const n: Negotiation = {
    id: nextId(s, "ng"),
    holderBookingId: holder.id,
    holder: holder.requester,
    requester: req.requester,
    req,
    status: "open",
    at: Date.now(),
    messages: [
      {
        from: req.requester,
        text: free
          ? `Hi! I need ${roomNames(holder.roomIds)} for ${req.title} (${slot(req)}). Could you shift your booking 1 hour to ${fmtTime(offerStart)}–${fmtTime(offerStart + shift)}?`
          : `Hi! I need ${roomNames(holder.roomIds)} for ${req.title} (${slot(req)}). Is there any flexibility on your booking?`,
        at: Date.now(),
        offer: free ? { start: offerStart, end: offerStart + shift } : undefined,
      },
    ],
  };
  s.negotiations.unshift(n);
  notify(s, { to: holder.requester, kind: "negotiation", text: `${req.requester} asks if you can shift your ${roomNames(holder.roomIds)} booking (${slot(holder)}).`, ref: n.id, roomIds: holder.roomIds });
  void ctx;
}

export function negotiationMessage(s: EngineState, id: string, from: string, text: string) {
  const n = s.negotiations.find((x) => x.id === id);
  if (!n || n.status !== "open") return;
  n.messages.push({ from, text: text.slice(0, 500), at: Date.now() });
  notify(s, { to: from === n.holder ? n.requester : n.holder, kind: "negotiation", text: `${from}: ${text.slice(0, 120)}`, ref: n.id });
}

/** Holder accepts (moves to the offered slot, requester gets the room) or declines. */
export function negotiationReply(s: EngineState, id: string, accept: boolean, ctx: RuleContext): string {
  const n = s.negotiations.find((x) => x.id === id);
  if (!n || n.status !== "open") return "Negotiation is closed.";
  const holder = s.bookings.find((b) => b.id === n.holderBookingId);
  if (!accept || !holder) {
    n.status = "declined";
    n.messages.push({ from: n.holder, text: "Sorry, I can't move.", at: Date.now() });
    notify(s, { to: n.requester, kind: "negotiation", text: `${n.holder} can't move. Here are alternatives:`, ref: n.id, alts: alternatives(s, n.req, ctx) });
    pushEvent(s, { kind: "rejected_conflict", roomIds: n.req.roomIds, text: `Negotiation declined by ${n.holder}; ${n.requester} offered alternatives.` });
    return "Declined";
  }
  const offer = [...n.messages].reverse().find((m) => m.offer)?.offer;
  const shifted = offer && holdingConflicts(s, holder.roomIds, holder.date, offer.start, offer.end, holder.id).length === 0;
  const oldSlot = { start: holder.start, end: holder.end };
  if (offer && shifted) {
    holder.start = offer.start;
    holder.end = offer.end;
  } else {
    holder.status = "cancelled";
  }
  const res = bookResources(s, n.req, ctx);
  if (!res.ok) {
    // roll the holder back; nothing changes
    holder.start = oldSlot.start;
    holder.end = oldSlot.end;
    holder.status = "confirmed";
    return res.event.text;
  }
  n.status = "accepted";
  n.messages.push({ from: n.holder, text: offer && shifted ? `Done, I've moved to ${fmtTime(offer.start)}.` : "Sure, take it.", at: Date.now() });
  s.points[n.holder] = (s.points[n.holder] ?? 0) + 15;
  notify(s, { to: n.requester, kind: "negotiation", text: `${n.holder} agreed. ${roomNames(n.req.roomIds)} is yours (${slot(n.req)}).`, ref: n.id, roomIds: n.req.roomIds });
  pushEvent(s, { kind: "confirmed", roomIds: n.req.roomIds, bookingId: res.booking.id, text: `Negotiated: ${n.holder} ${offer && shifted ? `shifted to ${fmtTime(offer.start)}` : "released the slot"}; ${n.requester} got ${roomNames(n.req.roomIds)}. +15 points to ${n.holder} for accepting a reschedule.` });
  return "Accepted";
}

/** Inngest-style timer stand-in: unanswered negotiations escalate to admin. */
export function escalateNegotiations(s: EngineState, olderThanMs: number) {
  for (const n of s.negotiations)
    if (n.status === "open" && Date.now() - n.at > olderThanMs) {
      n.status = "escalated";
      notify(s, { to: "role:admin", kind: "negotiation", text: `Negotiation between ${n.requester} and ${n.holder} for ${roomNames(n.req.roomIds)} went unanswered; please decide.`, ref: n.id });
      pushEvent(s, { kind: "escalated", roomIds: n.req.roomIds, text: `Negotiation for ${roomNames(n.req.roomIds)} escalated to admin after no reply.` });
    }
}

// ---------------------------------------------------------------- swap marketplace

export function listSwap(s: EngineState, bookingId: string, owner: string) {
  const b = s.bookings.find((x) => x.id === bookingId);
  if (!b || !HOLDING.includes(b.status) || s.swaps.some((w) => w.bookingId === bookingId && w.status === "listed")) return;
  s.swaps.unshift({ id: nextId(s, "sw"), bookingId, owner, status: "listed", at: Date.now() });
  notify(s, { to: "*", kind: "swap", text: `${owner} listed ${roomNames(b.roomIds)} (${slot(b)}) on the swap marketplace.`, ref: bookingId, roomIds: b.roomIds });
}

export function withdrawSwap(s: EngineState, id: string) {
  const w = s.swaps.find((x) => x.id === id);
  if (w && w.status === "listed") w.status = "withdrawn";
}

/** Atomic hand-over: old booking cancelled and the claimer's booking inserted in one write (constraint-protected). */
export function claimSwap(s: EngineState, id: string, claimer: { name: string; role: Role }, ctx: RuleContext): string {
  const w = s.swaps.find((x) => x.id === id);
  const b = w && s.bookings.find((x) => x.id === w.bookingId);
  if (!w || w.status !== "listed" || !b || !HOLDING.includes(b.status)) return "This slot is no longer available.";
  if (w.owner === claimer.name) return "You can't claim your own slot.";
  const prev = b.status;
  b.status = "cancelled";
  const res = bookResources(s, { roomIds: b.roomIds, date: b.date, start: b.start, end: b.end, title: `${b.title} (swap from ${w.owner})`, requester: claimer.name, role: claimer.role, purpose: b.purpose, attendees: Math.min(b.attendees, ROOM_BY_ID.get(b.roomIds[0])?.capacity ?? b.attendees) }, ctx);
  if (!res.ok) {
    b.status = prev;
    return res.event.text;
  }
  w.status = "claimed";
  w.claimedBy = claimer.name;
  s.points[w.owner] = (s.points[w.owner] ?? 0) + 5;
  notify(s, { to: w.owner, kind: "swap", text: `${claimer.name} claimed your ${roomNames(b.roomIds)} slot (${slot(b)}). +5 points.`, ref: b.id });
  return res.booking.status === "pending_approval" ? "Claimed: sent for approval" : "Claimed";
}

// ---------------------------------------------------------------- counter-proposals

export function counterPropose(s: EngineState, bookingId: string, by: string, roomId: string, start: number, end: number) {
  const b = s.bookings.find((x) => x.id === bookingId);
  if (!b || b.status !== "pending_approval") return;
  s.counters = s.counters.filter((c) => c.id !== bookingId);
  s.counters.unshift({ id: bookingId, by, roomId, start, end, status: "open", at: Date.now() });
  notify(s, { to: b.requester, kind: "counter", text: `${by} can't approve ${roomNames(b.roomIds)} at ${fmtTime(b.start)}, but offers ${roomNames([roomId])} ${fmtTime(start)}–${fmtTime(end)}. One click to accept.`, ref: bookingId, roomIds: [roomId] });
  pushEvent(s, { kind: "pending", roomIds: [roomId], bookingId, text: `${by} counter-proposed ${roomNames([roomId])} ${fmtTime(start)}–${fmtTime(end)} to ${b.requester}.` });
}

export function counterReply(s: EngineState, bookingId: string, accept: boolean, ctx: RuleContext): string {
  const c = s.counters.find((x) => x.id === bookingId && x.status === "open");
  const b = s.bookings.find((x) => x.id === bookingId);
  if (!c || !b) return "Offer expired.";
  if (!accept) {
    c.status = "declined";
    return "Declined";
  }
  const prev = b.status;
  b.status = "cancelled";
  const res = bookResources(s, { roomIds: [c.roomId], date: b.date, start: c.start, end: c.end, title: b.title, requester: b.requester, role: b.role, club: b.club, purpose: b.purpose, attendees: b.attendees }, ctx);
  if (!res.ok) {
    b.status = prev;
    return res.event.text;
  }
  res.booking.status = "confirmed"; // the approver pre-approved this slot
  c.status = "accepted";
  pushEvent(s, { kind: "approved", roomIds: [c.roomId], bookingId: res.booking.id, text: `${b.requester} accepted ${c.by}'s counter-proposal: ${roomNames([c.roomId])} ${fmtTime(c.start)}–${fmtTime(c.end)}.` });
  return "Accepted";
}

// ---------------------------------------------------------------- live conflict preview (before submit)

export type PreviewDecision = "confirm" | "pending" | "bump" | "negotiate" | "share" | "conflict" | "rule";

export interface Preview {
  decision: PreviewDecision;
  text: string;
  mine: ScoreBreakdown;
  theirs?: ScoreBreakdown;
  holder?: Booking;
}

/** Dry-runs bookResources on a copy so the UI can explain the outcome before the user commits. */
export function previewBooking(s: EngineState, req: BookingRequest, ctx: RuleContext): Preview {
  const copy = structuredClone(s);
  const mine = score(copy, req, ctx);
  const rule = checkRules(copy, req, ctx);
  if (rule) return { decision: "rule", text: rule, mine };
  const clash = holdingConflicts(copy, req.roomIds, req.date, req.start, req.end);
  if (!clash.length) {
    const st = initialStatus(req);
    return { decision: st === "confirmed" ? "confirm" : "pending", text: st === "confirmed" ? "Free. Confirms instantly." : `Free. Goes to the ${ROOM_BY_ID.get(req.roomIds[0])?.pool ?? "approver"} pool; slot is soft-held while pending.`, mine };
  }
  const res = bookResources(copy, req, ctx);
  const top = clash.reduce((a, b) => (score(copy, b, ctx).total > score(copy, a, ctx).total ? b : a));
  const theirs = score(s, top, ctx);
  const kind = res.ok ? "bump" : res.event.kind === "negotiate" ? "negotiate" : res.event.kind === "share" ? "share" : "conflict";
  const text = {
    bump: `Clashes with ${top.title} (${top.club ?? top.requester}). Your priority ${mine.total} beats ${theirs.total} by ${BUMP_THRESHOLD}+, so it would be bumped with rebooking offers.`,
    negotiate: `Clashes with ${top.title} (${top.club ?? top.requester}). Close call (${mine.total} vs ${theirs.total}): we'll open a negotiation thread.`,
    share: `Clashes with ${top.title}, but you'd both fit. We'll propose sharing the room.`,
    conflict: `Held by ${top.club ?? top.requester} (${top.title}, priority ${theirs.total} vs your ${mine.total}). Pick an alternative.`,
  }[kind];
  return { decision: kind, text, mine, theirs, holder: top };
}

// ---------------------------------------------------------------- soft-holds, free-room claims, occupancy

export function placeHold(s: EngineState, h: Omit<Hold, "id" | "expires">): string | null {
  const now = Date.now();
  s.holds = s.holds.filter((x) => x.expires > now && x.by !== h.by);
  const clash = s.holds.find((x) => x.date === h.date && overlaps(x.start, x.end, h.start, h.end) && x.roomIds.some((r) => h.roomIds.includes(r)));
  if (clash) return `${clash.by} is already confirming this slot.`;
  if (holdingConflicts(s, h.roomIds, h.date, h.start, h.end).length) return null; // conflict preview will explain; no hold needed
  s.holds.push({ ...h, id: nextId(s, "hd"), expires: now + HOLD_MS });
  return null;
}

export function releaseHold(s: EngineState, by: string) {
  s.holds = s.holds.filter((x) => x.by !== by && x.expires > Date.now());
}

export function claimFree(s: EngineState, noticeId: string, claimer: { name: string; role: Role }, ctx: RuleContext): string {
  const n = s.notices.find((x) => x.id === noticeId);
  if (!n?.free || n.free.claimedBy) return "Someone already claimed it.";
  const start = Math.max(n.free.start, Math.ceil(ctx.nowMin / 15) * 15);
  if (start >= n.free.end) return "That slot has ended.";
  const res = bookResources(s, { roomIds: [n.free.roomId], date: n.free.date, start, end: n.free.end, title: "Peer hand-off", requester: claimer.name, role: claimer.role, purpose: "casual", attendees: 4 }, ctx);
  if (!res.ok) return res.event.text;
  n.free.claimedBy = claimer.name;
  n.text = `${roomNames([n.free.roomId])} was claimed by ${claimer.name}.`;
  s.points[claimer.name] = (s.points[claimer.name] ?? 0) + 5;
  return res.booking.status === "pending_approval" ? "Requested (needs approval)" : "Claimed";
}

/** Occupancy simulator: checked-in rooms busy, ghosts empty, a few free rooms with squatters. */
export function simulateOccupancy(s: EngineState, ctx: RuleContext, rand = Math.random) {
  const at = Date.now();
  for (const r of BOOKABLE_ROOMS) {
    const b = s.bookings.find((x) => x.date === ctx.today && x.roomIds.includes(r.id) && HOLDING.includes(x.status) && x.start <= ctx.nowMin && ctx.nowMin < x.end);
    const density = b ? (b.status === "checked_in" ? 0.5 + rand() * 0.45 : rand() < 0.4 ? 0 : 0.3 + rand() * 0.4) : rand() < 0.12 ? 0.25 + rand() * 0.4 : 0;
    s.occupancy[r.id] = { density: Math.round(density * 100) / 100, at };
    if (b && b.status === "confirmed") b.occupancy = s.occupancy[r.id].density;
  }
}

export function setOccupancy(s: EngineState, roomId: string, density: number) {
  s.occupancy[roomId] = { density, at: Date.now() };
}

export function addBlackout(s: EngineState, b: Omit<Blackout, "id">) {
  s.blackouts.push({ ...b, id: nextId(s, "bo") });
}

export function removeBlackout(s: EngineState, id: string) {
  s.blackouts = s.blackouts.filter((b) => b.id !== id);
}
