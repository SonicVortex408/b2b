import { NextResponse } from "next/server";
import { z } from "zod";
import { actorFrom } from "@/lib/remote/auth";
import { rowsToState } from "@/lib/remote/mapping";
import { applyOp, OpError, type Op } from "@/lib/remote/ops";
import { loadRows, serviceClient, SupabaseStorage } from "@/lib/remote/supabaseStorage";
import { nowMinutes, todayISO } from "@/lib/time";

export const dynamic = "force-dynamic";

const Req = z.object({
  roomIds: z.array(z.string()).min(1).max(4),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  start: z.number().int().min(0).max(1440),
  end: z.number().int().min(0).max(1440),
  title: z.string().min(1).max(120),
  requester: z.string().max(80).default(""),
  role: z.enum(["student", "faculty", "approver", "admin"]).default("student"),
  club: z.string().max(60).optional(),
  purpose: z.enum(["exam", "academic_class", "faculty_event", "club_event", "casual"]),
  attendees: z.number().int().min(1).max(500),
});
const OpSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("book"), req: Req, asAgent: z.boolean().optional() }),
  z.object({ type: z.literal("waitlist"), req: Req }),
  z.object({ type: z.literal("act"), kind: z.enum(["approve", "reject", "cancel", "release", "checkin", "noshow", "escalate"]), id: z.string().max(80) }),
  z.object({ type: z.literal("sweep") }),
]);

/** Live state for the map (public read, same as RLS). */
export async function GET() {
  try {
    return NextResponse.json(rowsToState(await loadRows(serviceClient())));
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const parsed = OpSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid operation" }, { status: 400 });
  try {
    const db = serviceClient();
    const actor = parsed.data.type === "sweep" ? { name: "system", role: "admin" as const } : await actorFrom(req, db);
    const out = await applyOp(new SupabaseStorage(db), parsed.data as Op, actor, { today: todayISO(), nowMin: nowMinutes() });
    return NextResponse.json(out);
  } catch (e) {
    const status = e instanceof OpError ? e.status : 500;
    return NextResponse.json({ error: (e as Error).message }, { status });
  }
}
