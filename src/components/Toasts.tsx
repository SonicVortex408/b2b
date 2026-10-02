"use client";

import gsap from "gsap";
import { useLayoutEffect, useRef } from "react";
import { useStore, type Toast } from "@/store/useStore";

const ICON: Record<Toast["tone"], string> = { info: "#2563eb", ok: "#16a34a", warn: "#d97706", bad: "#dc2626" };

function Item({ t }: { t: Toast }) {
  const ref = useRef<HTMLLIElement>(null);
  const dismiss = useStore((s) => s.dismiss);
  useLayoutEffect(() => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) gsap.from(ref.current, { x: -40, opacity: 0, duration: 0.4, ease: "back.out(1.6)" });
  }, []);
  return (
    <li ref={ref} className="surface pointer-events-auto flex items-start gap-3 rounded-2xl border px-4 py-3 shadow-xl">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-bold text-white" style={{ background: ICON[t.tone] }}>
        {t.tone === "ok" ? "✓" : t.tone === "bad" ? "!" : t.tone === "warn" ? "↻" : "@"}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold" style={{ color: t.tone === "info" ? "#4f46e5" : undefined }}>
          {t.title}
        </div>
        <div className="text-xs text-muted">{t.body}</div>
      </div>
      <button onClick={() => dismiss(t.id)} className="text-muted" aria-label="Dismiss">
        ×
      </button>
    </li>
  );
}

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  return (
    <ul className="pointer-events-none absolute left-3 top-3 z-50 flex w-[min(340px,calc(100%-24px))] flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <Item key={t.id} t={t} />
      ))}
    </ul>
  );
}
