/**
 * Runs the real migration in PGlite (Postgres in WASM) and drives the server write path against it:
 * engine → diff → apply_engine_changes() → EXCLUDE constraint.
 */
import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { readdirSync, readFileSync } from "node:fs";
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
      docs: await q("select jsonb_build_object('kind', kind, 'id', id, 'data', data) j from engine_docs"),
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
  for (const f of readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(`supabase/migrations/${f}`, "utf8")
      .replace("create extension if not exists vector;", "") // pgvector isn't bundled with PGlite
      .replace("vector(1536)", "real[]");
    await db.exec(sql);
  }
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

  it("negotiation accept shifts the holder and books the requester atomically", async () => {
    const mk = (who: string, p: Partial<BookingRequest>) => applyOp(storage, { type: "book", req: req({ roomIds: ["F1-07"], start: 11 * 60, end: 12 * 60, attendees: 20, ...p }) }, { name: who, role: "faculty" }, ctx);
    await mk("Holder H", { purpose: "academic_class" });
    await mk("Asker A", { purpose: "academic_class" }); // equal priority -> negotiation
    const s = await storage.load();
    const neg = s.negotiations[0];
    expect(neg).toMatchObject({ holder: "Holder H", requester: "Asker A", status: "open" });
    expect(s.notices.some((n) => n.to === "Holder H" && n.kind === "negotiation")).toBe(true);
    await expect(applyOp(storage, { type: "neg_reply", id: neg.id, accept: true }, { name: "Asker A", role: "faculty" }, ctx)).rejects.toMatchObject({ status: 403 });
    const out = await applyOp(storage, { type: "neg_reply", id: neg.id, accept: true }, { name: "Holder H", role: "faculty" }, ctx);
    expect(out.message).toBe("Accepted");
    const rows = (await db.query<{ who: string; s: string; status: string }>("select requester_name who, to_char(starts_at at time zone 'Asia/Kolkata','HH24:MI') s, status::text from bookings where resource_id='F1-07' order by starts_at")).rows;
    expect(rows).toEqual([
      { who: "Asker A", s: "11:00", status: "confirmed" },
      { who: "Holder H", s: "12:00", status: "confirmed" },
    ]);
    expect((await storage.load()).negotiations[0].status).toBe("accepted");
  });

  it("swap marketplace hands a slot over in one write", async () => {
    const own = await applyOp(storage, { type: "book", req: req({ roomIds: ["F1-08"], start: 12 * 60, end: 13 * 60 }) }, faculty, ctx);
    const id = own.result!.ok ? own.result!.booking.id : "";
    await applyOp(storage, { type: "swap_list", bookingId: id }, faculty, ctx);
    const swap = (await storage.load()).swaps[0];
    const out = await applyOp(storage, { type: "swap_claim", id: swap.id }, { name: "Claimer C", role: "faculty" }, ctx);
    expect(out.message).toBe("Claimed");
    const rows = (await db.query<{ who: string; status: string }>("select requester_name who, status::text from bookings where resource_id='F1-08' order by created_at")).rows;
    expect(rows).toEqual([
      { who: "Demo Faculty", status: "cancelled" },
      { who: "Claimer C", status: "confirmed" },
    ]);
  });

  it("counter-proposal: approver offers a slot, requester accepts in one click", async () => {
    const r = await applyOp(storage, { type: "book", req: req({ roomIds: ["F1-10"], start: 13 * 60, end: 14 * 60, purpose: "casual" }) }, student, ctx);
    const id = r.result!.ok ? r.result!.booking.id : "";
    expect(r.result!.ok && r.result!.booking.status).toBe("pending_approval");
    await applyOp(storage, { type: "counter", bookingId: id, roomId: "F1-11", start: 15 * 60, end: 16 * 60 }, { name: "HOD", role: "approver" }, ctx);
    expect((await storage.load()).notices.find((n) => n.to === "Demo Student" && n.kind === "counter")).toBeTruthy();
    const out = await applyOp(storage, { type: "counter_reply", bookingId: id, accept: true }, student, ctx);
    expect(out.message).toBe("Accepted");
    const row = (await db.query<{ status: string }>("select status::text from bookings where resource_id='F1-11'")).rows[0];
    expect(row.status).toBe("confirmed");
  });

  it("soft-hold blocks others for 90 s; rules editor blackouts persist", async () => {
    await applyOp(storage, { type: "hold", roomIds: ["F1-05"], date: today, start: 18 * 60, end: 19 * 60 }, { name: "Holder", role: "faculty" }, ctx);
    const other = await applyOp(storage, { type: "book", req: req({ roomIds: ["F1-05"], start: 18 * 60, end: 19 * 60 }) }, faculty, ctx);
    expect(other.result?.ok).toBe(false);
    expect(other.result?.event.text).toMatch(/soft-hold/);
    const mine = await applyOp(storage, { type: "book", req: req({ roomIds: ["F1-05"], start: 18 * 60, end: 19 * 60 }) }, { name: "Holder", role: "faculty" }, ctx);
    expect(mine.result?.ok).toBe(true);
    expect((await storage.load()).holds).toHaveLength(0);

    await applyOp(storage, { type: "blackout_add", blackout: { label: "Viva week", date: today, start: 600, end: 720, roomIds: ["F1-04"], allow: ["exam"] } }, admin, ctx);
    const blocked = await applyOp(storage, { type: "book", req: req({ roomIds: ["F1-04"], start: 600, end: 660 }) }, faculty, ctx);
    expect(blocked.result?.event.text).toMatch(/Viva week/);
    const bo = (await storage.load()).blackouts.find((b) => b.label === "Viva week")!;
    expect(bo).toMatchObject({ date: today, start: 600, end: 720 });
    await applyOp(storage, { type: "blackout_remove", id: bo.id }, admin, ctx);
    expect((await storage.load()).blackouts.find((b) => b.label === "Viva week")).toBeUndefined();
  });
});
