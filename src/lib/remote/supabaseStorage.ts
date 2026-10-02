import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@supabase/supabase-js";
import { ALL_ROOMS } from "@/data/campus";
import type { EngineState } from "@/lib/engine";
import { seedState } from "@/lib/seed";
import { addDays, nowMinutes, todayISO } from "@/lib/time";
import { rowsToState, toTs, type BlackoutRow, type BookingRow, type Changes, type EventRow, type LedgerRow, type Rows, type WaitRow } from "./mapping";
import type { Storage } from "./ops";

export const DEMO_USERS = [
  { email: "student@xie.demo", full_name: "Demo Student", role: "student" },
  { email: "faculty@xie.demo", full_name: "Demo Faculty", role: "faculty" },
  { email: "approver@xie.demo", full_name: "Demo Approver", role: "approver", approver_pools: ["Computer HOD", "EXTC HOD", "Dean / Student Affairs", "Academic Office"] },
  { email: "admin@xie.demo", full_name: "Demo Admin", role: "admin" },
] as const;

export function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** PostgREST caps responses at 1000 rows; page through. */
async function all<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q(from, from + 999);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < 1000) return out;
  }
}

export async function loadRows(db: SupabaseClient, today = todayISO()): Promise<Rows> {
  const from = toTs(addDays(today, -14), 0);
  const to = toTs(addDays(today, 22), 0);
  const [bookings, events, ledger, waitlist, blackouts] = await Promise.all([
    all<BookingRow>((a, b) => db.from("bookings").select("*").gte("starts_at", from).lt("starts_at", to).order("id").range(a, b)),
    db.from("conflict_events").select("*").order("at", { ascending: false }).limit(200),
    db.from("fairness_ledger").select("*"),
    db.from("waitlist").select("*"),
    db.from("blackouts").select("*"),
  ]);
  for (const r of [events, ledger, waitlist, blackouts]) if (r.error) throw new Error(r.error.message);
  return {
    bookings,
    events: (events.data ?? []) as EventRow[],
    ledger: (ledger.data ?? []) as LedgerRow[],
    waitlist: (waitlist.data ?? []) as WaitRow[],
    blackouts: (blackouts.data ?? []) as BlackoutRow[],
  };
}

export class SupabaseStorage implements Storage {
  constructor(private db: SupabaseClient = serviceClient()) {}
  async load(): Promise<EngineState> {
    return rowsToState(await loadRows(this.db));
  }
  async apply(c: Changes) {
    const { data, error } = await this.db.rpc("apply_engine_changes", { changes: c });
    if (error) return { ok: false, code: error.code, detail: error.message };
    return data as { ok: boolean; code?: string; detail?: string };
  }
}

/** Static campus data + seeded schedule. Used by `npm run db:seed` and the admin Reset button. */
export async function seedDatabase(db: SupabaseClient, opts: { users?: boolean; password?: string } = {}) {
  const must = <T extends { error: { message: string } | null }>(r: T) => {
    if (r.error) throw new Error(r.error.message);
    return r;
  };
  must(await db.from("floors").upsert([1, 2, 3].map((id) => ({ id, name: ["First", "Second", "Third"][id - 1] + " Floor" }))));
  must(
    await db.from("resources").upsert(
      ALL_ROOMS.filter((r) => r.bookable).map((r) => ({
        id: r.id,
        name: r.name,
        type: r.kind,
        floor: r.floor,
        capacity: r.capacity ?? 0,
        capacity_verified: r.capacityVerified ?? true,
        tags: r.tags,
        svg_path_id: r.id,
        requires_approval: !!r.requiresApproval,
        approval_pool_id: r.pool ?? null,
      })),
    ),
  );

  // Clear dynamic state, then load the seeded two weeks + exam blackout.
  for (const t of ["bookings", "conflict_events", "waitlist", "fairness_ledger", "blackouts"]) must(await db.from(t).delete().neq(t === "fairness_ledger" ? "subject" : "id", "__none__"));
  const s = seedState(todayISO(), nowMinutes());
  const rows = s.bookings.flatMap((b) =>
    b.roomIds.map((resource_id) => ({
      id: b.id,
      resource_id,
      requester_name: b.requester,
      requester_role: b.role,
      club: b.club ?? null,
      starts_at: toTs(b.date, b.start),
      ends_at: toTs(b.date, b.end),
      title: b.title,
      purpose: b.purpose,
      priority_score: b.priority,
      status: b.status,
      attendee_count: b.attendees,
      checked_in: !!b.checkedIn,
      occupancy: b.occupancy ?? 0,
    })),
  );
  for (let i = 0; i < rows.length; i += 500) must(await db.from("bookings").insert(rows.slice(i, i + 500)));
  must(await db.from("blackouts").insert(s.blackouts.map((b) => ({ id: b.id, label: b.label, starts_at: toTs(b.date, b.start), ends_at: toTs(b.date, b.end), resource_ids: b.roomIds, allow: b.allow }))));
  const subjects = new Set([...Object.keys(s.bumps), ...Object.keys(s.points)]);
  must(await db.from("fairness_ledger").insert([...subjects].map((k) => ({ subject: k, bumps_suffered: s.bumps[k] ?? 0, points: s.points[k] ?? 0 }))));

  if (opts.users) {
    const password = opts.password ?? process.env.DEMO_PASSWORD ?? "xie-demo-2026";
    const { data: list } = await db.auth.admin.listUsers({ perPage: 200 });
    for (const u of DEMO_USERS) {
      let id = list?.users.find((x) => x.email === u.email)?.id;
      if (!id) {
        const { data, error } = await db.auth.admin.createUser({ email: u.email, password, email_confirm: true });
        if (error) throw new Error(`${u.email}: ${error.message}`);
        id = data.user.id;
      }
      must(await db.from("profiles").upsert({ id, full_name: u.full_name, role: u.role, approver_pools: "approver_pools" in u ? [...u.approver_pools] : [] }));
    }
  }
  return { bookings: s.bookings.length };
}
