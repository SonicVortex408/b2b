import { z } from "zod";
import { BOOKABLE_ROOMS } from "@/data/campus";
import { holdingConflicts, inBlackout, type EngineState } from "@/lib/engine";
import { addDays, fmt24, parse24, weekday } from "@/lib/time";
import type { Room } from "@/lib/types";

export const BookingIntent = z.object({
  intent: z.enum(["book", "search", "explain", "forecast"]),
  resource_type: z.enum(["lh", "lab", "tutorial", "seminar", "study", "meeting", "outdoor"]).nullable(),
  min_capacity: z.number().int().min(1).max(500).nullable(),
  tags: z.array(z.string()),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  window: z.tuple([z.string(), z.string()]),
  duration_minutes: z.number().int().min(15).max(600),
  purpose: z.enum(["exam", "academic_class", "faculty_event", "club_event", "casual"]),
  confidence: z.number().min(0).max(1),
  clarifying_question: z.string().nullable(),
});
export type BookingIntent = z.infer<typeof BookingIntent>;

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** Deterministic fallback parser. The LLM path produces the same validated shape. */
export function parseIntent(text: string, today: string, nowMin: number): BookingIntent {
  const t = text.toLowerCase();
  let confidence = 0.55;
  let resource_type: BookingIntent["resource_type"] = null;
  if (/seminar|auditorium|\bhall\b(?!.*lecture)/.test(t)) resource_type = "seminar";
  if (/lecture|classroom|\blh\b/.test(t)) resource_type = "lh";
  if (/\blabs?\b|computers?|pcs?\b/.test(t)) resource_type = "lab";
  if (/tutorial/.test(t)) resource_type = "tutorial";
  if (/library|study|quiet/.test(t)) resource_type = resource_type ?? "study";
  if (/meeting|conference/.test(t)) resource_type = "meeting";
  if (/turf|courtyard|cricket|football|outdoor/.test(t)) resource_type = "outdoor";
  if (resource_type) confidence += 0.15;

  const cap = t.match(/(\d{1,3})\s*(people|persons|students|seats|pax|of us|attendees)/) ?? t.match(/for\s+(\d{1,3})\b/);
  const min_capacity = cap ? Number(cap[1]) : null;
  if (min_capacity) confidence += 0.1;

  const tags: string[] = [];
  for (const [re, tag] of [
    [/projector/, "projector"],
    [/smart ?board/, "smart-board"],
    [/whiteboard/, "whiteboard"],
    [/dual ?monitor/, "dual-monitor"],
    [/quiet|silent/, "quiet"],
    [/gpu/, "gpu"],
    [/\btv\b/, "tv"],
    [/mic|sound|\bav\b/, "av"],
  ] as const)
    if (re.test(t)) tags.push(tag);

  let date = today;
  if (/tomorrow/.test(t)) date = addDays(today, 1);
  else {
    const di = DAYS.findIndex((d) => t.includes(d));
    if (di >= 0) {
      const delta = (di - weekday(today) + 7) % 7;
      date = addDays(today, delta === 0 && /next\s+\w+day/.test(t) ? 7 : delta);
    }
  }
  if (/today|tomorrow|now|\b(mon|tues|wednes|thurs|fri|satur|sun)day/.test(t)) confidence += 0.1;

  let window: [string, string] = [fmt24(Math.max(8 * 60, Math.ceil(nowMin / 30) * 30)), "20:00"];
  if (/morning/.test(t)) window = ["08:00", "12:00"];
  else if (/afternoon/.test(t)) window = ["12:00", "16:00"];
  else if (/evening/.test(t)) window = ["16:00", "20:00"];
  else if (/right now|\bnow\b/.test(t)) window = [fmt24(Math.ceil(nowMin / 15) * 15), "20:00"];
  const at = t.match(/(?:at|from)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);
  if (at) {
    let h = Number(at[1]);
    if (at[3] === "pm" && h < 12) h += 12;
    if (!at[3] && h < 8) h += 12;
    window = [fmt24(h * 60 + Number(at[2] ?? 0)), "20:00"];
    confidence += 0.05;
  }

  const dur = t.match(/(\d+(?:\.\d)?)\s*(h|hr|hrs|hour|hours)\b/);
  const duration_minutes = dur ? Math.round(Number(dur[1]) * 60) : /evening|event|talk|workshop/.test(t) ? 120 : 60;

  const purpose: BookingIntent["purpose"] = /exam|test|viva/.test(t)
    ? "exam"
    : /lecture|class|practical|lab session/.test(t)
      ? "academic_class"
      : /club|hackathon|workshop|event|meetup|fest/.test(t)
        ? "club_event"
        : /faculty|department|dept/.test(t)
          ? "faculty_event"
          : "casual";

  confidence = Math.min(0.97, confidence + (tags.length ? 0.05 : 0));
  return {
    intent: /why|explain|moved|bumped/.test(t) ? "explain" : /forecast|next week|look like|how busy|demand/.test(t) ? "forecast" : /find|search|show|any/.test(t) ? "search" : "book",
    resource_type,
    min_capacity,
    tags,
    date,
    window,
    duration_minutes,
    purpose,
    confidence: Math.round(confidence * 100) / 100,
    clarifying_question: /why|explain|moved|bumped|forecast|next week|look like|how busy|demand/.test(t) ? null : confidence < 0.8 ? (resource_type ? "How many people, and roughly what time?" : "What kind of room do you need: lecture hall, lab, tutorial room or the seminar hall?") : null,
  };
}

export interface Option {
  room: Room;
  date: string;
  start: number;
  end: number;
  score: number;
  why: string;
}

/** search_availability: rank rooms + earliest free slot inside the window. */
export function searchAvailability(s: EngineState, i: BookingIntent, limit = 3, now?: { today: string; nowMin: number }): Option[] {
  const searchIn = (st: EngineState, it: BookingIntent, date: string, [ws, we]: [number, number], note: string) =>
    searchDay(st, it, date, [date === now?.today ? Math.max(ws, Math.ceil(now.nowMin / 15) * 15) : ws, we], note);
  const exact = searchIn(s, i, i.date, i.window.map(parse24) as [number, number], "");
  if ((exact[0]?.score ?? 0) >= 70) return exact.slice(0, limit);
  // No strong fit in the requested window: also offer strong-fit rooms on the same day, then later days.
  for (let d = 0; d <= 3; d++) {
    const wider = searchIn(s, i, addDays(i.date, d), [8 * 60, 20 * 60], d === 0 ? "outside requested window" : `${d} day(s) later`);
    if ((wider[0]?.score ?? 0) < 70) continue;
    const seen = new Set(exact.map((o) => o.room.id));
    return [...exact, ...wider.filter((o) => !seen.has(o.room.id))].sort((a, b) => b.score - a.score).slice(0, limit);
  }
  return exact.slice(0, limit);
}

function searchDay(s: EngineState, i: BookingIntent, date: string, [ws, we]: [number, number], note: string): Option[] {
  const out: Option[] = [];
  for (const room of BOOKABLE_ROOMS) {
    if (i.min_capacity && (room.capacity ?? 0) < i.min_capacity) continue;
    let fit = 100;
    const reasons: string[] = [];
    if (i.resource_type && room.kind !== i.resource_type) fit -= 35;
    else if (i.resource_type) reasons.push("right type");
    const have = i.tags.filter((tag) => room.tags.includes(tag));
    fit -= (i.tags.length - have.length) * 20;
    if (have.length) reasons.push(have.join(", "));
    if (i.min_capacity && room.capacity) {
      const waste = (room.capacity - i.min_capacity) / room.capacity;
      fit -= Math.round(waste * 25);
      reasons.push(`seats ${room.capacity}`);
    }
    let found: number | null = null;
    for (let st = Math.ceil(ws / 15) * 15; st + i.duration_minutes <= we; st += 15) {
      if (!holdingConflicts(s, [room.id], date, st, st + i.duration_minutes).length && !inBlackout(s, room.id, date, st)) {
        found = st;
        break;
      }
    }
    if (found == null) continue;
    if (note) reasons.push(note);
    out.push({ room, date, start: found, end: found + i.duration_minutes, score: Math.max(0, fit), why: reasons.join(" · ") });
  }
  return out.sort((a, b) => b.score - a.score || a.start - b.start);
}
