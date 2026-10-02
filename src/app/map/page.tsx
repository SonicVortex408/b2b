"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Assistant } from "@/components/Assistant";
import { FloorMap } from "@/components/FloorMap";
import { GridView } from "@/components/GridView";
import { PanelDrawer } from "@/components/Panels";
import { RoomCard, type Origin } from "@/components/RoomCard";
import { Toasts } from "@/components/Toasts";
import { Header, Toolbar, useView } from "@/components/Toolbar";
import { ROOM_BY_ID } from "@/data/campus";
import { STATE_META, type LiveState } from "@/lib/status";
import type { Room } from "@/lib/types";
import { useT, type Key } from "@/i18n";
import { useStore } from "@/store/useStore";

function originOf(el: Element): Origin {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height, fill: el.getAttribute("fill") ?? "#ffffff" };
}

export default function Home() {
  const ready = useStore((s) => s.ready);
  const init = useStore((s) => s.init);
  const tick = useStore((s) => s.tick);
  const selected = useStore((s) => s.selected);
  const floor = useStore((s) => s.floor);
  const set = useStore((s) => s.set);
  const { view } = useView();
  const [origin, setOrigin] = useState<Origin | null>(null);
  // Each opening gets its own card instance, so a card still animating closed can't dismiss a fresh one.
  const [openSeq, setOpenSeq] = useState(0);
  const seqRef = useRef(0);
  seqRef.current = openSeq;
  const [dark, setDark] = useState(false);

  useEffect(() => {
    init();
    const f = Number(new URLSearchParams(window.location.search).get("floor"));
    if (f === 1 || f === 2 || f === 3) set({ floor: f });
    setDark(window.matchMedia("(prefers-color-scheme: dark)").matches);
    const t = setInterval(tick, 8000);
    return () => clearInterval(t);
  }, [init, tick, set]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  const onSelect = useCallback(
    (room: Room, el: Element) => {
      setOrigin(originOf(el));
      setOpenSeq((n) => n + 1);
      set({ selected: room.id, panel: "none" });
    },
    [set],
  );

  // Selections made elsewhere (assistant, deep links) morph from the room's shape on the map.
  useLayoutEffect(() => {
    if (!selected) return setOrigin(null);
    if (origin) return;
    const el = document.querySelector(`[data-room-id="${selected}"].room-shape, [data-room-id="${selected}"].room-row`);
    if (el) setOrigin(originOf(el));
  }, [selected, origin, floor, view]);

  const room = selected ? ROOM_BY_ID.get(selected) : undefined;

  return (
    <div className="flex h-dvh flex-col">
      <Header dark={dark} setDark={setDark} />
      <Toolbar />
      <main className="relative flex-1 overflow-hidden" style={{ background: "var(--canvas)" }}>
        {!ready ? (
          <div className="grid h-full place-items-center text-sm text-muted">Loading campus…</div>
        ) : view === "grid" ? (
          <GridView onSelect={onSelect} />
        ) : (
          <div className="flex h-full flex-col px-3 pb-16 pt-3 md:px-6">
            <div className="flex items-baseline justify-between gap-3">
              <h1 className="font-display text-xl font-bold md:text-2xl">
                Xavier Institute of Engineering · {["First", "Second", "Third"][floor - 1]} Floor
              </h1>
              <span className="hidden font-mono text-[10px] tracking-[0.25em] text-muted md:inline">S.L. RAHEJA MARG SIDE (NORTH)</span>
            </div>
            <div className="relative min-h-0 flex-1">
              <div className="scroll-thin absolute inset-0 overflow-x-auto">
                <div className="flex h-full min-w-[860px] items-center justify-center md:min-w-0">
                  <div className="h-full max-h-full w-full max-w-[1200px]" style={{ aspectRatio: "1450 / 818" }}>
                    <FloorMap onSelect={onSelect} selected={selected} />
                  </div>
                </div>
              </div>
              <span className="pointer-events-none absolute right-0 top-1/2 hidden -translate-y-1/2 font-mono text-[10px] tracking-[0.25em] text-muted [writing-mode:vertical-rl] md:block">
                MAHIM–SION LINK ROAD SIDE (EAST)
              </span>
            </div>
            <Legend />
          </div>
        )}
        {room && origin && (
          <RoomCard
            key={`${room.id}-${openSeq}`}
            room={room}
            origin={origin}
            onClose={((seq) => () => {
              if (seq !== seqRef.current) return;
              setOrigin(null);
              set({ selected: null });
            })(openSeq)}
          />
        )}
        <PanelDrawer />
        <Toasts />
        <Assistant />
      </main>
    </div>
  );
}

function Legend() {
  const t = useT();
  const states: LiveState[] = ["free", "booked", "pending", "held", "ghost", "inuse", "squatter", "blackout"];
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 pl-0 text-xs md:pl-44">
      <span className="font-mono text-[10px] uppercase tracking-widest text-muted">{t("legend.title")}</span>
      {states.map((s) => (
        <span key={s} className="flex items-center gap-1.5">
          <i
            className="h-3 w-3 rounded-sm border border-black/20"
            style={{ background: s === "ghost" ? "repeating-linear-gradient(45deg,#fdecea 0 3px,#f19a92 3px 5px)" : STATE_META[s].fill }}
          />
          {t(`state.${s}` as Key)}
        </span>
      ))}
      <span className="ml-auto flex items-center gap-1 text-muted" title="True north, approximate. Building sits ~8° off the grid.">
        <svg width="14" height="18" viewBox="0 0 14 18" style={{ transform: "rotate(-8deg)" }} aria-hidden>
          <path d="M7 0l6 18-6-4-6 4z" fill="currentColor" />
        </svg>
        N · * capacity unverified
      </span>
    </div>
  );
}
