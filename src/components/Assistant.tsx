"use client";

import gsap from "gsap";
import { Flip } from "gsap/Flip";
import { useLayoutEffect, useRef, useState } from "react";
import { KIND_LABEL } from "@/data/campus";
import { PURPOSE_LABEL } from "@/lib/engine";
import { searchAvailability, type BookingIntent, type Option } from "@/lib/intent";
import { fmtDate, fmtTime } from "@/lib/time";
import { forecast } from "@/lib/forecast";
import { myNotices, useStore } from "@/store/useStore";

gsap.registerPlugin(Flip);

const EXAMPLES = ["I need a hall for 80 people with a projector this Friday evening", "Quiet room with a dual monitor right now", "Tutorial room for 15 tomorrow at 11"];

type SpeechCtor = new () => { lang: string; interimResults: boolean; onresult: (e: { results: { 0: { transcript: string } }[] }) => void; onend: () => void; start: () => void };

export function Assistant() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [res, setRes] = useState<{ intent: BookingIntent; options: Option[]; source: string } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const engine = useStore((s) => s.engine);
  const today = useStore((s) => s.today);
  const nowMin = useStore((s) => s.nowMin);
  const set = useStore((s) => s.set);
  const book = useStore((s) => s.book);
  const toast = useStore((s) => s.toast);

  const toggle = () => {
    const el = boxRef.current!;
    const state = Flip.getState(el);
    setOpen((o) => !o);
    requestAnimationFrame(() => Flip.from(state, { duration: 0.45, ease: "power3.inOut", absolute: false }));
  };

  useLayoutEffect(() => {
    if (res && boxRef.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      gsap.from(boxRef.current.querySelectorAll("[data-option]"), { y: 20, opacity: 0, scale: 0.96, stagger: 0.08, duration: 0.4, ease: "back.out(1.4)" });
  }, [res]);

  async function ask(q = text) {
    if (!q.trim()) return;
    setBusy(true);
    try {
      const r = await fetch("/api/assistant", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: q, today, nowMin }) });
      const data = await r.json();
      if (!data.intent) throw new Error(data.error);
      setRes({ intent: data.intent, options: searchAvailability(engine, data.intent, 3, { today, nowMin }), source: data.source });
    } catch {
      toast({ title: "Assistant unavailable", body: "Try again in a moment.", tone: "bad" });
    } finally {
      setBusy(false);
    }
  }

  const listen = () => {
    const W = window as unknown as { SpeechRecognition?: SpeechCtor; webkitSpeechRecognition?: SpeechCtor };
    const Ctor = W.SpeechRecognition ?? W.webkitSpeechRecognition;
    if (!Ctor) return toast({ title: "Voice not supported", body: "This browser has no Web Speech API; type instead.", tone: "warn" });
    const rec = new Ctor();
    rec.lang = "en-IN";
    rec.interimResults = false;
    rec.onresult = (e) => {
      const said = e.results[0][0].transcript;
      setText(said);
      ask(said);
    };
    rec.onend = () => setListening(false);
    setListening(true);
    rec.start();
  };

  const view = (o: Option) => {
    set({ floor: o.room.floor === 1 && o.room.id === "COURT-TURF" ? 1 : o.room.floor, date: o.date, time: o.start, panel: "none" });
    setTimeout(() => set({ selected: o.room.id }), 60);
  };

  const doBook = async (o: Option) => {
    if (!res) return;
    if (res.intent.confidence < 0.8) return toast({ title: "Need one more detail", body: res.intent.clarifying_question ?? "Please be more specific.", tone: "warn" });
    const r = await book({ roomIds: [o.room.id], date: o.date, start: o.start, end: o.end, title: `AI booking · ${PURPOSE_LABEL[res.intent.purpose]}`, purpose: res.intent.purpose, attendees: res.intent.min_capacity ?? 10 });
    toast({ title: r.ok ? (r.booking.status === "pending_approval" ? "Request sent" : "Booked ✓") : "Conflict", body: r.event.text, tone: r.ok ? "ok" : "bad" });
    if (r.ok) view(o);
  };

  return (
    <div ref={boxRef} className={`surface absolute bottom-3 left-3 z-30 overflow-hidden border shadow-2xl ${open ? "w-[min(420px,calc(100%-24px))] rounded-2xl" : "rounded-full"}`}>
      {!open ? (
        <button onClick={toggle} className="flex items-center gap-2 px-4 py-2.5 text-sm font-semibold">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-brand text-xs text-white">✦</span> Ask XIE Spaces
        </button>
      ) : (
        <div className="flex max-h-[70vh] flex-col">
          <div className="flex items-center justify-between border-b border-[var(--line)] px-4 py-2.5">
            <b className="font-display">AI booking assistant</b>
            <button onClick={toggle} aria-label="Close assistant" className="text-xl text-muted">
              ×
            </button>
          </div>
          <div className="scroll-thin flex-1 space-y-3 overflow-y-auto p-4">
            {!res && (
              <div className="space-y-1.5">
                {EXAMPLES.map((e) => (
                  <button key={e} onClick={() => (setText(e), ask(e))} className="block w-full rounded-lg border border-[var(--line)] px-3 py-2 text-left text-xs hover:border-brand">
                    “{e}”
                  </button>
                ))}
              </div>
            )}
            {res && res.intent.intent === "explain" && <Explain />}
            {res && res.intent.intent === "forecast" && <ForecastView kind={res.intent.resource_type} />}
            {res && res.intent.intent !== "explain" && res.intent.intent !== "forecast" && (
              <>
                <details className="rounded-lg bg-black/[.03] p-2 text-[11px]">
                  <summary className="cursor-pointer">
                    Parsed intent ({res.source}) · confidence <b>{res.intent.confidence}</b>
                  </summary>
                  <pre className="mt-1 overflow-x-auto font-mono text-[10px]">{JSON.stringify(res.intent, null, 1)}</pre>
                </details>
                {res.intent.clarifying_question && <p className="rounded-lg bg-pending/10 p-2 text-xs text-pending">{res.intent.clarifying_question}</p>}
                {res.options.length === 0 && <p className="text-xs text-muted">Nothing free that matches. Try another time window.</p>}
                {res.options.map((o, i) => (
                  <div key={o.room.id} data-option className="rounded-xl border border-[var(--line)] p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="text-[10px] font-mono uppercase tracking-widest text-muted">
                          #{i + 1} · fit {o.score}
                        </div>
                        <div className="font-semibold">{o.room.name}</div>
                        <div className="text-xs text-muted">
                          {KIND_LABEL[o.room.kind]} · Level {o.room.floor} · {o.why}
                        </div>
                        <div className="text-xs">
                          {fmtDate(o.date, { weekday: "short", day: "numeric", month: "short" })} · {fmtTime(o.start)}–{fmtTime(o.end)}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex gap-1.5">
                      <button onClick={() => doBook(o)} className="rounded-md bg-free px-3 py-1 text-xs font-semibold text-white">
                        Book
                      </button>
                      <button onClick={() => view(o)} className="rounded-md border border-[var(--line)] px-3 py-1 text-xs">
                        View on map
                      </button>
                    </div>
                  </div>
                ))}
              </>
            )}
          </div>
          <form
            className="flex gap-2 border-t border-[var(--line)] p-3"
            onSubmit={(e) => {
              e.preventDefault();
              ask();
            }}
          >
            <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Describe what you need…" className="min-w-0 flex-1 rounded-md border border-[var(--line)] bg-transparent px-3 py-2 text-sm" aria-label="Ask the assistant" />
            <button type="button" onClick={listen} className={`rounded-md border border-[var(--line)] px-3 ${listening ? "bg-busy text-white" : ""}`} aria-label="Voice input">
              🎙
            </button>
            <button disabled={busy} className="rounded-md bg-brand px-3 text-sm font-semibold text-white disabled:opacity-60">
              {busy ? "…" : "Ask"}
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

/** "Explain why my booking moved": facts come from the decision log, not the LLM. */
function Explain() {
  const engine = useStore((s) => s.engine);
  const me = useStore((s) => s.me);
  const role = useStore((s) => s.role);
  const set = useStore((s) => s.set);
  const n = myNotices({ engine, me, role }).find((x) => x.to === me && (x.kind === "bump" || x.kind === "approval" || x.kind === "negotiation" || x.kind === "counter"));
  const ev = engine.events.find((e) => e.text.includes(me));
  if (!n && !ev) return <p className="rounded-lg bg-black/[.03] p-3 text-xs">None of your bookings have been moved, rejected or contested. 🎉</p>;
  return (
    <div className="space-y-2 rounded-xl border border-[var(--line)] p-3 text-xs" data-option>
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted">From the decision log</div>
      <p className="leading-relaxed">{n?.text ?? ev?.text}</p>
      {n?.alts && n.alts.length > 0 && <p className="text-muted">{n.alts.length} rebooking offers are waiting in your notifications.</p>}
      <button onClick={() => set({ panel: n ? "notifications" : "conflicts" })} className="rounded-md border border-[var(--line)] px-3 py-1">
        {n ? "Open notifications" : "Open conflict center"}
      </button>
    </div>
  );
}

function ForecastView({ kind }: { kind: BookingIntent["resource_type"] }) {
  const engine = useStore((s) => s.engine);
  const today = useStore((s) => s.today);
  const rows = forecast(engine, today, kind && kind !== "outdoor" && kind !== "meeting" ? [kind] : undefined);
  const LABEL: Record<string, string> = { lab: "Labs", lh: "Lecture halls", tutorial: "Tutorial rooms", seminar: "Seminar Hall", study: "Library" };
  return (
    <div className="space-y-3 rounded-xl border border-[var(--line)] p-3 text-xs" data-option>
      <div className="font-mono text-[10px] uppercase tracking-widest text-muted">Next 7 days · forecast from the last 14 days</div>
      {rows.map((r) => (
        <div key={r.kind}>
          <div className="mb-1 flex justify-between">
            <b>{LABEL[r.kind] ?? r.kind}</b>
            <span>~{Math.round(r.nextWeekAvg * 100)}% booked</span>
          </div>
          <div className="flex h-10 items-end gap-1">
            {r.days.map((d) => (
              <div key={d.date} className="flex-1 rounded-t bg-brand/70" style={{ height: `${Math.max(4, d.utilisation * 100)}%` }} title={`${d.date}: ${Math.round(d.utilisation * 100)}%`} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
