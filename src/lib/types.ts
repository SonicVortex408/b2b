export type Role = "student" | "faculty" | "approver" | "admin";

export type RoomKind =
  | "lh"
  | "lab"
  | "tutorial"
  | "seminar"
  | "study"
  | "meeting"
  | "outdoor"
  // non-bookable context
  | "office"
  | "wc"
  | "stairs"
  | "passage"
  | "lobby"
  | "shaft"
  | "medical"
  | "common";

export type Purpose = "exam" | "academic_class" | "faculty_event" | "club_event" | "casual";

export type BookingStatus =
  | "pending_approval"
  | "confirmed"
  | "checked_in"
  | "completed"
  | "cancelled"
  | "no_show"
  | "bumped";

/** Statuses that hold a slot. Mirrors the Postgres EXCLUDE constraint's WHERE clause. */
export const HOLDING: BookingStatus[] = ["confirmed", "pending_approval", "checked_in"];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Room {
  id: string; // e.g. F2-10, or F1-LOBBY for non-bookable
  num?: number; // plan number
  name: string;
  short: string; // label drawn on the map
  kind: RoomKind;
  floor: 1 | 2 | 3;
  rect: Rect;
  bookable: boolean;
  capacity?: number;
  capacityVerified?: boolean;
  tags: string[];
  requiresApproval?: boolean;
  pool?: string;
  description?: string;
}

export interface Booking {
  id: string;
  roomIds: string[]; // multi-resource bundles are all-or-nothing
  date: string; // YYYY-MM-DD (Asia/Kolkata wall-clock)
  start: number; // minutes from midnight
  end: number;
  title: string;
  requester: string;
  role: Role;
  club?: string;
  purpose: Purpose;
  attendees: number;
  status: BookingStatus;
  priority: number;
  createdAt: number;
  checkedIn?: boolean;
  occupancy?: number; // simulated live occupancy 0..1
}

export interface ScoreBreakdown {
  purpose: number;
  role: number;
  urgency: number;
  fairness: number;
  usage: number;
  total: number;
}

export type DecisionKind =
  | "confirmed"
  | "pending"
  | "bumped"
  | "negotiate"
  | "share"
  | "rejected_rule"
  | "rejected_conflict"
  | "approved"
  | "rejected"
  | "escalated"
  | "released"
  | "no_show"
  | "promoted"
  | "checked_in";

export interface DecisionEvent {
  id: string;
  at: number;
  kind: DecisionKind;
  roomIds: string[];
  bookingId?: string;
  loserId?: string;
  text: string;
  winnerScore?: ScoreBreakdown;
  loserScore?: ScoreBreakdown;
}

export interface Alternative {
  roomId: string;
  date: string;
  start: number;
  end: number;
  disruption: number; // lower is better
  reason: string;
}

export interface BookingRequest {
  roomIds: string[];
  date: string;
  start: number;
  end: number;
  title: string;
  requester: string;
  role: Role;
  club?: string;
  purpose: Purpose;
  attendees: number;
}

export type BookResult =
  | { ok: true; booking: Booking; event: DecisionEvent; bumped?: Booking[] }
  | {
      ok: false;
      code: "RULE" | "23P01";
      event: DecisionEvent;
      alternatives: Alternative[];
      conflictWith?: Booking[];
      share?: { roomId: string; capacity: number; theirs: number; yours: number };
    };
