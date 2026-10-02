"use client";

import { useDrag } from "@use-gesture/react";
import gsap from "gsap";
import { Flip } from "gsap/Flip";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FloorMap } from "@/components/FloorMap";
import { Toasts } from "@/components/Toasts";
import { BOOKABLE_ROOMS, describe, KIND_LABEL } from "@/data/campus";
import { freeSlots } from "@/lib/status";
import { fmtTime } from "@/lib/time";
import type { BookResult, Room } from "@/lib/types";
import { useStore } from "@/store/useStore";

gsap.registerPlugin(Flip);

const VIBES = ["quiet", "computers", "projector", "smart-board", "dual-monitor", "whiteboard", "gpu"];
const SAVED_KEY = "xie-spaces-saved";

interface Card {
  room: Room;
  start: number;
}

/** Resource Tinder: swipe right to book, left to skip, up to save. */
export default function Swipe() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const engine = useStore((s) => s.engine);
  const today = useStore((s) => s.today);
  const nowMin = useStore((s) => s.nowMin);
  const role = useStore((s) => s.role);
  const book = useStore((s) => s.book);
  const toast = useStore((s) => s.toast);
  const [vibes, setVibes] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [saved, setSaved] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<{ card: Card; res: BookResult } | null>(null);
  const topRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);
  const flipState = useRef<Flip.FlipState | null>(null);

  useEffect(() => {
    init();
    try {
      setSaved(JSON.parse(localStorage.getItem(SAVED_KEY) ?? "[]"));
    } catch {}
  }, [init]);

  const deck: Card[] = useMemo(() => {
    if (!ready) return [];
    const from = Math.max(8 * 60, Math.ceil(nowMin / 15) * 15);
    return BOOKABLE_ROOMS.filter((r) => r.kind !== "outdoor" && !skipped.includes(r.id) && vibes.every((v) => r.tags.includes(v)))
      .map((room) => ({ room, start: freeSlots(engine, room.id, today, from, 60, 1)[0] }))
      .filter((c): c is Card => c.start != null)
      .sort((a, b) => a.start - b.start || (b.room.capacity ?? 0) - (a.room.capacity ?? 0));
  }, [ready, engine, today, nowMin, skipped, vibes]);

  const top = deck[0];

  const fly = (dir: "left" | "right" | "up") => {
    const el = topRef.current;
    if (!el || !top) return;
    if (dir === "right") return doBook(top);
    gsap.to(el, {
      x: dir === "left" ? -window.innerWidth : 0,
      y: dir === "up" ? -window.innerHeight : 0,
      rotate: dir === "left" ? -25 : 0,
      opacity: 0,
      duration: 0.35,
      ease: "power2.in",
      onComplete: () => {
        if (dir === "up") {
          const next = [...new Set([...saved, top.room.id])];
          setSaved(next);
          try {
            localStorage.setItem(SAVED_KEY, JSON.stringify(next));
          } catch {}
          toast({ title: "Saved", body: `${top.room.name} added to your saved spaces.`, tone: "info" });
        }
        setSkipped((s) => [...s, top.room.id]);
      },
    });
  };

  const doBook = (card: Card) => {
    const res = book({ roomIds: [card.room.id], date: today, start: card.start, end: card.start + 60, title: `Swipe booking · ${card.room.short}`, purpose: role === "student" ? "casual" : "academic_class", attendees: Math.min(card.room.capacity ?? 4, 4) });
    if (topRef.current) flipState.current = Flip.getState(topRef.current);
    setConfirm({ card, res });
  };

  // Card morphs into the confirmation sheet.
  useLayoutEffect(() => {
    if (!confirm || !sheetRef.current || !flipState.current) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    Flip.from(flipState.current, { targets: sheetRef.current, duration: 0.55, ease: "power3.inOut", absolute: true, scale: false });
    gsap.from(sheetRef.current.querySelectorAll("[data-in]"), { opacity: 0, y: 14, stagger: 0.06, delay: 0.35 });
    flipState.current = null;
  }, [confirm]);

  const bind = useDrag(
    ({ down, movement: [mx, my], velocity: [vx, vy], direction: [dx, dy] }) => {
      const el = topRef.current;
      if (!el) return;
      if (down) {
        gsap.set(el, { x: mx, y: my, rotate: mx / 18 });
        el.dataset.hint = mx > 60 ? "book" : mx < -60 ? "skip" : my < -60 ? "save" : "";
        return;
      }
      el.dataset.hint = "";
      if (mx > 110 || (vx > 0.6 && dx > 0)) fly("right");
      else if (mx < -110 || (vx > 0.6 && dx < 0)) fly("left");
      else if (my < -110 || (vy > 0.6 && dy < 0)) fly("up");
      else gsap.to(el, { x: 0, y: 0, rotate: 0, duration: 0.4, ease: "back.out(2)" });
    },
    { filterTaps: true },
  );

  return (
    <div className="relative mx-auto flex h-dvh max-w-md flex-col overflow-hidden bg-paper px-4 pb-4 pt-3 text-navy">
      <header className="flex items-center justify-between">
        <a href="/map" className="font-display text-xl font-bold">
          ← XIE Spaces
        </a>
        <span className="font-mono text-[10px] tracking-widest text-muted">{deck.length} FREE NOW</span>
      </header>
      <div className="scroll-thin -mx-4 mt-3 flex gap-1.5 overflow-x-auto px-4 pb-1">
        {VIBES.map((v) => (
          <button
            key={v}
            onClick={() => (setVibes((x) => (x.includes(v) ? x.filter((y) => y !== v) : [...x, v])), setSkipped([]))}
            className={`whitespace-nowrap rounded-full border px-3 py-1 text-xs font-medium ${vibes.includes(v) ? "border-brand bg-brand text-white" : "border-navy/20 bg-white"}`}
          >
            {v}
          </button>
        ))}
      </div>

      <div className="relative mt-4 flex-1">
        {!ready && <p className="pt-20 text-center text-muted">Loading…</p>}
        {ready && !top && (
          <div className="pt-16 text-center">
            <p className="font-display text-2xl">That&apos;s every match.</p>
            <button onClick={() => setSkipped([])} className="mt-3 rounded-lg border border-navy/20 px-4 py-2 text-sm">
              Start over
            </button>
          </div>
        )}
        {deck
          .slice(0, 3)
          .reverse()
          .map((c, i, arr) => {
            const isTop = i === arr.length - 1;
            const depth = arr.length - 1 - i;
            return (
              <div
                key={c.room.id}
                ref={isTop ? topRef : undefined}
                {...(isTop ? bind() : {})}
                data-flip-id={isTop ? "swipe-card" : undefined}
                className="group absolute inset-0 flex touch-none select-none flex-col overflow-hidden rounded-3xl border border-navy/10 bg-white shadow-xl data-[hint=book]:ring-4 data-[hint=book]:ring-free data-[hint=save]:ring-4 data-[hint=save]:ring-inuse data-[hint=skip]:ring-4 data-[hint=skip]:ring-busy"
                style={{ transform: `translateY(${depth * 12}px) scale(${1 - depth * 0.04})`, zIndex: 10 - depth, cursor: isTop ? "grab" : "default" }}
              >
                <div className="relative h-[42%] bg-[#eef1f5] p-2">
                  <FloorMap mini={{ floor: c.room.floor, highlight: c.room.id }} onSelect={() => {}} selected={null} />
                  <span className="absolute left-3 top-3 rounded-full bg-free px-2.5 py-1 text-xs font-semibold text-white">Free at {fmtTime(c.start)}</span>
                </div>
                <div className="flex flex-1 flex-col gap-2 p-5">
                  <div className="font-mono text-[10px] tracking-widest text-muted">
                    {c.room.id} · LEVEL {c.room.floor} · {KIND_LABEL[c.room.kind].toUpperCase()}
                  </div>
                  <h2 className="font-display text-3xl font-bold leading-tight">{c.room.name}</h2>
                  <p className="text-sm text-muted">{describe(c.room)}</p>
                  <div className="mt-auto flex flex-wrap gap-1.5">
                    <span className="rounded bg-navy px-2 py-0.5 text-xs text-white">👥 {c.room.capacity}</span>
                    {c.room.tags.map((t) => (
                      <span key={t} className="rounded bg-powder/70 px-2 py-0.5 text-xs">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            );
          })}
      </div>

      <div className="mt-4 flex items-center justify-center gap-5">
        <button aria-label="Skip" onClick={() => fly("left")} className="grid h-14 w-14 place-items-center rounded-full border-2 border-busy bg-white text-2xl text-busy shadow">
          ✕
        </button>
        <button aria-label="Save" onClick={() => fly("up")} className="grid h-11 w-11 place-items-center rounded-full border-2 border-inuse bg-white text-lg text-inuse shadow">
          ★
        </button>
        <button aria-label="Book" onClick={() => top && doBook(top)} className="grid h-14 w-14 place-items-center rounded-full bg-free text-2xl text-white shadow-lg">
          ✓
        </button>
      </div>
      <p className="mt-2 text-center text-[11px] text-muted">Swipe right to book · left to skip · up to save {saved.length ? `(${saved.length} saved)` : ""}</p>

      {confirm && (
        <div className="absolute inset-0 z-40 flex items-end bg-navy/40" onClick={() => (setConfirm(null), setSkipped((s) => [...s, confirm.card.room.id]))}>
          <div ref={sheetRef} data-flip-id="swipe-card" className="w-full rounded-t-3xl bg-white p-6 pb-8" onClick={(e) => e.stopPropagation()}>
            <div data-in className="mx-auto mb-4 h-1.5 w-12 rounded-full bg-navy/15" />
            <div data-in className={`mb-1 text-sm font-semibold ${confirm.res.ok ? (confirm.res.booking.status === "pending_approval" ? "text-pending" : "text-free") : "text-busy"}`}>
              {confirm.res.ok ? (confirm.res.booking.status === "pending_approval" ? "Request sent · slot soft-held" : "Booked ✓") : "Couldn't book"}
            </div>
            <h3 data-in className="font-display text-2xl font-bold">{confirm.card.room.name}</h3>
            <p data-in className="text-sm text-muted">
              Today · {fmtTime(confirm.card.start)}–{fmtTime(confirm.card.start + 60)} · Level {confirm.card.room.floor}
            </p>
            <p data-in className="mt-3 rounded-lg bg-black/[.04] p-3 text-xs leading-relaxed">
              {confirm.res.event.text}
            </p>
            <div data-in className="mt-4 grid grid-cols-2 gap-2">
              <a href="/map" className="rounded-lg border border-navy/20 py-2.5 text-center text-sm font-semibold">
                View on map
              </a>
              <button onClick={() => (setConfirm(null), setSkipped((s) => [...s, confirm.card.room.id]))} className="rounded-lg bg-brand py-2.5 text-sm font-semibold text-white">
                Keep swiping
              </button>
            </div>
          </div>
        </div>
      )}
      <Toasts />
    </div>
  );
}
