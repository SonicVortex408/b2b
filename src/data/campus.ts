import type { Rect, Room, RoomKind } from "@/lib/types";

/**
 * Hardcoded XIE campus (Mahim, Mumbai). Geometry is traced from the schematic floor plans.
 * Plan pixels run x 172→1480, y 215→1000; we subtract the origin so every floor shares
 * viewBox "0 0 1310 790". North = S.L. Raheja Marg (top), East = Mahim–Sion Link Road (right).
 */
export const VIEW_W = 1310;
export const VIEW_H = 790;

const r = (x1: number, y1: number, x2: number, y2: number): Rect => ({
  x: x1 - 172,
  y: y1 - 215,
  w: x2 - x1,
  h: y2 - y1,
});

/** Inner courtyard void (open to sky, turf below). Same on every floor. */
export const COURTYARD = r(537, 437, 1180, 1000);

const TAGS: Partial<Record<RoomKind, string[]>> = {
  lh: ["bench-seating", "smart-board", "classroom"],
  lab: ["computers", "fixed-seating", "lab"],
  tutorial: ["bench-seating", "whiteboard", "small"],
  seminar: ["projector", "av", "stage", "mic"],
  study: ["quiet", "study", "wifi"],
  meeting: ["tv", "whiteboard", "meeting"],
  outdoor: ["outdoor", "turf", "sports"],
};

const POOL: Record<number, string> = { 1: "Computer HOD", 2: "Computer HOD", 3: "EXTC HOD" };

type Def = [
  num: number | null,
  name: string,
  short: string,
  kind: RoomKind,
  rect: Rect,
  capacity?: number,
  verified?: boolean,
  extraTags?: string[],
];

const BOOKABLE: RoomKind[] = ["lh", "lab", "tutorial", "seminar", "study", "meeting", "outdoor"];

function build(floor: 1 | 2 | 3, defs: Def[]): Room[] {
  return defs.map(([num, name, short, kind, rect, capacity, verified = true, extra = []]) => {
    const bookable = BOOKABLE.includes(kind);
    const id =
      num != null ? `F${floor}-${String(num).padStart(2, "0")}` : `F${floor}-${short.toUpperCase().replace(/\W+/g, "")}`;
    const requiresApproval = kind === "lab" || kind === "lh" || kind === "seminar" || kind === "outdoor";
    return {
      id,
      num: num ?? undefined,
      name,
      short,
      kind,
      floor,
      rect,
      bookable,
      capacity,
      capacityVerified: verified,
      tags: [...(TAGS[kind] ?? []), ...extra],
      requiresApproval: bookable ? requiresApproval : undefined,
      pool: bookable
        ? kind === "lab"
          ? POOL[floor]
          : kind === "seminar" || kind === "outdoor"
            ? "Dean / Student Affairs"
            : kind === "lh"
              ? "Academic Office"
              : undefined
        : undefined,
    };
  });
}

const N = 220; // north strip top
const S = 352; // north strip bottom

export const FLOOR_1 = build(1, [
  [13, "Library", "Library", "study", r(178, N, 733, S), 50, true, ["books", "silent"]],
  [null, "Lobby", "Lobby", "lobby", r(737, N, 928, S)],
  [12, "Computer Dept. HOD Cabin", "HOD Cabin", "office", r(932, N, 1013, S)],
  [11, "Web Design Lab", "Web Design", "lab", r(1016, N, 1085, S), 25, false],
  [10, "Image Processing Lab", "Image Proc.", "lab", r(1088, N, 1157, S), 25, true, ["gpu"]],
  [9, "Database Lab", "Database", "lab", r(1160, N, 1241, S), 25],
  [8, "Operating System Lab", "OS Lab", "lab", r(1244, N, 1339, S), 25],
  [7, "Software Lab", "Software", "lab", r(1342, N, 1475, S), 25],
  [14, "Conference Room", "Conference", "meeting", r(178, 356, 316, 528), 8, true, ["quiet", "projector"]],
  [15, "Dean's Cabin", "Dean's Cabin", "office", r(178, 532, 329, 790)],
  [16, "Passage to X-Tech Building", "Passage to X-Tech", "passage", r(178, 884, 393, 997)],
  [17, "Staircase", "Staircase", "stairs", r(397, 819, 535, 997)],
  [6, "Men's Washroom", "Men's WC", "wc", r(1388, 356, 1475, 554)],
  [5, "Network Lab", "Network Lab", "lab", r(1297, 558, 1475, 665), 25],
  [4, "Project Lab", "Project Lab", "lab", r(1297, 669, 1475, 770), 25, true, ["whiteboard"]],
  [3, "SPA Lab", "SPA Lab", "lab", r(1297, 773, 1475, 828), 30],
  [1, "Computer Centre", "Computer Centre", "lab", r(1297, 832, 1475, 997), 75, true, ["projector", "dual-monitor"]],
  [2, "Passage", "Passage", "passage", r(1182, 780, 1293, 997)],
]);

export const FLOOR_2 = build(2, [
  [12, "Lecture Hall 4", "LH 4", "lh", r(178, N, 352, S), 75],
  [11, "Lecture Hall 3", "LH 3", "lh", r(356, N, 491, S), 75],
  [10, "Lecture Hall 2", "LH 2", "lh", r(495, N, 603, S), 75],
  [9, "Girls' Common Room", "Girls' Common", "common", r(607, N, 733, S)],
  [null, "Lobby", "Lobby", "lobby", r(737, N, 928, S)],
  [null, "Hatched shaft / void", "Shaft", "shaft", r(932, N, 1013, S)],
  [8, "Data Science Lab", "Data Sci.", "lab", r(1016, N, 1091, S), 25, true, ["gpu", "dual-monitor"]],
  [7, "Cloud Computing Lab", "Cloud", "lab", r(1095, N, 1164, S), 25],
  [6, "Internet Programming Lab", "Internet Prog.", "lab", r(1167, N, 1241, S), 25],
  [5, "Computer Network Lab", "Comp. Network", "lab", r(1244, N, 1359, S), 25],
  [4, "Database Lab", "Database", "lab", r(1362, N, 1475, S), 25],
  [13, "Men's Washroom", "Men's WC", "wc", r(178, 356, 250, 561)],
  [14, "Medical Room", "Medical", "medical", r(253, 473, 323, 561)],
  [15, "Lecture Hall 5", "LH 5", "lh", r(178, 565, 336, 835), 75],
  [16, "Staircase", "Staircase", "stairs", r(397, 838, 535, 997)],
  [3, "Ladies' Washroom", "Ladies' WC", "wc", r(1401, 356, 1475, 580)],
  [2, "Advanced Technology Lab", "Adv. Tech Lab", "lab", r(1310, 584, 1475, 803), 25, true, ["iot", "quiet"]],
  [1, "Seminar Hall", "Seminar Hall", "seminar", r(1182, 807, 1475, 997), 100],
]);

export const FLOOR_3 = build(3, [
  [16, "Lecture Hall 9", "LH 9", "lh", r(178, N, 352, S), 75, false],
  [15, "Lecture Hall 8", "LH 8", "lh", r(356, N, 491, S), 75, false],
  [14, "Lecture Hall 7", "LH 7", "lh", r(495, N, 603, S), 75, false],
  [13, "Lecture Hall 6", "LH 6", "lh", r(607, N, 733, S), 75, false],
  [null, "Lobby", "Lobby", "lobby", r(737, N, 928, S)],
  [12, "EXTC HOD Cabin", "EXTC HOD", "office", r(932, N, 1013, S)],
  [11, "Microprocessor & Embedded Systems Lab", "Microproc.", "lab", r(1016, N, 1091, S), 25],
  [10, "Signal Processing Lab", "Signal Proc.", "lab", r(1095, N, 1164, S), 25],
  [9, "Analog Electronics Lab", "Analog", "lab", r(1167, N, 1241, S), 25, true, ["oscilloscopes"]],
  [8, "Digital System Design Lab", "Digital Sys.", "lab", r(1244, N, 1359, S), 25, true, ["fpga"]],
  [7, "Antenna & Microwave Lab", "Antenna", "lab", r(1362, N, 1475, S), 25],
  [17, "Ladies' Washroom", "Ladies' WC", "wc", r(178, 356, 250, 561)],
  [18, "Lecture Hall 10", "LH 10", "lh", r(178, 565, 336, 842), 75, false],
  [19, "Staircase", "Staircase", "stairs", r(397, 845, 535, 997)],
  [6, "Gents' Washroom", "Gents' WC", "wc", r(1401, 356, 1475, 463)],
  [5, "Communication Lab", "Comm. Lab", "lab", r(1401, 467, 1475, 587), 25],
  [4, "Tutorial Room 1", "Tutorial 1", "tutorial", r(1310, 591, 1475, 659), 20],
  [3, "Tutorial Room 2", "Tutorial 2", "tutorial", r(1310, 663, 1475, 745), 20],
  [2, "Tutorial Room 3", "Tutorial 3", "tutorial", r(1310, 748, 1475, 808), 20, false],
  [1, "AutoCAD Lab", "AutoCAD Lab", "lab", r(1182, 812, 1475, 997), 40, false, ["dual-monitor", "cad"]],
]);

/** Outdoor turf courtyard (PadelPro Club on Maps). Bookable from any floor view, approval required. */
export const COURT_TURF: Room = {
  id: "COURT-TURF",
  name: "Courtyard Turf",
  short: "Open Courtyard",
  kind: "outdoor",
  floor: 1,
  rect: COURTYARD,
  bookable: true,
  capacity: 120,
  capacityVerified: false,
  tags: TAGS.outdoor ?? [],
  requiresApproval: true,
  pool: "Dean / Student Affairs",
  description: "Turf ground below, open to sky. Approval from Dean / Student Affairs required.",
};

export const FLOORS: Record<1 | 2 | 3, Room[]> = { 1: FLOOR_1, 2: FLOOR_2, 3: FLOOR_3 };

export const ALL_ROOMS: Room[] = [...FLOOR_1, ...FLOOR_2, ...FLOOR_3, COURT_TURF];
export const BOOKABLE_ROOMS = ALL_ROOMS.filter((r) => r.bookable);
export const ROOM_BY_ID = new Map(ALL_ROOMS.map((r) => [r.id, r]));

export const KIND_LABEL: Record<RoomKind, string> = {
  lh: "Lecture hall",
  lab: "Lab",
  tutorial: "Tutorial room",
  seminar: "Seminar hall",
  study: "Library",
  meeting: "Meeting room",
  outdoor: "Outdoor",
  office: "Office",
  wc: "Washroom",
  stairs: "Staircase",
  passage: "Passage",
  lobby: "Lobby",
  shaft: "Shaft / void",
  medical: "Medical room",
  common: "Common room",
};

export function describe(room: Room): string {
  if (room.description) return room.description;
  switch (room.kind) {
    case "lh":
      return `Classroom with bench seating and a digital Smart Board, seats ${room.capacity}.`;
    case "lab":
      return `Fixed seating with a computer per seat for ${room.capacity}. Managed by the ${room.pool}.`;
    case "tutorial":
      return `Small tutorial room with bench seating for ${room.capacity}. Instant booking for everyone.`;
    case "seminar":
      return `Large hall with projector and AV for ${room.capacity}. Approval from Dean / Student Affairs.`;
    case "study":
      return `Quiet study space with ${room.capacity} seats overlooking S.L. Raheja Marg.`;
    case "meeting":
      return `Conference room for ${room.capacity} with a TV and whiteboard.`;
    default:
      return "";
  }
}
