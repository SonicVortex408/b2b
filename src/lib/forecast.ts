import { BOOKABLE_ROOMS } from "@/data/campus";
import type { EngineState } from "@/lib/engine";
import { addDays, DAY_END, DAY_START, weekday } from "@/lib/time";
import type { RoomKind } from "@/lib/types";

export interface Forecast {
  kind: RoomKind;
  nextWeekAvg: number; // 0..1
  days: { date: string; utilisation: number }[];
}

/**
 * Same model as the solver's /forecast: weekday-seasonal mean of the last 14 days, a short trend term,
 * and a bump on exam-blackout days. Simple on purpose (spec allows LightGBM/Prophet).
 */
export function forecast(s: EngineState, today: string, kinds: RoomKind[] = ["lab", "lh", "tutorial", "seminar", "study"]): Forecast[] {
  const span = DAY_END - DAY_START;
  return kinds.map((kind) => {
    const rooms = BOOKABLE_ROOMS.filter((r) => r.kind === kind).map((r) => r.id);
    const util = (date: string) => {
      const mins = s.bookings.filter((b) => b.date === date && b.status !== "cancelled" && b.status !== "bumped" && b.roomIds.some((r) => rooms.includes(r))).reduce((m, b) => m + (b.end - b.start), 0);
      return rooms.length ? Math.min(1, mins / (rooms.length * span)) : 0;
    };
    const hist = Array.from({ length: 14 }, (_, i) => addDays(today, -14 + i)).filter((d) => weekday(d) !== 0);
    const byWd = new Map<number, number[]>();
    for (const d of hist) byWd.set(weekday(d), [...(byWd.get(weekday(d)) ?? []), util(d)]);
    const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const recent = mean(hist.slice(-5).map(util));
    const older = mean(hist.slice(-10, -5).map(util));
    const trend = (recent - older) / 5;
    const exam = new Set(s.blackouts.filter((b) => b.allow.includes("exam")).map((b) => b.date));
    const days = Array.from({ length: 7 }, (_, i) => addDays(today, i + 1))
      .filter((d) => weekday(d) !== 0)
      .map((d, i) => ({ date: d, utilisation: Math.round(Math.min(1, Math.max(0, mean(byWd.get(weekday(d)) ?? [recent]) + trend * (i + 1) + (exam.has(d) ? 0.15 : 0))) * 100) / 100 }));
    return { kind, nextWeekAvg: Math.round(mean(days.map((d) => d.utilisation)) * 100) / 100, days };
  });
}
