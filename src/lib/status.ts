import { CHECKIN_WINDOW, inBlackout, type EngineState } from "@/lib/engine";
import { HOLDING, type Booking, type RoomKind } from "@/lib/types";

export type LiveState = "free" | "booked" | "pending" | "ghost" | "inuse" | "blackout";

export const STATE_META: Record<LiveState, { label: string; fill: string; dot: string; text: string }> = {
  free: { label: "Available", fill: "#dcf3e3", dot: "#16a34a", text: "Free" },
  booked: { label: "Booked", fill: "#fbd9d6", dot: "#dc2626", text: "Booked" },
  pending: { label: "Pending approval", fill: "#fbe7c4", dot: "#d97706", text: "Pending" },
  ghost: { label: "Booked but empty", fill: "url(#ghost-hatch)", dot: "#dc2626", text: "Ghost" },
  inuse: { label: "Checked in · in use", fill: "#d6e4fb", dot: "#2563eb", text: "In use" },
  blackout: { label: "Blackout", fill: "#e5e7eb", dot: "#9ca3af", text: "Blackout" },
};

export const KIND_FILL: Partial<Record<RoomKind, string>> = {
  lh: "#e8d3e3",
  tutorial: "#e8d3e3",
  seminar: "#e8d3e3",
  lab: "#d3e0ec",
  study: "#d7e6cf",
  meeting: "#f1e0bf",
  office: "#f1e0bf",
  common: "#f1e0bf",
  medical: "#f1e0bf",
  wc: "#ffffff",
  stairs: "#ffffff",
  passage: "#e7e3dc",
  lobby: "#e7e3dc",
  shaft: "url(#shaft-hatch)",
  outdoor: "#eef3e9",
};

export function bookingsFor(s: EngineState, roomId: string, date: string): Booking[] {
  return s.bookings
    .filter((b) => b.date === date && b.roomIds.includes(roomId) && (HOLDING.includes(b.status) || b.status === "completed"))
    .sort((a, b) => a.start - b.start);
}

export function liveState(s: EngineState, roomId: string, date: string, min: number, today: string, nowMin: number): { state: LiveState; booking?: Booking } {
  const b = s.bookings.find((x) => x.date === date && x.roomIds.includes(roomId) && HOLDING.includes(x.status) && x.start <= min && min < x.end);
  if (b) {
    if (b.status === "pending_approval") return { state: "pending", booking: b };
    if (b.status === "checked_in") return { state: "inuse", booking: b };
    const isNowish = date === today && Math.abs(min - nowMin) <= 30;
    if (isNowish && nowMin >= b.start + CHECKIN_WINDOW && !b.checkedIn && (b.occupancy ?? 0) === 0) return { state: "ghost", booking: b };
    return { state: "booked", booking: b };
  }
  if (inBlackout(s, roomId, date, min)) return { state: "blackout" };
  return { state: "free" };
}

/** Free start times (30-min grid) where `dur` minutes fit, from `from` onward. */
export function freeSlots(s: EngineState, roomId: string, date: string, from: number, dur: number, limit = 8): number[] {
  const out: number[] = [];
  const day = bookingsFor(s, roomId, date).filter((b) => b.status !== "completed");
  for (let t = Math.ceil(from / 15) * 15; t + dur <= 20 * 60 && out.length < limit; t += 15) {
    if (t % 30 !== 0 && out.length) continue;
    if (!day.some((b) => b.start < t + dur && t < b.end) && !inBlackout(s, roomId, date, t)) out.push(t);
  }
  return out;
}
