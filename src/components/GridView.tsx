"use client";

import { COURT_TURF, FLOORS, KIND_LABEL } from "@/data/campus";
import { bookingsFor, liveState, STATE_META } from "@/lib/status";
import { DAY_END, DAY_START, fmtTime } from "@/lib/time";
import type { Room } from "@/lib/types";
import { useStore } from "@/store/useStore";

const BG: Record<string, string> = { pending_approval: "#f5c26b", checked_in: "#93b4f5", completed: "#d1d5db", confirmed: "#f19a92" };

/** Skedda "grid" view: rooms × hours for the selected level. */
export function GridView({ onSelect }: { onSelect: (room: Room, el: Element) => void }) {
  const s = useStore();
  const rooms = [...FLOORS[s.floor].filter((r) => r.bookable), ...(s.floor === 1 ? [COURT_TURF] : [])];
  const span = DAY_END - DAY_START;
  const pct = (m: number) => `${((m - DAY_START) / span) * 100}%`;
  return (
    <div className="scroll-thin h-full overflow-auto p-4">
      <div className="surface min-w-[720px] overflow-hidden rounded-xl border">
        <div className="grid grid-cols-[200px_1fr] border-b border-[var(--line)] text-[10px] font-mono text-muted">
          <span className="px-3 py-2">SPACE</span>
          <div className="relative h-8">
            {Array.from({ length: 13 }, (_, i) => (
              <span key={i} className="absolute top-2 -translate-x-1/2" style={{ left: pct(DAY_START + i * 60) }}>
                {8 + i}
              </span>
            ))}
          </div>
        </div>
        {rooms.map((room) => {
          const st = liveState(s.engine, room.id, s.date, s.time, s.today, s.nowMin).state;
          return (
            <button
              key={room.id}
              data-room-id={room.id}
              onClick={(e) => onSelect(room, e.currentTarget)}
              className="room-row grid w-full grid-cols-[200px_1fr] border-b border-[var(--line)] text-left hover:bg-black/[.03]"
            >
              <span className="flex items-center gap-2 px-3 py-2 text-sm">
                <i className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STATE_META[st].dot }} />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{room.name}</span>
                  <span className="text-[10px] text-muted">
                    {KIND_LABEL[room.kind]} · {room.capacity}
                  </span>
                </span>
              </span>
              <span className="relative block h-full min-h-[44px]">
                {bookingsFor(s.engine, room.id, s.date).map((b) => (
                  <span
                    key={b.id}
                    title={`${b.title} · ${fmtTime(b.start)}–${fmtTime(b.end)}`}
                    className="absolute inset-y-1.5 overflow-hidden rounded px-1.5 text-[10px] leading-[30px] text-navy"
                    style={{ left: pct(b.start), width: `calc(${((b.end - b.start) / span) * 100}% - 2px)`, background: BG[b.status] ?? "#f19a92" }}
                  >
                    {b.title}
                  </span>
                ))}
                <span className="absolute inset-y-0 w-0.5 bg-brand" style={{ left: pct(s.time) }} />
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
