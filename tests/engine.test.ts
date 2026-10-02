import { describe, expect, it } from "vitest";
import { BOOKABLE_ROOMS, FLOOR_1, FLOOR_2, FLOOR_3 } from "@/data/campus";
import * as E from "@/lib/engine";
import { parseIntent, searchAvailability } from "@/lib/intent";
import { seedState } from "@/lib/seed";
import { addDays } from "@/lib/time";
import type { BookingRequest } from "@/lib/types";

const today = "2026-10-05"; // a Monday
const ctx = { today, nowMin: 9 * 60 };
const empty = (): E.EngineState => E.withDefaults({});
const req = (p: Partial<BookingRequest> = {}): BookingRequest => ({
  roomIds: ["F1-14"],
  date: today,
  start: 14 * 60,
  end: 15 * 60,
  title: "t",
  requester: "x",
  role: "faculty",
  purpose: "academic_class",
  attendees: 6,
  ...p,
});

describe("campus", () => {
  it("has every Section 2 room on the right floor", () => {
    const ids = (f: typeof FLOOR_1) => f.filter((r) => r.bookable).map((r) => r.id).sort();
    expect(ids(FLOOR_1)).toEqual(["F1-01", "F1-03", "F1-04", "F1-05", "F1-07", "F1-08", "F1-09", "F1-10", "F1-11", "F1-13", "F1-14"].sort());
    expect(ids(FLOOR_2)).toEqual(["F2-01", "F2-02", "F2-04", "F2-05", "F2-06", "F2-07", "F2-08", "F2-10", "F2-11", "F2-12", "F2-15"].sort());
    expect(ids(FLOOR_3)).toEqual(["F3-01", "F3-02", "F3-03", "F3-04", "F3-05", "F3-07", "F3-08", "F3-09", "F3-10", "F3-11", "F3-13", "F3-14", "F3-15", "F3-16", "F3-18"].sort());
  });
});

describe("double-booking guard", () => {
  it("200 parallel bookings at one room/slot: exactly one winner", async () => {
    const s = empty();
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => Promise.resolve().then(() => E.bookResources(s, req({ requester: `u${i}` }), ctx))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(E.countDoubleBookings(s)).toBe(0);
  });

  it("insertGuarded throws 23P01 on overlap", () => {
    const s = empty();
    E.bookResources(s, req(), ctx);
    const b = { ...s.bookings[0], id: "dup" };
    expect(() => E.insertGuarded(s, b)).toThrowError(E.ExclusionViolation);
  });
});

describe("conflict engine", () => {
  it("exam bumps a club booking, loser gets explanation + fairness ledger update", () => {
    const s = empty();
    E.bookResources(s, req({ roomIds: ["F2-10"], role: "student", purpose: "club_event", club: "GDSC XIE", attendees: 40 }), ctx);
    const r = E.bookResources(s, req({ roomIds: ["F2-10"], role: "admin", purpose: "exam", title: "DBMS End-Sem", attendees: 60 }), ctx);
    expect(r.ok && r.bumped?.length).toBe(1);
    expect(s.bumps["GDSC XIE"]).toBe(1);
    expect(s.events.find((e) => e.kind === "bumped")?.text).toMatch(/moved because Exam/);
    expect(E.countDoubleBookings(s)).toBe(0);
  });

  it("student lab request goes to pending approval; approval confirms", () => {
    const s = empty();
    const r = E.bookResources(s, req({ roomIds: ["F1-09"], role: "student", purpose: "casual", start: 10 * 60, end: 11 * 60 }), ctx);
    expect(r.ok && r.booking.status).toBe("pending_approval");
    if (r.ok) E.approve(s, r.booking.id, "HOD");
    expect(s.bookings[0].status).toBe("confirmed");
  });

  it("no-show releases the slot and promotes the waitlist", () => {
    const s = empty();
    const r = E.bookResources(s, req({ start: 9 * 60, end: 10 * 60 }), ctx);
    E.joinWaitlist(s, req({ start: 9 * 60, end: 10 * 60, requester: "next" }));
    if (r.ok) E.markNoShow(s, r.booking.id, { today, nowMin: 9 * 60 + 5 });
    expect(s.bookings.find((b) => b.requester === "next")?.status).toBe("confirmed");
  });

  it("exam blackout rule blocks non-exam bookings", () => {
    const s = seedState(today, 9 * 60);
    const bo = s.blackouts[0];
    const r = E.bookResources(s, req({ roomIds: [bo.roomIds[0]], date: bo.date, start: bo.start, end: bo.start + 60, purpose: "club_event" }), ctx);
    expect(!r.ok && r.code).toBe("RULE");
  });
});

describe("assistant", () => {
  it("'hall for 80 people with a projector this Friday evening' → Seminar Hall first", () => {
    const i = parseIntent("I need a hall for 80 people with a projector this Friday evening", today, 9 * 60);
    expect(i.confidence).toBeGreaterThanOrEqual(0.8);
    expect(i.date).toBe(addDays(today, 4));
    const opts = searchAvailability(empty(), i);
    expect(opts[0].room.id).toBe("F2-01");
    // Fully booked evening still surfaces the Seminar Hall at the nearest free time.
    const s = empty();
    E.bookResources(s, req({ roomIds: ["F2-01"], date: i.date, start: 16 * 60, end: 20 * 60, role: "admin", attendees: 90 }), ctx);
    expect(searchAvailability(s, i)[0].room.id).toBe("F2-01");
  });

  it("'this Friday' on a Friday means today", () => {
    expect(parseIntent("hall this friday evening", "2026-10-02", 600).date).toBe("2026-10-02");
    expect(parseIntent("hall next friday", "2026-10-02", 600).date).toBe("2026-10-09");
  });
});

describe("seed", () => {
  it("seeds without double bookings", () => {
    const s = seedState(today, 11 * 60);
    expect(s.bookings.length).toBeGreaterThan(BOOKABLE_ROOMS.length * 10);
    expect(E.countDoubleBookings(s)).toBe(0);
  });
});

describe("collaboration features", () => {
  it("previewBooking explains the outcome without changing state", () => {
    const s = empty();
    E.bookResources(s, req({ roomIds: ["F2-10"], role: "student", purpose: "club_event", club: "GDSC XIE", attendees: 40 }), ctx);
    const before = JSON.stringify(s);
    const p = E.previewBooking(s, req({ roomIds: ["F2-10"], role: "admin", purpose: "exam", attendees: 60 }), ctx);
    expect(p.decision).toBe("bump");
    expect(p.theirs?.total).toBeLessThan(p.mine.total);
    expect(JSON.stringify(s)).toBe(before);
    expect(E.previewBooking(s, req({ roomIds: ["F1-14"], start: 16 * 60, end: 17 * 60 }), ctx).decision).toBe("confirm");
  });

  it("release early broadcasts a claimable 'room free now' notice", () => {
    const s = empty();
    const r = E.bookResources(s, req({ start: 9 * 60, end: 12 * 60 }), ctx);
    if (r.ok) E.checkIn(s, r.booking.id);
    if (r.ok) E.releaseEarly(s, r.booking.id, { today, nowMin: 10 * 60 });
    const n = s.notices.find((x) => x.kind === "free")!;
    expect(n.free).toMatchObject({ roomId: "F1-14", start: 600, end: 720 });
    expect(E.claimFree(s, n.id, { name: "Neighbour", role: "student" }, { today, nowMin: 10 * 60 + 5 })).toBe("Claimed");
    expect(E.claimFree(s, n.id, { name: "Late", role: "student" }, { today, nowMin: 10 * 60 + 6 })).toMatch(/already claimed/);
    expect(E.countDoubleBookings(s)).toBe(0);
  });

  it("negotiations escalate when unanswered", () => {
    const s = empty();
    E.bookResources(s, req({ attendees: 8 }), ctx);
    E.bookResources(s, req({ requester: "other", attendees: 8 }), ctx); // conference room seats 8 → no share, equal-ish priority
    expect(s.negotiations).toHaveLength(1);
    s.negotiations[0].at -= 11 * 60 * 1000;
    E.escalateNegotiations(s, 10 * 60 * 1000);
    expect(s.negotiations[0].status).toBe("escalated");
    expect(s.notices.some((n) => n.to === "role:admin")).toBe(true);
  });

  it("assistant understands explain and forecast questions", () => {
    expect(parseIntent("why was my booking moved?", today, 600).intent).toBe("explain");
    expect(parseIntent("what will labs look like next week", today, 600)).toMatchObject({ intent: "forecast", resource_type: "lab" });
  });
});
