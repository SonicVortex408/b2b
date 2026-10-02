"use client";

import { useEffect, useState } from "react";
import { AuthControl } from "@/components/AuthControl";
import { Toasts } from "@/components/Toasts";
import { ROOM_BY_ID } from "@/data/campus";
import { CHECKIN_WINDOW } from "@/lib/engine";
import { fmtTime } from "@/lib/time";
import { useStore } from "@/store/useStore";

type Phase = { kind: "working" } | { kind: "ok"; text: string } | { kind: "error"; text: string };

/** Landing page for a scanned door QR: verify the signed token, then check in the scanner's booking. */
export default function CheckIn() {
  const init = useStore((s) => s.init);
  const ready = useStore((s) => s.ready);
  const engine = useStore((s) => s.engine);
  const me = useStore((s) => s.me);
  const remote = useStore((s) => s.remote);
  const session = useStore((s) => s.session);
  const today = useStore((s) => s.today);
  const nowMin = useStore((s) => s.nowMin);
  const act = useStore((s) => s.act);
  const [params, setParams] = useState<{ room: string; t: string } | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "working" });

  useEffect(() => {
    init();
    const p = new URLSearchParams(window.location.search);
    setParams({ room: p.get("room") ?? "", t: p.get("t") ?? "" });
  }, [init]);

  const room = params ? ROOM_BY_ID.get(params.room) : undefined;
  const booking = engine.bookings.find(
    (b) => b.requester === me && b.date === today && b.roomIds.includes(params?.room ?? "") && (b.status === "confirmed" || b.status === "checked_in") && nowMin >= b.start - 15 && nowMin < b.end,
  );

  useEffect(() => {
    if (!ready || !params || phase.kind !== "working" || (remote && !session)) return;
    (async () => {
      if (!room) return setPhase({ kind: "error", text: "Unknown room code." });
      if (params.t) {
        const r = await fetch("/api/qr", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: params.t, room: room.id }) }).then((x) => x.json());
        if (!r.ok) return setPhase({ kind: "error", text: r.reason === "expired" ? "This code expired. Scan the door display again." : "Invalid code for this room." });
      }
      if (!booking) return setPhase({ kind: "error", text: `${me}, you have no booking in ${room.name} right now (check-in opens 15 min before start).` });
      if (booking.status === "checked_in") return setPhase({ kind: "ok", text: "You're already checked in." });
      await act("checkin", booking.id, true);
      setPhase({ kind: "ok", text: `Checked in to ${room.name}, ${fmtTime(booking.start)}–${fmtTime(booking.end)}. +5 points.` });
    })();
  }, [ready, params, phase.kind, remote, session, room, booking, me, act]);

  return (
    <main className="grid min-h-dvh place-items-center bg-paper p-6 text-navy">
      <div className="w-full max-w-sm rounded-3xl border border-navy/10 bg-white p-6 text-center shadow-xl">
        <div className="font-mono text-[10px] tracking-[0.3em] text-muted">XIE SPACES · CHECK-IN</div>
        <h1 className="mt-1 font-display text-3xl font-bold">{room?.name ?? "…"}</h1>
        {remote && !session ? (
          <div className="mt-6 space-y-3">
            <p className="text-sm text-muted">Sign in to check in.</p>
            <AuthControl />
          </div>
        ) : phase.kind === "working" ? (
          <p className="mt-6 text-muted">Verifying…</p>
        ) : (
          <div className={`mt-6 rounded-xl p-4 text-sm ${phase.kind === "ok" ? "bg-free/10 text-free" : "bg-busy/10 text-busy"}`}>
            <div className="mb-1 text-3xl">{phase.kind === "ok" ? "✓" : "!"}</div>
            {phase.text}
          </div>
        )}
        {!params?.t && params && <p className="mt-4 text-[11px] text-muted">Printed code: tap-to-check-in only works during your booking window (start −15 min to {CHECKIN_WINDOW} min after).</p>}
        <a href="/map" className="mt-6 inline-block text-sm font-semibold text-brand">
          Open the live map →
        </a>
      </div>
      <Toasts />
    </main>
  );
}
