"use client";

import { create } from "zustand";
import { AuthControl } from "./AuthControl";
import { useUnread } from "./Collab";
import { LANGS, restoreLang, useLang, useT, type Key, type Lang } from "@/i18n";
import { useEffect } from "react";
import { addDays, DAY_END, DAY_START, fmtDate, fmtTime, nowMinutes } from "@/lib/time";
import type { Role } from "@/lib/types";
import { useStore, type Panel } from "@/store/useStore";

// View mode is UI-only; keep it out of the engine store.
export const useView = create<{ view: "map" | "grid"; setView: (v: "map" | "grid") => void }>((set) => ({ view: "map", setView: (view) => set({ view }) }));

const NAV: [Panel, Key][] = [
  ["bookings", "nav.bookings"],
  ["approvals", "nav.approvals"],
  ["conflicts", "nav.conflicts"],
  ["admin", "nav.admin"],
];

export function Header({ dark, setDark }: { dark: boolean; setDark: (d: boolean) => void }) {
  const remote = useStore((s) => s.remote);
  const unread = useUnread();
  const t = useT();
  const { lang, setLang } = useLang();
  useEffect(restoreLang, []);
  const role = useStore((s) => s.role);
  const setRole = useStore((s) => s.setRole);
  const panel = useStore((s) => s.panel);
  const set = useStore((s) => s.set);
  const runChaos = useStore((s) => s.runChaos);
  const running = useStore((s) => s.chaos.running);
  const pending = useStore((s) => s.engine.bookings.filter((b) => b.status === "pending_approval" && b.date >= s.today).length);

  return (
    <header className="surface flex flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2.5">
      <a href="/" className="flex items-center gap-2">
        <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden>
          <rect x="2" y="2" width="28" height="28" rx="4" fill="#1f2933" />
          <path d="M8 9h16v4H13v10H8z" fill="#d3e0ec" />
          <rect x="15" y="15" width="9" height="8" fill="#d7e6cf" />
        </svg>
        <div className="leading-none">
          <div className="font-display text-lg font-bold">XIE Spaces</div>
          <div className="font-mono text-[10px] tracking-widest text-muted">XAVIER INSTITUTE OF ENGINEERING</div>
        </div>
      </a>
      <nav className="order-3 flex w-full gap-1 overflow-x-auto md:order-none md:w-auto">
        {NAV.map(([p, label]) => (
          <button
            key={p}
            onClick={() => set({ panel: panel === p ? "none" : p, selected: null })}
            className={`relative whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition ${panel === p ? "bg-navy text-white dark:bg-white dark:text-navy" : "hover:bg-black/5"}`}
          >
            {t(label)}
            {p === "approvals" && pending > 0 && <span className="ml-1.5 rounded-full bg-pending px-1.5 text-[10px] text-white">{pending}</span>}
          </button>
        ))}
        <button
          onClick={() => set({ panel: panel === "swaps" ? "none" : "swaps", selected: null })}
          className={`whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium ${panel === "swaps" ? "bg-navy text-white dark:bg-white dark:text-navy" : "hover:bg-black/5"}`}
        >
          {t("nav.swaps")}
        </button>
        <a href="/swipe" className="whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium hover:bg-black/5">
          {t("nav.swipe")}
        </a>
      </nav>
      <div className="ml-auto flex items-center gap-2">
        {remote ? (
          <AuthControl />
        ) : (
        <label className="flex items-center gap-1.5 text-xs">
            <span className="hidden text-muted 2xl:inline">Signed in as</span>
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className="rounded-md border border-[var(--line)] bg-transparent px-2 py-1.5 text-sm font-medium" aria-label="Demo role">
              <option value="student">student@xie.demo</option>
              <option value="faculty">faculty@xie.demo</option>
              <option value="approver">approver@xie.demo</option>
              <option value="admin">admin@xie.demo</option>
            </select>
          </label>
        )}
        <select value={lang} onChange={(e) => setLang(e.target.value as Lang)} className="rounded-md border border-[var(--line)] bg-transparent px-1.5 py-1.5 text-xs" aria-label="Language">
          {Object.entries(LANGS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
        <button
          onClick={() => set({ panel: panel === "notifications" ? "none" : "notifications", selected: null })}
          className="relative grid h-8 w-8 place-items-center rounded-md border border-[var(--line)]"
          aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        >
          🔔
          {unread > 0 && <span className="absolute -right-1.5 -top-1.5 min-w-[18px] rounded-full bg-busy px-1 text-center text-[10px] font-bold leading-[18px] text-white">{unread > 99 ? "99+" : unread}</span>}
        </button>
        <button onClick={() => setDark(!dark)} className="grid h-8 w-8 place-items-center rounded-md border border-[var(--line)]" aria-label="Toggle dark mode">
          {dark ? "☀" : "☾"}
        </button>
        <button
          onClick={runChaos}
          disabled={running}
          className="rounded-md bg-brand px-3 py-1.5 text-sm font-semibold text-white shadow hover:brightness-110 disabled:opacity-60"
        >
          {running ? t("chaos.running") : t("chaos.button")}
        </button>
      </div>
    </header>
  );
}

export function Toolbar() {
  const s = useStore();
  const t = useT();
  const { view, setView } = useView();
  const isToday = s.date === s.today;
  return (
    <div className="surface scroll-thin flex items-center gap-x-3 gap-y-2 overflow-x-auto whitespace-nowrap border-b px-4 py-2 text-xs font-semibold uppercase tracking-wide md:flex-wrap md:overflow-visible">
      <div className="flex overflow-hidden rounded-md border border-[var(--line)]">
        {(["map", "grid"] as const).map((v) => (
          <button key={v} onClick={() => (s.set({ selected: null }), setView(v))} className={`px-3 py-1.5 ${view === v ? "bg-black/10 dark:bg-white/15" : "hover:bg-black/5"}`} data-view={v}>
            {v}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
        <button aria-label="Previous day" onClick={() => s.set({ date: addDays(s.date, -1) })} className="rounded px-2 py-1 hover:bg-black/5">
          ‹
        </button>
        <button aria-label="Next day" onClick={() => s.set({ date: addDays(s.date, 1) })} className="rounded px-2 py-1 hover:bg-black/5">
          ›
        </button>
        <span className="min-w-[110px] px-1 md:min-w-[150px]">{fmtDate(s.date, { weekday: "long", month: "long", day: "numeric" })}</span>
        {!isToday && (
          <button onClick={() => s.set({ date: s.today })} className="rounded border border-[var(--line)] px-2 py-0.5 normal-case">
            {t("toolbar.today")}
          </button>
        )}
      </div>
      <div className="flex overflow-hidden rounded-md border border-[var(--line)]" role="tablist" aria-label="Floor">
        {([1, 2, 3] as const).map((f) => (
          <button key={f} role="tab" aria-selected={s.floor === f} onClick={() => s.set({ floor: f, selected: null })} className={`px-3 py-1.5 ${s.floor === f ? "bg-navy text-white dark:bg-white dark:text-navy" : "hover:bg-black/5"}`}>
            {t("toolbar.level")} {f}
          </button>
        ))}
      </div>
      <div className="flex min-w-[260px] flex-1 items-center gap-2">
        <span className="w-[68px] text-right tabular-nums">{fmtTime(s.time)}</span>
        <input
          type="range"
          className="scrubber flex-1"
          min={DAY_START}
          max={DAY_END - 15}
          step={15}
          value={s.time}
          onChange={(e) => s.set({ time: Number(e.target.value) })}
          aria-label="Time scrubber"
        />
        <button onClick={() => s.set({ date: s.today, time: Math.min(DAY_END - 15, Math.max(DAY_START, Math.floor(nowMinutes() / 15) * 15)) })} className="rounded border border-[var(--line)] px-2 py-0.5 normal-case">
          {t("toolbar.now")}
        </button>
      </div>
      <select value={s.filters.kind} onChange={(e) => s.setFilters({ kind: e.target.value })} className="rounded-md border border-[var(--line)] bg-transparent px-2 py-1.5 normal-case" aria-label="Room type">
        <option value="">All types</option>
        <option value="lh">Lecture halls</option>
        <option value="lab">Labs</option>
        <option value="tutorial">Tutorial rooms</option>
        <option value="seminar">Seminar hall</option>
        <option value="study">Library</option>
        <option value="meeting">Meeting</option>
      </select>
      <select value={s.filters.tag} onChange={(e) => s.setFilters({ tag: e.target.value })} className="rounded-md border border-[var(--line)] bg-transparent px-2 py-1.5 normal-case" aria-label="Space tags">
        <option value="">Space tags</option>
        {["projector", "smart-board", "computers", "dual-monitor", "gpu", "quiet", "whiteboard", "tv"].map((t) => (
          <option key={t}>{t}</option>
        ))}
      </select>
      <select value={s.filters.minCap} onChange={(e) => s.setFilters({ minCap: Number(e.target.value) })} className="rounded-md border border-[var(--line)] bg-transparent px-2 py-1.5 normal-case" aria-label="Minimum capacity">
        <option value={0}>Any size</option>
        {[10, 25, 50, 75, 100].map((c) => (
          <option key={c} value={c}>
            {c}+ seats
          </option>
        ))}
      </select>
      <button onClick={() => s.set({ colorMode: s.colorMode === "state" ? "type" : "state" })} className="rounded-md border border-[var(--line)] px-2 py-1.5 normal-case">
        Colour: {s.colorMode === "state" ? "live state" : "room type"}
      </button>
    </div>
  );
}

