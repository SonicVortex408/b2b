/**
 * Every state change in XIE Spaces is an Action. The browser (demo mode) and the server (Supabase mode)
 * run the same `authorize` + `runAction`, so rules and permissions can't drift between the two.
 */
import * as E from "@/lib/engine";
import type { BookingRequest, BookResult, Role } from "@/lib/types";

export type ActKind = "approve" | "reject" | "cancel" | "release" | "checkin" | "noshow" | "escalate";

export type Action =
  | { type: "book"; req: BookingRequest; asAgent?: boolean }
  | { type: "waitlist"; req: BookingRequest }
  | { type: "act"; kind: ActKind; id: string }
  | { type: "sweep" }
  | { type: "hold"; roomIds: string[]; date: string; start: number; end: number }
  | { type: "unhold" }
  | { type: "neg_msg"; id: string; text: string }
  | { type: "neg_reply"; id: string; accept: boolean }
  | { type: "swap_list"; bookingId: string }
  | { type: "swap_withdraw"; id: string }
  | { type: "swap_claim"; id: string }
  | { type: "counter"; bookingId: string; roomId: string; start: number; end: number }
  | { type: "counter_reply"; bookingId: string; accept: boolean }
  | { type: "claim_free"; noticeId: string }
  | { type: "occupancy_sim" }
  | { type: "occupancy"; roomId: string; density: number }
  | { type: "blackout_add"; blackout: Omit<E.Blackout, "id"> }
  | { type: "blackout_remove"; id: string };

export interface Actor {
  id?: string;
  name: string;
  role: Role;
}

export class ActionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const deny = (msg: string, status = 403) => {
  throw new ActionError(status, msg);
};
const isStaff = (a: Actor) => a.role === "approver" || a.role === "admin";

/** Role/ownership checks. The client's claimed requester/role is never trusted. Returns the action to run. */
export function authorize(action: Action, actor: Actor, s: E.EngineState): Action {
  switch (action.type) {
    case "book":
      if (action.asAgent) {
        if (actor.role !== "admin") deny("Only admins can submit on behalf of others (Simulate Chaos).");
        return action;
      }
      return { ...action, req: { ...action.req, requester: actor.name, role: actor.role } };
    case "waitlist":
      return { ...action, req: { ...action.req, requester: actor.name, role: actor.role } };
    case "act": {
      const b = s.bookings.find((x) => x.id === action.id);
      if (!b) deny("Booking not found.", 404);
      if (action.kind === "approve" || action.kind === "reject" || action.kind === "escalate") {
        if (!isStaff(actor)) deny("Approver role required.");
      } else if (b!.requester !== actor.name && actor.role !== "admin") deny("You can only change your own bookings.");
      return action;
    }
    case "neg_msg":
    case "neg_reply": {
      const n = s.negotiations.find((x) => x.id === action.id);
      if (!n) deny("Negotiation not found.", 404);
      const party = actor.name === n!.holder || actor.name === n!.requester;
      if (action.type === "neg_reply" && actor.name !== n!.holder && actor.role !== "admin") deny("Only the current holder (or an admin) can accept or decline.");
      if (action.type === "neg_msg" && !party && actor.role !== "admin") deny("You're not part of this negotiation.");
      return action;
    }
    case "swap_list": {
      const b = s.bookings.find((x) => x.id === action.bookingId);
      if (!b || (b.requester !== actor.name && actor.role !== "admin")) deny("You can only list your own bookings.");
      return action;
    }
    case "swap_withdraw": {
      const w = s.swaps.find((x) => x.id === action.id);
      if (!w || (w.owner !== actor.name && actor.role !== "admin")) deny("Not your listing.");
      return action;
    }
    case "counter":
      if (!isStaff(actor)) deny("Approver role required.");
      return action;
    case "counter_reply": {
      const b = s.bookings.find((x) => x.id === action.bookingId);
      if (!b || (b.requester !== actor.name && actor.role !== "admin")) deny("This offer isn't for you.");
      return action;
    }
    case "occupancy_sim":
    case "blackout_add":
    case "blackout_remove":
      if (actor.role !== "admin" && !(actor.role === "approver" && action.type !== "occupancy_sim")) deny("Admin role required.");
      return action;
    case "occupancy":
      if (actor.role !== "admin") deny("Admin or sensor gateway only.");
      return action;
    default:
      return action;
  }
}

export interface ActionOutput {
  result?: BookResult;
  message?: string;
}

export function runAction(s: E.EngineState, a: Action, actor: Actor, ctx: E.RuleContext): ActionOutput {
  switch (a.type) {
    case "book":
      return { result: E.bookResources(s, a.req, ctx) };
    case "waitlist":
      E.joinWaitlist(s, a.req);
      return {};
    case "sweep":
      E.sweepNoShows(s, ctx);
      E.escalateNegotiations(s, 10 * 60 * 1000); // demo SLA: 10 min (spec: X hours via Inngest)
      s.holds = s.holds.filter((h) => h.expires > Date.now());
      return {};
    case "act":
      if (a.kind === "approve") E.approve(s, a.id, actor.name);
      if (a.kind === "reject") E.reject(s, a.id, actor.name, "Not available for this purpose.", ctx);
      if (a.kind === "cancel") E.cancel(s, a.id, ctx);
      if (a.kind === "release") E.releaseEarly(s, a.id, ctx);
      if (a.kind === "checkin") E.checkIn(s, a.id);
      if (a.kind === "noshow") E.markNoShow(s, a.id, ctx);
      if (a.kind === "escalate") E.escalate(s, a.id);
      return {};
    case "hold":
      return { message: E.placeHold(s, { roomIds: a.roomIds, date: a.date, start: a.start, end: a.end, by: actor.name }) ?? undefined };
    case "unhold":
      E.releaseHold(s, actor.name);
      return {};
    case "neg_msg":
      E.negotiationMessage(s, a.id, actor.name, a.text);
      return {};
    case "neg_reply":
      return { message: E.negotiationReply(s, a.id, a.accept, ctx) };
    case "swap_list":
      E.listSwap(s, a.bookingId, actor.name);
      return {};
    case "swap_withdraw":
      E.withdrawSwap(s, a.id);
      return {};
    case "swap_claim":
      return { message: E.claimSwap(s, a.id, actor, ctx) };
    case "counter":
      E.counterPropose(s, a.bookingId, actor.name, a.roomId, a.start, a.end);
      return {};
    case "counter_reply":
      return { message: E.counterReply(s, a.bookingId, a.accept, ctx) };
    case "claim_free":
      return { message: E.claimFree(s, a.noticeId, actor, ctx) };
    case "occupancy_sim":
      E.simulateOccupancy(s, ctx);
      return {};
    case "occupancy":
      E.setOccupancy(s, a.roomId, a.density);
      return {};
    case "blackout_add":
      E.addBlackout(s, a.blackout);
      return {};
    case "blackout_remove":
      E.removeBlackout(s, a.id);
      return {};
  }
}
