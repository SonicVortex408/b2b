import { ROOM_BY_ID } from "@/data/campus";
import * as E from "@/lib/engine";
import { searchAvailability, type BookingIntent } from "@/lib/intent";
import { seedState } from "@/lib/seed";
import { fmtTime, nowMinutes, parse24, todayISO } from "@/lib/time";
import type { BookingRequest } from "@/lib/types";

/** Process-local engine for headless channels (MCP server, Telegram bot). Production: Supabase RPC. */
let state: E.EngineState | null = null;
const ctx = () => ({ today: todayISO(), nowMin: nowMinutes() });
export const engine = () => (state ??= seedState(ctx().today, ctx().nowMin));

export function search(intent: BookingIntent) {
  return searchAvailability(engine(), intent, 3, ctx()).map((o) => ({
    room_id: o.room.id,
    room: o.room.name,
    floor: o.room.floor,
    capacity: o.room.capacity,
    date: o.date,
    start: fmtTime(o.start),
    end: fmtTime(o.end),
    start_hhmm: `${String(Math.floor(o.start / 60)).padStart(2, "0")}:${String(o.start % 60).padStart(2, "0")}`,
    fit: o.score,
    why: o.why,
  }));
}

export function create(req: Omit<BookingRequest, "start" | "end"> & { start: string; end: string }) {
  const res = E.bookResources(engine(), { ...req, start: parse24(req.start), end: parse24(req.end) }, ctx());
  return res.ok
    ? { ok: true, booking_id: res.booking.id, status: res.booking.status, explanation: res.event.text }
    : { ok: false, code: res.code, explanation: res.event.text, alternatives: res.alternatives.map((a) => ({ room_id: a.roomId, room: ROOM_BY_ID.get(a.roomId)?.name, start: fmtTime(a.start), disruption: a.disruption, reason: a.reason })) };
}

export function explain(bookingId: string) {
  const s = engine();
  const events = s.events.filter((e) => e.bookingId === bookingId || e.loserId === bookingId);
  const b = s.bookings.find((x) => x.id === bookingId);
  if (!b && !events.length) return { found: false };
  return { found: true, status: b?.status, decisions: events.map((e) => ({ kind: e.kind, text: e.text, winner_score: e.winnerScore, other_score: e.loserScore })) };
}
