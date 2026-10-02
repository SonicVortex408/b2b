import { ROOM_BY_ID } from "@/data/campus";
import { SupabaseStorage } from "@/lib/remote/supabaseStorage";
import { feedSig } from "@/lib/server/feed";
import { pad } from "@/lib/time";
import { HOLDING } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Per-user subscribable iCalendar feed: /api/calendar?u=<name>&sig=<hmac> */
export async function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  const user = p.get("u") ?? "";
  if (!user || p.get("sig") !== feedSig(user)) return new Response("forbidden", { status: 403 });
  const s = await new SupabaseStorage().load();
  const t = (date: string, m: number) => `${date.replace(/-/g, "")}T${pad(Math.floor(m / 60))}${pad(m % 60)}00`;
  const esc = (v: string) => v.replace(/[\\,;]/g, (c) => `\\${c}`);
  const events = s.bookings
    .filter((b) => b.requester === user && (HOLDING.includes(b.status) || b.status === "completed"))
    .map((b) =>
      [
        "BEGIN:VEVENT",
        `UID:${b.id}@xie-spaces`,
        `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`,
        `DTSTART;TZID=Asia/Kolkata:${t(b.date, b.start)}`,
        `DTEND;TZID=Asia/Kolkata:${t(b.date, b.end)}`,
        `SUMMARY:${esc(b.title)}${b.status === "pending_approval" ? " (pending)" : ""}`,
        `LOCATION:${esc(b.roomIds.map((id) => ROOM_BY_ID.get(id)?.name ?? id).join(" + "))}\\, Xavier Institute of Engineering`,
        `STATUS:${b.status === "pending_approval" ? "TENTATIVE" : "CONFIRMED"}`,
        "END:VEVENT",
      ].join("\r\n"),
    );
  const body = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//XIE Spaces//EN", `X-WR-CALNAME:XIE Spaces · ${esc(user)}`, "X-WR-TIMEZONE:Asia/Kolkata", ...events, "END:VCALENDAR"].join("\r\n");
  return new Response(body, { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "no-store" } });
}
