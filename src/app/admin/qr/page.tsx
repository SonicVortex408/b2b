"use client";

import { useEffect, useState } from "react";
import { QrSvg } from "@/components/QrSvg";
import { FLOORS } from "@/data/campus";

/** Printable QR sheet: one code per bookable room, stuck on the door. */
export default function QrSheet() {
  const [origin, setOrigin] = useState("");
  useEffect(() => setOrigin(window.location.origin), []);
  return (
    <main className="mx-auto max-w-5xl bg-white p-6 text-navy print:p-0">
      <div className="mb-6 flex items-end justify-between print:hidden">
        <div>
          <h1 className="font-display text-3xl font-bold">QR check-in sheet</h1>
          <p className="text-sm text-muted">Print and stick on each door. Scanning opens the check-in page for that room. Door tablets can show the rotating, signed code instead (/display/ROOM).</p>
        </div>
        <button onClick={() => window.print()} className="rounded-md bg-brand px-4 py-2 text-sm font-semibold text-white">
          Print
        </button>
      </div>
      {origin &&
        ([1, 2, 3] as const).map((f) => (
          <section key={f} className="mb-8 break-after-page">
            <h2 className="mb-3 font-mono text-xs uppercase tracking-widest text-muted">Level {f}</h2>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {FLOORS[f]
                .filter((r) => r.bookable)
                .map((r) => (
                  <div key={r.id} className="break-inside-avoid rounded-xl border border-navy/20 p-3 text-center">
                    <QrSvg value={`${origin}/checkin?room=${r.id}`} className="mx-auto w-32 [&>svg]:h-auto [&>svg]:w-full" />
                    <div className="mt-2 font-display text-base font-bold leading-tight">{r.name}</div>
                    <div className="font-mono text-[10px] text-muted">
                      {r.id} · scan to check in
                    </div>
                  </div>
                ))}
            </div>
          </section>
        ))}
    </main>
  );
}
