"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Supabase mode turns on when both public env vars are present at build time. */
export const REMOTE = !!(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);

let client: SupabaseClient | null = null;
export function browserClient(): SupabaseClient {
  client ??= createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    realtime: { params: { eventsPerSecond: 10 } },
  });
  return client;
}
