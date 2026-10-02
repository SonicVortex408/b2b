import { NextResponse } from "next/server";
import { z } from "zod";
import { actorFrom } from "@/lib/remote/auth";
import { OpError } from "@/lib/remote/ops";
import { serviceClient } from "@/lib/remote/supabaseStorage";

export const dynamic = "force-dynamic";

async function admin(req: Request) {
  const db = serviceClient();
  const actor = await actorFrom(req, db);
  if (actor.role !== "admin") throw new OpError(403, "Admin only.");
  return db;
}

const fail = (e: unknown) => NextResponse.json({ error: (e as Error).message }, { status: e instanceof OpError ? e.status : 500 });

/** Role assignment (admin). */
export async function GET(req: Request) {
  try {
    const db = await admin(req);
    const [{ data: profiles, error }, { data: auth }] = await Promise.all([db.from("profiles").select("id, full_name, role").order("full_name"), db.auth.admin.listUsers({ perPage: 500 })]);
    if (error) throw new Error(error.message);
    const email = new Map(auth?.users.map((u) => [u.id, u.email]) ?? []);
    return NextResponse.json({ users: (profiles ?? []).map((p) => ({ ...p, email: email.get(p.id) ?? "" })) });
  } catch (e) {
    return fail(e);
  }
}

export async function PATCH(req: Request) {
  try {
    const db = await admin(req);
    const body = z.object({ id: z.string().uuid(), role: z.enum(["student", "faculty", "approver", "admin"]) }).parse(await req.json());
    const { error } = await db.from("profiles").update({ role: body.role }).eq("id", body.id);
    if (error) throw new Error(error.message);
    await db.from("audit_log").insert({ actor: "admin", action: "role_change", payload: body });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
