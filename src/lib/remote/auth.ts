import type { SupabaseClient } from "@supabase/supabase-js";
import { OpError, type Actor } from "./ops";

/** Resolve the caller from their Supabase access token; role comes from profiles, never from the request body. */
export async function actorFrom(req: Request, db: SupabaseClient): Promise<Actor> {
  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new OpError(401, "Sign in to make changes.");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new OpError(401, "Session expired. Please sign in again.");
  const { data: profile } = await db.from("profiles").select("full_name, role").eq("id", data.user.id).single();
  if (!profile) throw new OpError(403, "No profile for this account.");
  return { id: data.user.id, name: profile.full_name, role: profile.role };
}
