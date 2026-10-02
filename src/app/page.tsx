"use client";

import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { MorphSVGPlugin } from "gsap/MorphSVGPlugin";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useEffect, useRef } from "react";
import { FloorMap } from "@/components/FloorMap";
import { BOOKABLE_ROOMS } from "@/data/campus";
import { useStore } from "@/store/useStore";

gsap.registerPlugin(useGSAP, MorphSVGPlugin, ScrollTrigger);

// Building footprint as seen from the satellite: a C-ring around the turf, ~8° off the grid.
const FOOTPRINT = "M120 140 L1000 18 L1150 560 L940 610 L860 220 L330 296 L380 520 L180 560 Z";
// The same ring as drawn on the schematic plans (north strip, east and west columns, courtyard open to the south).
const PLAN = "M60 60 L1250 60 L1250 760 L1000 760 L1000 260 L380 260 L380 760 L60 760 Z";

export default function Landing() {
  const root = useRef<HTMLDivElement>(null);
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const free = useStore((s) => {
    if (!s.ready) return 0;
    return BOOKABLE_ROOMS.filter((r) => !s.engine.bookings.some((b) => b.date === s.today && b.roomIds.includes(r.id) && ["confirmed", "checked_in", "pending_approval"].includes(b.status) && b.start <= s.nowMin && s.nowMin < b.end)).length;
  });

  useEffect(() => init(), [init]);

  useGSAP(
    () => {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduce) {
        gsap.set("#outline", { morphSVG: PLAN });
        return;
      }
      const tl = gsap.timeline({ defaults: { ease: "power3.inOut" } });
      tl.set("#outline", { strokeDasharray: 4200 })
        .fromTo("#outline", { strokeDashoffset: 4200 }, { strokeDashoffset: 0, duration: 1.4, ease: "power2.out" })
        .set("#outline", { strokeDasharray: "none" })
        .from("#outline-fill", { opacity: 0, duration: 0.6 }, "-=0.4")
        .to("#outline, #outline-fill", { morphSVG: PLAN, duration: 1.3 }, "+=0.2")
        .from("[data-floor-chip]", { y: 20, opacity: 0, stagger: 0.1, duration: 0.5, ease: "back.out(1.7)" }, "-=0.4")
        .from("[data-hero-copy] > *", { y: 24, opacity: 0, stagger: 0.08, duration: 0.6 }, 0.2);
    },
    { scope: root },
  );

  useGSAP(
    () => {
      if (!ready || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const plates = gsap.utils.toArray<HTMLElement>("[data-plate]");
      gsap.set(plates, { z: (i) => i * 16 });
      gsap
        .timeline({ scrollTrigger: { trigger: "#stack", start: "top top", end: "+=900", scrub: 0.8, pin: true } })
        .to(plates, { z: (i) => i * 190, duration: 1, ease: "none" })
        .from("[data-plate-label]", { opacity: 0, x: -20, stagger: 0.1, duration: 0.3 }, 0.6);
    },
    { scope: root, dependencies: [ready] },
  );

  return (
    <div ref={root} className="bg-paper text-navy">
      {/* HERO */}
      <section className="relative mx-auto grid min-h-dvh max-w-6xl items-center gap-10 px-5 py-16 md:grid-cols-[1fr_1.1fr]">
        <div data-hero-copy className="space-y-5">
          <p className="font-mono text-[11px] tracking-[0.3em] text-muted">XAVIER INSTITUTE OF ENGINEERING · MAHIM</p>
          <h1 className="font-display text-5xl font-bold leading-[1.05] md:text-6xl">Every room on campus, live.</h1>
          <p className="max-w-md text-lg text-muted">
            Book labs, lecture halls and the seminar hall in seconds. Double bookings are impossible, and every conflict gets resolved with an explanation you can read.
          </p>
          <div className="flex flex-wrap gap-3">
            <a href="/map" className="rounded-lg bg-brand px-5 py-3 font-semibold text-white shadow-lg hover:brightness-110">
              Open live map →
            </a>
            <a href="/swipe" className="rounded-lg border border-navy/20 px-5 py-3 font-semibold hover:bg-black/5">
              Swipe to book
            </a>
          </div>
          <p className="text-sm text-muted">
            <b className="text-free">{ready ? free : "…"}</b> of {BOOKABLE_ROOMS.length} rooms free right now.
          </p>
        </div>
        <div className="relative">
          <svg viewBox="0 0 1310 820" className="w-full" aria-label="XIE building footprint">
            <path id="outline-fill" d={FOOTPRINT} fill="#d3e0ec" opacity={0.45} />
            <path id="outline" d={FOOTPRINT} fill="none" stroke="#1f2933" strokeWidth={14} strokeLinejoin="round" />
            <text x={655} y={560} textAnchor="middle" fontSize={34} fill="#4d6b43" fontWeight={700} letterSpacing={4}>
              TURF COURTYARD
            </text>
          </svg>
          <div className="mt-2 flex justify-center gap-3">
            {[1, 2, 3].map((f) => (
              <a key={f} data-floor-chip href={`/map?floor=${f}`} className="rounded-full border border-navy/20 bg-white px-4 py-2 text-sm font-semibold shadow-sm hover:border-brand hover:text-brand">
                Level {f}
              </a>
            ))}
          </div>
        </div>
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 font-mono text-[10px] tracking-[0.3em] text-muted">SCROLL ↓</div>
      </section>

      {/* EXPLODED ISOMETRIC FLOORS */}
      <section id="stack" className="relative flex h-dvh items-center justify-center overflow-hidden bg-[#eef1f5]">
        <h2 className="absolute left-5 top-8 font-display text-3xl font-bold md:left-12">Three floors. One live map.</h2>
        <div className="relative h-[46vmin] w-[78vmin]" style={{ perspective: 2200 }}>
          <div className="absolute inset-0" style={{ transformStyle: "preserve-3d", transform: "rotateX(58deg) rotateZ(-34deg) translateY(10%)" }}>
            {([1, 2, 3] as const).map((f) => (
              <a
                key={f}
                data-plate
                href={`/map?floor=${f}`}
                aria-label={`Open level ${f}`}
                className="group absolute inset-0 block rounded-md bg-white/90 shadow-[0_30px_60px_-20px_rgba(31,41,51,0.45)] outline-offset-4 transition-shadow hover:shadow-[0_0_0_4px_#1d4ed8]"
                style={{ transform: `translateZ(${(f - 1) * 190}px)`, transformStyle: "preserve-3d" }}
              >
                {ready && <FloorMap mini={{ floor: f, highlight: "" }} onSelect={() => {}} selected={null} />}
                <span data-plate-label className="absolute -left-28 top-1/2 rounded bg-navy px-2 py-1 font-mono text-xs text-white" style={{ transform: "rotateZ(34deg) rotateX(-58deg)" }}>
                  LEVEL {f}
                </span>
              </a>
            ))}
          </div>
        </div>
        <p className="absolute bottom-8 text-sm text-muted">Click a floor to dive in.</p>
      </section>

      {/* FEATURES */}
      <section className="mx-auto grid max-w-6xl gap-4 px-5 py-20 md:grid-cols-3">
        {[
          ["Conflict engine", "Priority scoring, bumping, negotiation and fairness, all written to a decision log in plain English."],
          ["AI booking assistant", "\"Hall for 80 with a projector Friday evening\" gets you ranked options. Also on Telegram, WhatsApp and MCP."],
          ["Digital Twin", "Simulate Chaos fires 50 conflicting requests and resolves them live with zero double bookings."],
        ].map(([t, d]) => (
          <div key={t} className="rounded-2xl border border-navy/10 bg-white p-6">
            <h3 className="font-display text-xl font-bold">{t}</h3>
            <p className="mt-2 text-sm text-muted">{d}</p>
          </div>
        ))}
        <a href="/map" className="rounded-2xl bg-navy p-6 text-white md:col-span-3">
          <span className="font-display text-2xl font-bold">Open the live campus map →</span>
        </a>
      </section>
    </div>
  );
}
