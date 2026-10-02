"use client";

import { useParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { QrSvg } from "@/components/QrSvg";
import { ROOM_BY_ID } from "@/data/campus";
import { liveState, STATE_META } from "@/lib/status";
import { fmtTime } from "@/lib/time";
import { useStore } from "@/store/useStore";

/** Door tablet: shows the room's live status and a signed QR that rotates every 60 s. */
export default function DoorDisplay() {
  const { room: id } = useParams<{ room: string }>();
  const room = ROOM_BY_ID.get(id);
  const init = useStore((s) => s.init);
  const tick = useStore((s) => s.tick);
  const engine = useStore((s) => s.engine);
  const today = useStore((s) => s.today);
  const nowMin = useStore((s) => s.nowMin);
  const [tok, setTok] = useState<{ token: string; exp: number } | null>(null);
  const [left, setLeft] = useState(60);
  const [origin, setOrigin] = useState("");

  useEffect(() => {
    init();
    setOrigin(window.location.origin);
    const t = setInterval(tick, 15000);
    return () => clearInterval(t);
  }, [init, tick]);

  const expRef = useRef(0);
  useEffect(() => {
    let loading = false;
    const load = async () => {
      if (loading) return;
      loading = true;
      const t = await fetch(`/api/qr?room=${id}`).then((r) => r.json());
      expRef.current = t.exp;
      setTok(t);
      loading = false;
    };
    void load();
    const t = setInterval(() => {
      const l = expRef.current - Math.floor(Date.now() / 1000);
      setLeft(Math.max(0, l));
      if (l <= 1) void load();
    }, 1000);
    return () => clearInterval(t);
  }, [id]);

  if (!room?.bookable) return <p className="p-10">Unknown room.</p>;
  const live = today ? liveState(engine, room.id, today, nowMin, today, nowMin) : null;
  const meta = live ? STATE_META[live.state] : null;
  return (
    <main className="grid min-h-dvh place-items-center bg-navy p-6 text-white">
      <div className="grid w-full max-w-3xl items-center gap-8 md:grid-cols-2">
        <div>
          <div className="font-mono text-xs tracking-[0.3em] opacity-60">
            {room.id} · LEVEL {room.floor}
          </div>
          <h1 className="font-display text-5xl font-bold leading-tight">{room.name}</h1>
          {meta && (
            <div className="mt-6 inline-flex items-center gap-2 rounded-full px-4 py-2 text-lg font-semibold" style={{ background: meta.dot }}>
              {meta.label}
              {live?.booking && ` until ${fmtTime(live.booking.end)}`}
            </div>
          )}
          {live?.booking && (
            <p className="mt-3 text-lg opacity-80">
              {live.booking.title} · {live.booking.club ?? live.booking.requester}
            </p>
          )}
          <p className="mt-8 text-sm opacity-60">Scan to check in. Unchecked bookings are released 10 minutes after start.</p>
        </div>
        <div className="rounded-3xl bg-white p-5 text-center text-navy">
          {tok && origin && <QrSvg value={`${origin}/checkin?room=${room.id}&t=${tok.token}`} className="[&>svg]:h-auto [&>svg]:w-full" />}
          <div className="mt-2 font-mono text-xs text-muted">signed code rotates in {left}s</div>
          {tok && origin && (
            <a href={`${origin}/checkin?room=${room.id}&t=${tok.token}`} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs font-semibold text-brand underline">
              No phone? Open this code here
            </a>
          )}
        </div>
      </div>
    </main>
  );
}
