export const DAY_START = 8 * 60; // 08:00
export const DAY_END = 20 * 60; // 20:00
export const TZ = "Asia/Kolkata";

export const pad = (n: number) => String(n).padStart(2, "0");

/** Today's date in Asia/Kolkata as YYYY-MM-DD. */
export function todayISO(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return parts;
}

/** Minutes since midnight in Asia/Kolkata. */
export function nowMinutes(now = new Date()): number {
  const [h, m] = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false })
    .format(now)
    .split(":")
    .map(Number);
  return (h % 24) * 60 + m;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

export function weekday(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

export function fmtTime(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h >= 12 ? "PM" : "AM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${pad(m)} ${ampm}`;
}

export function fmt24(min: number): string {
  return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
}

export function parse24(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return h * 60 + (m || 0);
}

export function fmtDate(date: string, opts: Intl.DateTimeFormatOptions = { weekday: "long", month: "long", day: "numeric" }): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-IN", { ...opts, timeZone: "UTC" });
}

export const overlaps = (aS: number, aE: number, bS: number, bE: number) => aS < bE && bS < aE;
