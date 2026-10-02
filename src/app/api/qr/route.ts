import { NextResponse } from "next/server";
import { z } from "zod";
import { ROOM_BY_ID } from "@/data/campus";
import { issueQr, verifyQr } from "@/lib/server/qr";

/** GET ?room=F1-05 → current rotating token for the door display. */
export function GET(req: Request) {
  const room = new URL(req.url).searchParams.get("room") ?? "";
  if (!ROOM_BY_ID.get(room)?.bookable) return NextResponse.json({ error: "Unknown room" }, { status: 404 });
  return NextResponse.json(issueQr(room));
}

/** POST {token, room} → verifies a scanned token. The client then checks in its booking. */
export async function POST(req: Request) {
  const body = z.object({ token: z.string().max(1000), room: z.string() }).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ ok: false, reason: "bad request" }, { status: 400 });
  const res = verifyQr(body.data.token, body.data.room);
  return NextResponse.json(res, { status: res.ok ? 200 : 401 });
}
