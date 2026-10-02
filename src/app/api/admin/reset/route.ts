import { NextResponse } from "next/server";
import { actorFrom } from "@/lib/remote/auth";
import { OpError } from "@/lib/remote/ops";
import { seedDatabase, serviceClient } from "@/lib/remote/supabaseStorage";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Digital Twin reset: restores the seeded schedule (admin only). */
export async function POST(req: Request) {
  try {
    const db = serviceClient();
    const actor = await actorFrom(req, db);
    if (actor.role !== "admin") throw new OpError(403, "Admin only.");
    const t = Date.now();
    const out = await seedDatabase(db);
    return NextResponse.json({ ...out, ms: Date.now() - t });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: e instanceof OpError ? e.status : 500 });
  }
}
