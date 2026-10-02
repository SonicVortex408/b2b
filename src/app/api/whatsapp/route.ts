import { NextResponse } from "next/server";
import { BOOKABLE_ROOMS } from "@/data/campus";
import { parseIntent, searchAvailability } from "@/lib/intent";
import { seedState } from "@/lib/seed";
import { fmtTime, nowMinutes, todayISO } from "@/lib/time";

/** WhatsApp Cloud API webhook. Reuses the same intent parser + availability search as the web assistant. */
export function GET(req: Request) {
  const p = new URL(req.url).searchParams;
  if (p.get("hub.mode") === "subscribe" && p.get("hub.verify_token") === process.env.WHATSAPP_VERIFY_TOKEN) return new Response(p.get("hub.challenge"));
  return new Response("forbidden", { status: 403 });
}

export async function POST(req: Request) {
  const body = await req.json().catch(() => null);
  const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
  if (!msg?.text?.body) return NextResponse.json({ ok: true });
  const today = todayISO();
  const nowMin = nowMinutes();
  const intent = parseIntent(String(msg.text.body).slice(0, 500), today, nowMin);
  const options = searchAvailability(seedState(today, nowMin), intent, 3, { today, nowMin });
  const reply = intent.confidence < 0.8 && intent.clarifying_question
    ? intent.clarifying_question
    : options.length
      ? `Top options:\n${options.map((o, i) => `${i + 1}. ${o.room.name} (L${o.room.floor}, ${o.room.capacity} seats) ${o.date} ${fmtTime(o.start)}`).join("\n")}\nOpen XIE Spaces to confirm.`
      : `Nothing free that matches across ${BOOKABLE_ROOMS.length} rooms. Try another time.`;
  const token = process.env.WHATSAPP_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (token && phoneId)
    await fetch(`https://graph.facebook.com/v20.0/${phoneId}/messages`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: msg.from, text: { body: reply } }),
    }).catch(() => {});
  return NextResponse.json({ ok: true, reply });
}
