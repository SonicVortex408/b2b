import { NextResponse } from "next/server";
import { actorFrom } from "@/lib/remote/auth";
import { OpError } from "@/lib/remote/ops";
import { serviceClient } from "@/lib/remote/supabaseStorage";
import { feedSig } from "@/lib/server/feed";

export const dynamic = "force-dynamic";

/** Returns the caller's private, subscribable calendar URL (signed, no login needed by calendar apps). */
export async function GET(req: Request) {
  try {
    const actor = await actorFrom(req, serviceClient());
    const origin = new URL(req.url).origin;
    return NextResponse.json({ url: `${origin}/api/calendar?u=${encodeURIComponent(actor.name)}&sig=${feedSig(actor.name)}` });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: e instanceof OpError ? e.status : 500 });
  }
}
