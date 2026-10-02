/**
 * Server-side operations. Load → run the same engine as the browser → diff → apply_engine_changes()
 * (transactional, guarded by the EXCLUDE constraint). A 23P01 means someone else won the race; we
 * reload and let the engine decide again (bump / negotiate / alternatives).
 */
import * as E from "@/lib/engine";
import type { BookingRequest, BookResult, Role } from "@/lib/types";
import { diff, isEmpty, type Changes } from "./mapping";

export type ActKind = "approve" | "reject" | "cancel" | "release" | "checkin" | "noshow" | "escalate";

export type Op =
  | { type: "book"; req: BookingRequest; asAgent?: boolean }
  | { type: "waitlist"; req: BookingRequest }
  | { type: "act"; kind: ActKind; id: string }
  | { type: "sweep" };

export interface Actor {
  id?: string;
  name: string;
  role: Role;
}

export interface Storage {
  load(): Promise<E.EngineState>;
  apply(c: Changes): Promise<{ ok: boolean; code?: string; detail?: string }>;
}

export class OpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface OpResult {
  result?: BookResult;
  text?: string;
  attempts: number;
}

/** Role/ownership checks. The client's claimed requester/role is never trusted. */
function authorize(op: Op, actor: Actor, s: E.EngineState): Op {
  if (op.type === "book" || op.type === "waitlist") {
    if (op.type === "book" && op.asAgent) {
      if (actor.role !== "admin") throw new OpError(403, "Only admins can submit on behalf of others (Simulate Chaos).");
      return op;
    }
    return { ...op, req: { ...op.req, requester: actor.name, role: actor.role } };
  }
  if (op.type === "act") {
    const b = s.bookings.find((x) => x.id === op.id);
    if (!b) throw new OpError(404, "Booking not found.");
    if (op.kind === "approve" || op.kind === "reject" || op.kind === "escalate") {
      if (actor.role !== "approver" && actor.role !== "admin") throw new OpError(403, "Approver role required.");
    } else if (b.requester !== actor.name && actor.role !== "admin") throw new OpError(403, "You can only change your own bookings.");
  }
  return op;
}

function run(s: E.EngineState, op: Op, actor: Actor, ctx: E.RuleContext): BookResult | undefined {
  switch (op.type) {
    case "book":
      return E.bookResources(s, op.req, ctx);
    case "waitlist":
      E.joinWaitlist(s, op.req);
      return;
    case "sweep":
      E.sweepNoShows(s, ctx);
      return;
    case "act":
      if (op.kind === "approve") E.approve(s, op.id, actor.name);
      if (op.kind === "reject") E.reject(s, op.id, actor.name, "Not available for this purpose.", ctx);
      if (op.kind === "cancel") E.cancel(s, op.id, ctx);
      if (op.kind === "release") E.releaseEarly(s, op.id, ctx);
      if (op.kind === "checkin") E.checkIn(s, op.id);
      if (op.kind === "noshow") E.markNoShow(s, op.id, ctx);
      if (op.kind === "escalate") E.escalate(s, op.id);
      return;
  }
}

export async function applyOp(storage: Storage, op: Op, actor: Actor, ctx: E.RuleContext, maxAttempts = 3): Promise<OpResult> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const s = await storage.load();
    const allowed = authorize(op, actor, s);
    const before = structuredClone(s);
    const result = run(s, allowed, actor, ctx);
    const changes = diff(before, s, actor.name, actor.id);
    if (isEmpty(changes)) return { result, text: s.events[0]?.text, attempts: attempt };
    const res = await storage.apply(changes);
    if (res.ok) return { result, text: s.events[0]?.text, attempts: attempt };
    if (res.code !== "23P01") throw new OpError(500, res.detail ?? "Database error");
    // Lost a race: another request took the slot between our load and our write. Re-decide.
  }
  throw new OpError(409, "The room was taken by concurrent requests; please retry.");
}
