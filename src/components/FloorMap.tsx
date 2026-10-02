"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { useMemo, useRef } from "react";
import { COURT_TURF, COURTYARD, FLOORS, VIEW_H, VIEW_W } from "@/data/campus";
import { fmtTime } from "@/lib/time";
import { KIND_FILL, liveState, STATE_META, type LiveState } from "@/lib/status";
import type { Room } from "@/lib/types";
import { useStore } from "@/store/useStore";

gsap.registerPlugin(useGSAP);

const TONE: Record<string, string> = { ok: "#16a34a", warn: "#d97706", bad: "#dc2626", info: "#2563eb" };

const pathOf = ({ x, y, w, h }: Room["rect"]) => `M${x} ${y}h${w}v${h}h${-w}Z`;

function wrap(text: string, maxChars: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

interface Props {
  onSelect: (room: Room, el: Element) => void;
  selected: string | null;
  mini?: { floor: 1 | 2 | 3; highlight: string };
}

export function FloorMap({ onSelect, selected, mini }: Props) {
  const engine = useStore((s) => s.engine);
  const storeFloor = useStore((s) => s.floor);
  const date = useStore((s) => s.date);
  const time = useStore((s) => s.time);
  const today = useStore((s) => s.today);
  const nowMin = useStore((s) => s.nowMin);
  const colorMode = useStore((s) => s.colorMode);
  const filters = useStore((s) => s.filters);
  const flashes = useStore((s) => s.flashes);
  const floor = mini?.floor ?? storeFloor;
  const rooms = FLOORS[floor];
  const svgRef = useRef<SVGSVGElement>(null);

  const states = useMemo(() => {
    const m = new Map<string, { state: LiveState; label?: string }>();
    for (const room of [...rooms, COURT_TURF]) {
      if (!room.bookable) continue;
      const ls = liveState(engine, room.id, date, time, today, nowMin);
      m.set(room.id, { state: ls.state, label: ls.booking ? `until ${fmtTime(ls.booking.end)}` : undefined });
    }
    return m;
  }, [engine, rooms, date, time, today, nowMin]);

  useGSAP(
    () => {
      if (mini || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      gsap.from(".room", { opacity: 0, y: 10, duration: 0.4, stagger: 0.012, ease: "power2.out" });
    },
    { scope: svgRef, dependencies: [floor], revertOnUpdate: true },
  );

  const matches = (room: Room) => {
    if (!room.bookable) return true;
    if (filters.minCap && (room.capacity ?? 0) < filters.minCap) return false;
    if (filters.tag && !room.tags.includes(filters.tag)) return false;
    if (filters.kind && room.kind !== filters.kind) return false;
    return true;
  };

  const fillFor = (room: Room) => {
    if (mini) return room.id === mini.highlight ? "#1d4ed8" : (KIND_FILL[room.kind] ?? "#fff");
    if (!room.bookable || colorMode === "type") return KIND_FILL[room.kind] ?? "#fff";
    return STATE_META[states.get(room.id)?.state ?? "free"].fill;
  };

  const activate = (room: Room, e: React.SyntheticEvent) => {
    if (!room.bookable || mini) return;
    const el = (e.currentTarget as Element).querySelector(".room-shape") ?? e.currentTarget;
    onSelect(room, el);
  };

  const court = states.get(COURT_TURF.id);
  const C = COURTYARD;

  return (
    <svg
      ref={svgRef}
      viewBox={mini ? `-8 -8 ${VIEW_W + 16} ${VIEW_H + 16}` : `-120 -14 ${VIEW_W + 140} ${VIEW_H + 28}`}
      className="h-full w-full select-none"
      role="group"
      aria-label={`Floor ${floor} plan`}
    >
      <defs>
        <pattern id="ghost-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="10" height="10" fill="#fdecea" />
          <line x1="0" y1="0" x2="0" y2="10" stroke="#dc2626" strokeWidth="3" opacity="0.55" />
        </pattern>
        <pattern id="shaft-hatch" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="14" height="14" fill="#fff" />
          <line x1="0" y1="0" x2="0" y2="14" stroke="#1f2933" strokeWidth="2" />
        </pattern>
        <pattern id="stair-lines" width="10" height="22" patternUnits="userSpaceOnUse">
          <rect width="10" height="22" fill="#fff" />
          <line x1="0" y1="21" x2="10" y2="21" stroke="#1f2933" strokeWidth="2" />
        </pattern>
      </defs>

      {/* shell + corridor ring */}
      <rect x={0} y={0} width={VIEW_W} height={VIEW_H} fill="#e7e3dc" stroke="#1f2933" strokeWidth={10} />

      {/* courtyard void (bottom edge open) */}
      <g
        className={`room ${!mini && !matches(COURT_TURF) ? "dimmed" : ""}`}
        data-room-id={COURT_TURF.id}
        role={mini ? undefined : "button"}
        tabIndex={mini ? -1 : 0}
        aria-label={`Courtyard turf, ${STATE_META[court?.state ?? "free"].label}`}
        onClick={(e) => activate(COURT_TURF, e)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), activate(COURT_TURF, e))}
      >
        <path
          className="room-shape"
          data-room-id={COURT_TURF.id}
          d={`M${C.x} ${C.y + C.h + 8}V${C.y}H${C.x + C.w}V${C.y + C.h + 8}Z`}
          fill={mini ? "#eef3e9" : colorMode === "state" && court && court.state !== "free" ? STATE_META[court.state].fill : "#eef3e9"}
          stroke="#1f2933"
          strokeWidth={10}
        />
        <rect x={C.x + 20} y={C.y + 20} width={C.w - 40} height={C.h - 20} fill="none" stroke="#6b8f5e" strokeDasharray="6 5" strokeWidth={1.5} />
        {!mini && (
          <>
            <text x={C.x + C.w / 2} y={C.y + C.h / 2 - 6} textAnchor="middle" fontSize={17} fontWeight={700} letterSpacing={2} fill="#3f5a36">
              OPEN COURTYARD
            </text>
            <text x={C.x + C.w / 2} y={C.y + C.h / 2 + 18} textAnchor="middle" fontSize={15} fill="#4d6b43">
              Turf ground below · open to sky
            </text>
            <VacancyButton x={C.x + C.w / 2} y={C.y + C.h / 2 + 52} state={court?.state ?? "free"} wide label={court?.label} />
          </>
        )}
      </g>

      {!mini && (
        <g fontFamily="var(--font-mono)" fontSize={12} letterSpacing={3} fill="#6b7280">
          <text x={510} y={180}>CORRIDOR</text>
          <text x={floor === 1 ? 225 : 228} y={floor === 1 ? 405 : 431}>CORRIDOR</text>
          <text x={1040} y={392}>CORR.</text>
          {floor !== 1 && <text x={76} y={708}>CORRIDOR</text>}
        </g>
      )}

      {rooms.map((room) => {
        const { x, y, w, h } = room.rect;
        const cx = x + w / 2;
        const cy = y + h / 2;
        const st = states.get(room.id);
        const isSel = selected === room.id;
        const fl = flashes[room.id];
        const fresh = fl && Date.now() - fl.at < 1500;
        const short = h < 75;
        const narrow = w < 100;
        const lines = short ? [] : wrap(room.short, narrow ? 9 : 16);
        const fill = room.kind === "stairs" && floor !== 1 ? "url(#stair-lines)" : fillFor(room);
        const textFill = mini && room.id === mini.highlight ? "#fff" : "#1f2933";
        return (
          <g
            key={room.id}
            className={`room ${!room.bookable ? "pointer-events-none" : ""} ${!mini && !matches(room) ? "dimmed" : ""}`}
            data-room-id={room.id}
            role={room.bookable && !mini ? "button" : undefined}
            tabIndex={room.bookable && !mini ? 0 : -1}
            aria-label={room.bookable ? `${room.name}, ${room.capacity} seats, ${STATE_META[st?.state ?? "free"].label}` : room.name}
            aria-pressed={room.bookable ? isSel : undefined}
            onClick={(e) => activate(room, e)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), activate(room, e))}
          >
            <path
              className="room-shape"
              data-room-id={room.id}
              d={pathOf(room.rect)}
              fill={fill}
              stroke={isSel ? "#1d4ed8" : "#1f2933"}
              strokeWidth={isSel ? 5 : 3}
              opacity={!room.bookable && !mini && room.kind !== "stairs" && room.kind !== "wc" ? 0.92 : 1}
            />
            {fresh && <path key={fl.at} className="room-flash" d={pathOf(room.rect)} fill={TONE[fl.tone]} />}
            {!mini && (
              <g pointerEvents="none" fill={textFill} textAnchor="middle">
                {short ? (
                  <text x={room.bookable ? cx - 12 : cx} y={cy + 5} fontSize={14}>
                    <tspan fontWeight={700}>{room.num} </tspan>
                    {room.short}
                    {room.capacity ? ` · ${room.capacity}` : ""}
                  </text>
                ) : (
                  <StackedLabel room={room} lines={lines} narrow={narrow} cx={cx} />
                )}
              </g>
            )}
            {!mini && room.bookable && (
              <VacancyButton
                x={short ? x + w - 18 : cx}
                y={short ? cy : y + h - (narrow ? 20 : 24)}
                state={st?.state ?? "free"}
                wide={w >= 150 && !short}
                maxW={w - 10}
                label={st?.label}
              />
            )}
          </g>
        );
      })}

      {!mini && floor === 1 && (
        <g fill="#b45309" fontSize={13}>
          <text x={-60} y={688} textAnchor="middle">
            to X-Tech
          </text>
          <text x={-60} y={704} textAnchor="middle">
            building
          </text>
          <path d="M-8 726H-108" stroke="#b45309" strokeWidth={2} />
          <path d="M-108 726l9-5v10z" />
        </g>
      )}
    </svg>
  );
}

/** Number, wrapped name and capacity, vertically centred in the space left above the vacancy button. */
function StackedLabel({ room, lines, narrow, cx }: { room: Room; lines: string[]; narrow: boolean; cx: number }) {
  const big = room.id === "F1-13" || room.id === "F2-01";
  const numSize = big ? 24 : narrow ? 17 : 19;
  const nameSize = big ? 17 : narrow ? 11.5 : 13;
  const lh = nameSize * 1.25;
  const rows: { text: string; size: number; weight?: number; fill?: string }[] = [];
  if (room.num != null) rows.push({ text: String(room.num), size: numSize, weight: 700 });
  lines.forEach((t) => rows.push({ text: t, size: nameSize }));
  if (room.capacity != null) rows.push({ text: `${narrow ? room.capacity : `${room.capacity} seats`}${room.capacityVerified ? "" : "*"}`, size: nameSize, fill: "#4b5563" });
  const heights = rows.map((r, i) => (i === 0 && room.num != null ? numSize + 4 : lh));
  const total = heights.reduce((a, b) => a + b, 0);
  const { y, h } = room.rect;
  const reserve = room.bookable ? (narrow ? 34 : 44) : 0;
  let cursor = y + Math.max(4, (h - reserve - total) / 2);
  return (
    <>
      {rows.map((r, i) => {
        const baseline = cursor + r.size * 0.85;
        cursor += heights[i];
        return (
          <text key={i} x={cx} y={baseline} fontSize={r.size} fontWeight={r.weight} fill={r.fill}>
            {r.text}
          </text>
        );
      })}
    </>
  );
}

/** Skedda-style vacancy button mounted on each bookable room. */
function VacancyButton({ x, y, state, wide, label, maxW = 400 }: { x: number; y: number; state: LiveState; wide?: boolean; label?: string; maxW?: number }) {
  const meta = STATE_META[state];
  if (wide) {
    const long = state === "free" ? "Available" : `${meta.text}${label ? ` ${label}` : ""}`;
    const width = (t: string) => Math.max(84, t.length * 7.2 + 34);
    const text = width(long) <= maxW ? long : state === "free" ? "Free" : meta.text;
    const w = Math.min(maxW, width(text));
    return (
      <g transform={`translate(${x - w / 2} ${y - 13})`} pointerEvents="none">
        <rect width={w} height={26} rx={13} fill="#fff" stroke={meta.dot} strokeWidth={1.5} />
        <circle cx={14} cy={13} r={5.5} fill={meta.dot} />
        {state === "free" && <circle className="vacancy-ring" cx={14} cy={13} r={5.5} fill={meta.dot} />}
        <text x={26} y={17.5} fontSize={12.5} fontWeight={600} fill="#1f2933">
          {text}
        </text>
      </g>
    );
  }
  return (
    <g pointerEvents="none">
      {state === "free" && <circle className="vacancy-ring" cx={x} cy={y} r={9} fill={meta.dot} />}
      <circle cx={x} cy={y} r={10} fill="#fff" />
      <circle cx={x} cy={y} r={7} fill={meta.dot} />
    </g>
  );
}
