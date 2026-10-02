import { NextResponse } from "next/server";
import { z } from "zod";
import { ROOM_BY_ID } from "@/data/campus";

/** Live occupancy ingestion (Wi-Fi density / motion). In-memory for the demo; occupancy_signals table in prod. */
const Signal = z.object({ roomId: z.string(), density: z.number().min(0).max(1), source: z.enum(["wifi", "motion", "simulator"]).default("simulator") });
const latest = new Map<string, z.infer<typeof Signal> & { at: number }>();

export async function POST(req: Request) {
  const body = z.union([Signal, z.array(Signal).max(200)]).safeParse(await req.json().catch(() => null));
  if (!body.success) return NextResponse.json({ error: body.error.flatten() }, { status: 400 });
  const items = Array.isArray(body.data) ? body.data : [body.data];
  for (const s of items) if (ROOM_BY_ID.has(s.roomId)) latest.set(s.roomId, { ...s, at: Date.now() });
  return NextResponse.json({ accepted: items.length });
}

export function GET() {
  return NextResponse.json(Object.fromEntries(latest));
}
