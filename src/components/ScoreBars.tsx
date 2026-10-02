"use client";

import gsap from "gsap";
import { useLayoutEffect, useRef } from "react";
import type { ScoreBreakdown } from "@/lib/types";

const ROWS: [keyof ScoreBreakdown, string, number][] = [
  ["purpose", "Purpose", 0.4],
  ["role", "Role", 0.2],
  ["urgency", "Urgency", 0.15],
  ["fairness", "Fairness", 0.15],
  ["usage", "Usage", 0.1],
];

/** Animated side-by-side priority breakdown: score = 0.40·purpose + 0.20·role + 0.15·urgency + 0.15·fairness + 0.10·usage */
export function ScoreBars({ a, b, aLabel, bLabel }: { a: ScoreBreakdown; b: ScoreBreakdown; aLabel: string; bLabel: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.from(ref.current!.querySelectorAll("[data-bar]"), { scaleX: 0, transformOrigin: "left", duration: 0.7, stagger: 0.05, ease: "power3.out" });
  }, [a, b]);
  return (
    <div ref={ref} className="mt-2 rounded-md bg-[var(--surface)] p-2">
      <div className="mb-1 flex justify-between font-mono text-[10px] text-muted">
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full bg-brand" />
          {aLabel} {a.total}
        </span>
        <span>
          <i className="mr-1 inline-block h-2 w-2 rounded-full bg-pending" />
          {bLabel} {b.total}
        </span>
      </div>
      {[["total", "Total", 1] as const, ...ROWS].map(([k, label, w]) => (
        <div key={k} className="grid grid-cols-[64px_1fr] items-center gap-2 py-0.5">
          <span className={`text-[10px] ${k === "total" ? "font-bold" : "text-muted"}`}>
            {label}
            {k !== "total" && <span className="opacity-60"> ×{w}</span>}
          </span>
          <div className="space-y-0.5">
            <div data-bar className="h-1.5 rounded bg-brand" style={{ width: `${a[k]}%` }} />
            <div data-bar className="h-1.5 rounded bg-pending" style={{ width: `${b[k]}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}
