/**
 * Runs the real migration in PGlite (Postgres in WASM) and drives the server write path against it:
 * engine → diff → apply_engine_changes() → EXCLUDE constraint.
 */
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { ALL_ROOMS } from "@/data/campus";
import type { EngineState } from "@/lib/engine";
import { rowsToState, toTs, type Changes, type Rows } from "@/lib/remote/mapping";
import { applyOp, OpError, type Actor, type Storage } from "@/lib/remote/ops";
import type { BookingRequest } from "@/lib/types";

const today = "2026-10-05";
const ctx = { today, nowMin: 9 * 60 };
let db: PGlite;

class PgliteStorage implements Storage {
  async load(): Promise<EngineState> {
    const q = async <T,>(sql: string) => (await db.query<{ j: T }>(sql)).rows.map((r) => r.j);
    const rows: Rows = {
      bookings: await q("select to_jsonb(b) j from bookings b order by id"),
      events: await q("select to_jsonb(e) j from conflict_events e order by at desc limit 200"),
      ledger: await q("select to_jsonb(l) j from fairness_ledger l"),
      waitlist: await q("select to_jsonb(w) j from waitlist w"),
      blackouts: await q("select to_jsonb(b) j from blackouts b"),
    };
    return rowsToState(rows);
  }
  async apply(c: Changes) {
    const r = await db.query<{ r: { ok: boolean; code?: string } }>("select apply_engine_changes($1::jsonb) r", [JSON.stringify(c)]);
    return r.rows[0].r;
  }
}

const storage = new PgliteStorage();
const student: Actor = { name: "Demo Student", role: "student" };
const faculty: Actor = { name: "Demo Faculty", role: "faculty" };
const admin: Actor = { name: "Exam Cell", role: "admin" };
const req = (p: Partial<BookingRequest> = {}): BookingRequest => ({
  roomIds: ["F1-14"],
  date: today,
  start: 14 * 60,
  end: 15 * 60,
  title: "t",
  requester: "ignored",
  role: "admin",
  purpose: "academic_class",
  attendees: 6,
  ...p,
});
const holding = async (room: string) =>
  (await db.query<{ n: number }>(`select count(*)::int n from bookings where resource_id = $1 and status in ('confirmed','pending_approval','checked_in')`, [room])).rows[0].n;

beforeAll(async () => {
  db = new PGlite({ extensions: { btree_gist } });
  // Stand-ins for what Supabase provides.
  await db.exec(`
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql as 'select null::uuid';
    create role anon; create role authenticated;
  `);
  const sql = readFileSync("supabase/migrations/0001_init.sql", "utf8")
    .replace("create extension if not exists vector;", "") // pgvector isn't bundled with PGlite
    .replace("vector(1536)", "real[]");
  await db.exec(sql);
  await db.exec(`insert into floors values (1,'First'),(2,'Second'),(3,'Third');`);
  for (const r of ALL_ROOMS.filter((x) => x.bookable))
    await db.query("insert into resources (id,name,type,floor,capacity,svg_path_id,requires_approval) values ($1,$2,$3,$4,$5,$1,$6)", [r.id, r.name, r.kind, r.floor, r.capacity ?? 0, !!r.requiresApproval]);
}, 60_000);

describe("database write path", () => {
  it("round-trips a booking through Postgres with IST times", async () => {
    const out = await applyOp(storage, { type: "book", req: req({ start: 10 * 60, end: 11 * 60 + 30 }) }, faculty, ctx);
    expect(out.result?.ok).toBe(true);
    const row = (await db.query<{ s: string; who: string; role: string }>("select to_char(starts_at at time zone 'Asia/Kolkata','HH24:MI') s, requester_name who, requester_role::text role from bookings")).rows[0];
    expect(row).toEqual({ s: "10:00", who: "Demo Faculty", role: "faculty" }); // requester/role from the actor, not the body
    const s = await storage.load();
    expect(s.bookings[0]).toMatchObject({ date: today, start: 600, end: 690 });
    expect(s.events[0].kind).toBe("confirmed");
  });

  it("the EXCLUDE constraint rejects an overlapping insert that bypasses the engine", async () => {
    const c: Changes = {
      actor: "x",
      updates: [],
      inserts: [{ id: "rogue", resource_ids: ["F1-14"], requester_name: "x", requester_role: "student", starts_at: toTs(today, 630), ends_at: toTs(today, 660), title: "t", purpose: "casual", priority: 0, status: "confirmed", attendees: 2 }],
      events: [],
      ledger: [],
      waitlist_add: [],
      waitlist_remove: [],
    };
    expect(await storage.apply(c)).toMatchObject({ ok: false, code: "23P01" });
  });

  it("200 concurrent bookings for one room/slot: exactly one holds it", async () => {
    const results = await Promise.all(
      Array.from({ length: 200 }, (_, i) => applyOp(storage, { type: "book", req: req({ roomIds: ["F1-13"], start: 16 * 60, end: 17 * 60 }) }, { name: `S${i}`, role: "student" }, ctx).catch((e) => e)),
    );
    expect(await holding("F1-13")).toBe(1);
    expect(results.filter((r) => !(r instanceof Error) && r.result?.ok)).toHaveLength(1);
    expect(results.filter((r) => r instanceof Error).every((e) => e instanceof OpError && e.status === 409)).toBe(true);
  }, 60_000);

  it("exam bumps a club booking atomically and updates the fairness ledger", async () => {
    await applyOp(storage, { type: "book", req: req({ roomIds: ["F2-10"], purpose: "club_event", club: "GDSC XIE", attendees: 40 }) }, student, ctx);
    const out = await applyOp(storage, { type: "book", req: req({ roomIds: ["F2-10"], purpose: "exam", title: "DBMS End-Sem", attendees: 60 }) }, admin, ctx);
    expect(out.result?.ok && out.result.bumped?.length).toBe(1);
    const statuses = (await db.query<{ status: string }>("select status::text from bookings where resource_id='F2-10' order by created_at")).rows.map((r) => r.status);
    expect(statuses).toEqual(["bumped", "confirmed"]);
    expect((await db.query<{ n: number }>("select bumps_suffered n from fairness_ledger where subject='GDSC XIE'")).rows[0].n).toBe(1);
  });

  it("enforces roles and ownership server-side", async () => {
    const s = await storage.load();
    const pending = s.bookings.find((b) => b.status === "bumped")!;
    await expect(applyOp(storage, { type: "act", kind: "approve", id: pending.id }, student, ctx)).rejects.toMatchObject({ status: 403 });
    const mine = s.bookings.find((b) => b.requester === "Demo Faculty")!;
    await expect(applyOp(storage, { type: "act", kind: "cancel", id: mine.id }, student, ctx)).rejects.toMatchObject({ status: 403 });
    await expect(applyOp(storage, { type: "book", req: req(), asAgent: true }, faculty, ctx)).rejects.toMatchObject({ status: 403 });
  });

  it("no-show releases the slot and promotes the waitlist in one transaction", async () => {
    const out = await applyOp(storage, { type: "book", req: req({ roomIds: ["F1-09"], start: 9 * 60, end: 10 * 60 }) }, faculty, ctx);
    await applyOp(storage, { type: "waitlist", req: req({ roomIds: ["F1-09"], start: 9 * 60, end: 10 * 60 }) }, { name: "Next Person", role: "faculty" }, ctx);
    expect((await db.query("select * from waitlist")).rows).toHaveLength(1);
    await applyOp(storage, { type: "act", kind: "noshow", id: out.result!.ok ? out.result!.booking.id : "" }, admin, { today, nowMin: 9 * 60 + 15 });
    const rows = (await db.query<{ who: string; status: string }>("select requester_name who, status::text from bookings where resource_id='F1-09' order by created_at")).rows;
    expect(rows).toEqual([
      { who: "Demo Faculty", status: "no_show" },
      { who: "Next Person", status: "confirmed" },
    ]);
    expect((await db.query("select * from waitlist")).rows).toHaveLength(0);
  });
});
