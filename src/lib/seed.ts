import { BOOKABLE_ROOMS, FLOOR_2 } from "@/data/campus";
import type { EngineState } from "@/lib/engine";
import { addDays, DAY_END, DAY_START, weekday } from "@/lib/time";
import type { Booking, Purpose, Role, Room } from "@/lib/types";

/** Small deterministic PRNG so every reset produces the same campus. */
export function rng(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

export const FACULTY = ["Prof. Mehta", "Dr. D'Souza", "Prof. Iyer", "Dr. Fernandes", "Prof. Kulkarni", "Dr. Shaikh", "Prof. Rao"];
export const STUDENTS = ["Aarav", "Sana", "Riya", "Kabir", "Ishaan", "Meera", "Zoya", "Neil", "Tanvi", "Omkar"];
export const CLUBS = ["GDSC XIE", "IEEE XIE", "CSI-XIE", "Rotaract", "E-Cell", "XIE Dance Crew"];

const SUBJECTS: Record<string, string[]> = {
  lab: ["DBMS Practical", "OS Practical", "CN Practical", "Python Lab", "ML Lab", "DSP Practical", "Microcontroller Lab", "Web Tech Lab"],
  lh: ["Engineering Maths III", "Theory of Computation", "Signals & Systems", "Data Structures", "Discrete Maths", "Analog Circuits"],
  tutorial: ["Maths Tutorial", "DSA Doubt Session", "Mini-project sync"],
  seminar: ["Guest Lecture: GenAI in Industry", "Placement Talk", "Alumni Panel"],
  study: ["Group Study", "Exam Prep"],
  meeting: ["Dept. Meeting", "Project Review", "IQAC Meeting"],
  outdoor: ["Box Cricket", "Sports Practice"],
};
const DIVS = ["SE Comp A", "SE Comp B", "TE IT", "BE EXTC", "TE EXTC", "SE IT"];

function pick<T>(r: () => number, xs: T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

function makeBooking(r: () => number, room: Room, date: string, start: number, end: number, id: string): Booking {
  const clubby = r() < 0.18 && room.kind !== "lab";
  const facultyish = !clubby && r() < 0.75;
  const role: Role = clubby ? "student" : facultyish ? "faculty" : "student";
  const purpose: Purpose = clubby ? "club_event" : facultyish ? (room.kind === "meeting" ? "faculty_event" : "academic_class") : "casual";
  const title = clubby
    ? `${pick(r, ["Hack Night", "Workshop", "Core Meet", "Practice"])}`
    : `${pick(r, SUBJECTS[room.kind] ?? ["Session"])}${room.kind === "lab" || room.kind === "lh" ? ` · ${pick(r, DIVS)}` : ""}`;
  const club = clubby ? pick(r, CLUBS) : undefined;
  const requester = clubby ? `${pick(r, STUDENTS)} (${club})` : facultyish ? pick(r, FACULTY) : pick(r, STUDENTS);
  const cap = room.capacity ?? 30;
  return {
    id,
    roomIds: [room.id],
    date,
    start,
    end,
    title,
    requester,
    role,
    club,
    purpose,
    attendees: Math.max(4, Math.round(cap * (0.4 + r() * 0.55))),
    status: "confirmed",
    priority: 0,
    createdAt: Date.now(),
    occupancy: 0,
  };
}

/** Two weeks of history, today, and a week ahead; an exam blackout; a few clubs. */
export function seedState(today: string, nowMin: number): EngineState {
  const r = rng(408);
  const bookings: Booking[] = [];
  let seq = 0;
  for (let d = -14; d <= 7; d++) {
    const date = addDays(today, d);
    const wd = weekday(date);
    if (wd === 0) continue; // Sundays closed
    const density = wd === 6 ? 0.35 : 1;
    for (const room of BOOKABLE_ROOMS) {
      if (room.kind === "outdoor" && r() < 0.6) continue;
      let t = DAY_START + Math.floor(r() * 4) * 30;
      while (t < DAY_END - 60) {
        if (r() > 0.55 * density) {
          t += 60;
          continue;
        }
        const len = pick(r, room.kind === "lab" ? [120, 120, 60] : [60, 60, 90, 120]);
        const end = Math.min(DAY_END, t + len);
        const b = makeBooking(r, room, date, t, end, `seed-${(++seq).toString(36)}`);
        if (d < 0 || (d === 0 && end <= nowMin)) {
          b.status = r() < 0.08 ? "no_show" : "completed";
          b.checkedIn = b.status === "completed";
        } else if (d === 0 && t <= nowMin) {
          // in progress right now: most checked in, some ghosts
          const ghost = r() < 0.22;
          b.status = ghost ? "confirmed" : "checked_in";
          b.checkedIn = !ghost;
          b.occupancy = ghost ? 0 : 0.5 + r() * 0.5;
        } else if (b.role === "student" && room.requiresApproval && r() < 0.6) {
          b.status = "pending_approval";
        }
        b.priority = 40 + Math.round(r() * 40);
        bookings.push(b);
        t = end + Math.floor(r() * 3) * 30;
      }
    }
  }

  // Exam week blackout: second-floor lecture halls + seminar hall, day after tomorrow, morning.
  const examDate = addDays(today, 2);
  const examRooms = FLOOR_2.filter((x) => x.kind === "lh" || x.kind === "seminar").map((x) => x.id);
  const clear = bookings.filter((b) => !(b.date === examDate && examRooms.includes(b.roomIds[0]) && b.start < 13 * 60 && b.end > 9 * 60));
  ["F2-10", "F2-11", "F2-12"].forEach((roomId, i) =>
    clear.push({
      id: `seed-exam-${i}`,
      roomIds: [roomId],
      date: examDate,
      start: 9 * 60 + 30,
      end: 12 * 60 + 30,
      title: ["Exam: DBMS End-Sem", "Exam: Theory of Computation", "Exam: Engineering Maths III"][i],
      requester: "Exam Cell",
      role: "admin",
      purpose: "exam",
      attendees: 60,
      status: "confirmed",
      priority: 96,
      createdAt: Date.now(),
    }),
  );
  return {
    bookings: clear,
    events: [],
    bumps: { "GDSC XIE": 1, "XIE Dance Crew": 3, Rotaract: 2 },
    waitlist: [],
    blackouts: [{ id: "bo-1", label: "End-Sem exam blackout", date: examDate, start: 9 * 60, end: 13 * 60, roomIds: examRooms, allow: ["exam"] }],
    points: { "GDSC XIE": 120, "IEEE XIE": 95, "CSI-XIE": 80, Rotaract: 60, "E-Cell": 45, "XIE Dance Crew": 30 },
    seq: 1000,
  };
}
