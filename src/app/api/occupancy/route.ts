import { NextResponse } from "next/server";
import { z } from "zod";
import { ROOM_BY_ID } from "@/data/campus";
import { applyOp } from "@/lib/remote/ops";
import { SupabaseStorage } from "@/lib/remote/supabaseStorage";
import { nowMinutes, todayISO } from "@/lib/time";

/** Live occupancy ingestion (Wi-Fi density / motion). In-memory for the demo; occupancy_signals table in prod. */
const Signal = z.object({ roomId: z.string(), density: z.number().min(0).max(1), source: z.enum(["wifi", "motion", "simulator"]).default("simulator") });
const latest = new Map<string, z.infer<typeof Signal> & { at: number }>();

/** Sensor gateways authenticate with OCCUPANCY_TOKEN. With Supabase configured, signals land in the live map. */
export async function POST(req: Request) {
  const token = process.env.OCCUPANCY_TOKEN;
  if (token && req.headers.get("authorization") !== `Bearer ${token}`) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = z.union([Signal, z.array(Signal).max(200)]).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  const items = Array.isArray(body.data) ? body.data : [body.data];
  for (const s of items) if (ROOM_BY_ID.has(s.roomId)) latest.set(s.roomId, { ...s, at: Date.now() });
  if (process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
    const storage = new SupabaseStorage();
    const ctx = { today: todayISO(), nowMin: nowMinutes() };
    for (const s of items.filter((x) => ROOM_BY_ID.has(x.roomId)))
      await applyOp(storage, { type: "occupancy", roomId: s.roomId, density: s.density }, { name: `sensor:${s.source}`, role: "admin" }, ctx);
  }
  return NextResponse.json({ accepted: items.length });
}

export function GET() {
  return NextResponse.json(Object.fromEntries(latest));
}
