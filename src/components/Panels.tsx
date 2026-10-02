"use client";

import gsap from "gsap";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BOOKABLE_ROOMS, FLOORS, ROOM_BY_ID } from "@/data/campus";
import { PURPOSE_LABEL } from "@/lib/engine";
import { DAY_END, DAY_START, fmtDate, fmtTime, pad } from "@/lib/time";
import { HOLDING, type Booking, type DecisionKind } from "@/lib/types";
import { ME, roomName, useStore } from "@/store/useStore";
import { ScoreBars } from "./ScoreBars";

export function PanelDrawer() {
  const panel = useStore((s) => s.panel);
  const set = useStore((s) => s.set);
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (panel !== "none" && ref.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      gsap.from(ref.current, { xPercent: 105, duration: 0.45, ease: "power3.out" });
  }, [panel]);
  if (panel === "none") return null;
  const titles = { bookings: "My bookings", approvals: "Approver console", conflicts: "Conflict center", chaos: "Digital Twin · Simulate Chaos", admin: "Analytics" } as const;
  return (
    <aside ref={ref} className="surface absolute inset-y-0 right-0 z-30 flex w-full flex-col border-l shadow-2xl md:w-[460px]" aria-label={titles[panel]}>
      <div className="flex items-center justify-between border-b border-[var(--line)] px-5 py-3">
        <h2 className="font-display text-xl font-semibold">{titles[panel]}</h2>
        <button onClick={() => set({ panel: "none" })} className="grid h-8 w-8 place-items-center rounded-full text-xl hover:bg-black/5" aria-label="Close panel">
          ×
        </button>
      </div>
      <div className="scroll-thin flex-1 overflow-y-auto px-5 py-4">
        {panel === "bookings" && <MyBookings />}
        {panel === "approvals" && <Approvals />}
        {panel === "conflicts" && <Conflicts />}
        {panel === "chaos" && <Chaos />}
        {panel === "admin" && <Analytics />}
      </div>
    </aside>
  );
}

const STATUS_DOT: Record<string, string> = {
  confirmed: "bg-busy",
  pending_approval: "bg-pending",
  checked_in: "bg-inuse",
  completed: "bg-gray-400",
  cancelled: "bg-gray-300",
  no_show: "bg-gray-500",
  bumped: "bg-pending",
};

function BookingRow({ b, children }: { b: Booking; children?: React.ReactNode }) {
  return (
    <li className="rounded-lg border border-[var(--line)] p-3 text-sm">
      <div className="flex items-start gap-2">
        <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[b.status]}`} />
        <div className="min-w-0 flex-1">
          <div className="font-semibold">{b.roomIds.map(roomName).join(" + ")}</div>
          <div className="text-xs text-muted">
            {fmtDate(b.date, { weekday: "short", day: "numeric", month: "short" })} · {fmtTime(b.start)}–{fmtTime(b.end)} · {b.status.replace("_", " ")}
          </div>
          <div className="truncate text-xs">
            {b.title} · {PURPOSE_LABEL[b.purpose]} · {b.attendees} ppl
          </div>
        </div>
      </div>
      {children && <div className="mt-2 flex flex-wrap gap-1.5 pl-4">{children}</div>}
    </li>
  );
}

const Btn = ({ onClick, children, tone = "plain" }: { onClick: () => void; children: React.ReactNode; tone?: "plain" | "ok" | "bad" | "blue" }) => (
  <button
    onClick={onClick}
    className={`rounded-md px-2.5 py-1 text-xs font-medium ${tone === "ok" ? "bg-free text-white" : tone === "bad" ? "bg-busy text-white" : tone === "blue" ? "bg-inuse text-white" : "border border-[var(--line)] hover:bg-black/5"}`}
  >
    {children}
  </button>
);

function ics(b: Booking) {
  const d = b.date.replace(/-/g, "");
  const t = (m: number) => `${pad(Math.floor(m / 60))}${pad(m % 60)}00`;
  const body = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//XIE Spaces//EN",
    "BEGIN:VEVENT",
    `UID:${b.id}@xie-spaces`,
    `DTSTART;TZID=Asia/Kolkata:${d}T${t(b.start)}`,
    `DTEND;TZID=Asia/Kolkata:${d}T${t(b.end)}`,
    `SUMMARY:${b.title}`,
    `LOCATION:${b.roomIds.map(roomName).join(" + ")}, Xavier Institute of Engineering`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/calendar" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: `${b.id}.ics` });
  a.click();
  URL.revokeObjectURL(url);
}

/** Rotating QR-style token (60 s TTL). Visual stand-in for the signed JWT check-in code. */
function QrToken({ seed }: { seed: string }) {
  const [epoch, setEpoch] = useState(() => Math.floor(Date.now() / 60000));
  const [left, setLeft] = useState(60);
  useEffect(() => {
    const t = setInterval(() => {
      setEpoch(Math.floor(Date.now() / 60000));
      setLeft(60 - (Math.floor(Date.now() / 1000) % 60));
    }, 1000);
    return () => clearInterval(t);
  }, []);
  const cells = useMemo(() => {
    let h = 2166136261;
    for (const c of `${seed}:${epoch}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return Array.from({ length: 121 }, (_, i) => ((h = Math.imul(h ^ i, 16777619)) >>> 0) % 3 === 0);
  }, [seed, epoch]);
  return (
    <div className="flex items-center gap-3">
      <svg viewBox="0 0 11 11" className="h-20 w-20 rounded bg-white p-1" shapeRendering="crispEdges" aria-label="Rotating check-in QR">
        {cells.map((on, i) => on && <rect key={i} x={i % 11} y={Math.floor(i / 11)} width={1} height={1} fill="#1f2933" />)}
        {[0, 8].map((x) => [0, 8].map((y) => !(x === 8 && y === 8) && <rect key={`${x}${y}`} x={x} y={y} width={3} height={3} fill="none" stroke="#1f2933" strokeWidth={0.8} />))}
      </svg>
      <div className="text-[11px] text-muted">
        Signed token rotates in <b className="tabular-nums text-ink dark:text-white">{left}s</b>
        <br />
        Scan at the room door to check in.
      </div>
    </div>
  );
}

function MyBookings() {
  const role = useStore((s) => s.role);
  const today = useStore((s) => s.today);
  const bookings = useStore((s) => s.engine.bookings);
  const act = useStore((s) => s.act);
  const me = ME[role];
  const mine = bookings.filter((b) => b.requester === me).sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const upcoming = mine.filter((b) => HOLDING.includes(b.status));
  const past = mine.filter((b) => !HOLDING.includes(b.status));
  const [qr, setQr] = useState<string | null>(null);
  return (
    <div className="space-y-5">
      <p className="text-xs text-muted">
        Showing bookings for <b>{me}</b>. Click a room on the map to book.
      </p>
      <section>
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">Upcoming ({upcoming.length})</h3>
        <ul className="space-y-2">
          {upcoming.length === 0 && <li className="text-sm text-muted">No upcoming bookings yet.</li>}
          {upcoming.map((b) => (
            <BookingRow key={b.id} b={b}>
              {b.status === "confirmed" && b.date === today && (
                <Btn tone="blue" onClick={() => setQr(qr === b.id ? null : b.id)}>
                  QR check-in
                </Btn>
              )}
              {b.status === "checked_in" && <Btn onClick={() => act("release", b.id)}>Release early</Btn>}
              {b.status !== "checked_in" && <Btn onClick={() => act("cancel", b.id)}>Cancel</Btn>}
              {b.status === "confirmed" && <Btn onClick={() => act("noshow", b.id)}>Simulate no-show</Btn>}
              <Btn onClick={() => ics(b)}>.ics</Btn>
              {qr === b.id && (
                <div className="mt-2 w-full space-y-2">
                  <QrToken seed={b.id} />
                  <Btn tone="ok" onClick={() => (act("checkin", b.id), setQr(null))}>
                    Simulate scan ✓
                  </Btn>
                </div>
              )}
            </BookingRow>
          ))}
        </ul>
      </section>
      {past.length > 0 && (
        <section>
          <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">History</h3>
          <ul className="space-y-2 opacity-80">
            {past.slice(-10).reverse().map((b) => (
              <BookingRow key={b.id} b={b} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Approvals() {
  const role = useStore((s) => s.role);
  const today = useStore((s) => s.today);
  const bookings = useStore((s) => s.engine.bookings);
  const events = useStore((s) => s.engine.events);
  const act = useStore((s) => s.act);
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (role !== "approver" && role !== "admin")
    return <p className="text-sm text-muted">Switch to approver@xie.demo or admin@xie.demo (top right) to work the approval queue.</p>;
  const queue = bookings.filter((b) => b.status === "pending_approval" && b.date >= today).sort((a, b) => (a.date + pad(a.start)).localeCompare(b.date + pad(b.start)));
  const escalated = new Set(events.filter((e) => e.kind === "escalated").map((e) => e.bookingId));
  // Demo SLA: 4 h compressed to 4 min (1 h for exams) so escalation is visible live.
  const sla = (b: Booking) => (b.purpose === "exam" ? 60 : 240) * 1000 - (Date.now() - b.createdAt);
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted">{queue.length} pending · SLA 4 h (1 h exams), compressed to minutes for the demo. Unactioned requests escalate to the secondary approver.</p>
      <ul className="space-y-2">
        {queue.slice(0, 40).map((b) => {
          const left = sla(b);
          const late = left <= 0;
          return (
            <BookingRow key={b.id} b={b}>
              <span className={`mr-auto rounded px-1.5 py-0.5 font-mono text-[10px] ${late || escalated.has(b.id) ? "bg-busy/15 text-busy" : "bg-pending/15 text-pending"}`}>
                {escalated.has(b.id) ? "ESCALATED" : late ? "SLA breached" : `SLA ${Math.floor(left / 60000)}:${pad(Math.floor((left % 60000) / 1000))}`}
              </span>
              <span className="w-full pb-1 text-[11px] text-muted">
                {b.requester} · pool: {ROOM_BY_ID.get(b.roomIds[0])?.pool}
              </span>
              <Btn tone="ok" onClick={() => act("approve", b.id)}>
                Approve
              </Btn>
              <Btn tone="bad" onClick={() => act("reject", b.id)}>
                Reject
              </Btn>
              {!escalated.has(b.id) && <Btn onClick={() => act("escalate", b.id)}>Escalate</Btn>}
            </BookingRow>
          );
        })}
      </ul>
    </div>
  );
}

const KIND_STYLE: Partial<Record<DecisionKind, string>> = {
  confirmed: "bg-free/15 text-free",
  approved: "bg-free/15 text-free",
  checked_in: "bg-inuse/15 text-inuse",
  pending: "bg-pending/15 text-pending",
  bumped: "bg-busy/15 text-busy",
  negotiate: "bg-pending/15 text-pending",
  share: "bg-inuse/15 text-inuse",
  rejected_rule: "bg-gray-400/20 text-gray-600",
  rejected_conflict: "bg-busy/15 text-busy",
  escalated: "bg-busy/15 text-busy",
  no_show: "bg-gray-400/20 text-gray-600",
  promoted: "bg-free/15 text-free",
};

export function DecisionLog({ limit = 60 }: { limit?: number }) {
  const events = useStore((s) => s.engine.events);
  const [open, setOpen] = useState<string | null>(null);
  if (!events.length) return <p className="text-sm text-muted">No decisions yet. Book a room or hit Simulate Chaos.</p>;
  return (
    <ol className="space-y-2">
      {events.slice(0, limit).map((e) => (
        <li key={e.id} className="rounded-lg border border-[var(--line)] p-2.5 text-xs">
          <button className="w-full text-left" onClick={() => setOpen(open === e.id ? null : e.id)}>
            <div className="mb-1 flex items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${KIND_STYLE[e.kind] ?? "bg-black/5"}`}>{e.kind.replace("_", " ")}</span>
              <span className="font-mono text-[10px] text-muted">{new Date(e.at).toLocaleTimeString("en-IN", { hour12: false })}</span>
              {e.winnerScore && <span className="ml-auto text-[10px] text-brand">scores ▾</span>}
            </div>
            <p className="leading-relaxed">{e.text}</p>
          </button>
          {open === e.id && e.winnerScore && e.loserScore && <ScoreBars a={e.winnerScore} b={e.loserScore} aLabel="Winner" bLabel="Other party" />}
        </li>
      ))}
    </ol>
  );
}

function Conflicts() {
  const bumps = useStore((s) => s.engine.bumps);
  return (
    <div className="space-y-5">
      <section className="rounded-lg bg-black/[.03] p-3 text-xs leading-relaxed">
        <b>How decisions are made.</b> Rules gate (blackouts, eligibility, capacity, advance window) → priority score{" "}
        <code className="font-mono">0.40·purpose + 0.20·role + 0.15·urgency + 0.15·fairness + 0.10·usage</code>. Beat the holder by ≥15 → bump with 3 rebooking offers. Within 15 → negotiation. Capacity allows → share probe. The exclusion constraint is the final arbiter.
      </section>
      <section>
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">Fairness ledger (bumps suffered)</h3>
        <div className="flex flex-wrap gap-1.5">
          {Object.entries(bumps)
            .sort((a, b) => b[1] - a[1])
            .map(([who, n]) => (
              <span key={who} className={`rounded-full border px-2 py-0.5 text-xs ${n >= 3 ? "border-free text-free" : "border-[var(--line)]"}`}>
                {who}: {n}
                {n >= 3 ? " · boost" : ""}
              </span>
            ))}
        </div>
      </section>
      <section>
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">Decision log</h3>
        <DecisionLog />
      </section>
    </div>
  );
}

function Chaos() {
  const c = useStore((s) => s.chaos);
  const reset = useStore((s) => s.reset);
  const runChaos = useStore((s) => s.runChaos);
  const optimise = useStore((s) => s.optimise);
  const tiles: [string, number, string][] = [
    ["Requests", c.sent, ""],
    ["Confirmed", c.confirmed, "text-free"],
    ["Pending", c.pending, "text-pending"],
    ["Conflicts", c.conflicts, "text-busy"],
    ["Bumped", c.bumped, "text-busy"],
    ["Negotiated", c.negotiated, "text-pending"],
    ["Share probes", c.shared, "text-inuse"],
    ["Rule/held", c.rejected, ""],
    ["Escalated", c.escalated, "text-busy"],
  ];
  return (
    <div className="space-y-4">
      <p className="text-xs text-muted">50 random requests (mixed roles, overlapping slots, bundles, over-capacity, exam blackout) stream into the engine at 5/s. Watch the map.</p>
      <div className="h-1.5 overflow-hidden rounded bg-black/10">
        <div className="h-full bg-brand transition-all" style={{ width: `${(c.sent / c.total) * 100}%` }} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        {tiles.map(([label, n, cls]) => (
          <div key={label} className="rounded-lg border border-[var(--line)] p-2">
            <div className={`font-display text-2xl font-bold tabular-nums ${cls}`}>{n}</div>
            <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
          </div>
        ))}
      </div>
      <div className={`rounded-lg border-2 p-3 text-center ${c.doubleBookings === 0 ? "border-free bg-free/10" : "border-busy bg-busy/10"}`}>
        <div className="font-display text-4xl font-bold tabular-nums">{c.doubleBookings}</div>
        <div className="text-xs font-semibold uppercase tracking-wide">double bookings</div>
        <div className="text-[10px] text-muted">verified by scanning every holding pair (the exclusion constraint&apos;s invariant)</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Btn tone="blue" onClick={runChaos}>
          Run again
        </Btn>
        <Btn onClick={optimise}>Before/After optimisation</Btn>
        <Btn onClick={reset}>Reset to seed</Btn>
      </div>
      {c.optimised && (
        <p className="rounded-lg bg-black/[.03] p-2 text-xs">
          Optimiser re-seated <b>{c.optimised.moved}</b> bumped bookings into least-disruption alternatives. Today&apos;s utilisation {c.optimised.before}% → <b>{c.optimised.after}%</b>.
        </p>
      )}
      <h3 className="font-mono text-[10px] uppercase tracking-widest text-muted">Live decision log</h3>
      <DecisionLog limit={25} />
    </div>
  );
}

function Analytics() {
  const engine = useStore((s) => s.engine);
  const today = useStore((s) => s.today);
  const floor = useStore((s) => s.floor);
  const hours = Array.from({ length: (DAY_END - DAY_START) / 60 }, (_, i) => DAY_START / 60 + i);
  const rooms = FLOORS[floor].filter((r) => r.bookable);
  const recent = engine.bookings.filter((b) => b.date <= today && b.date >= addDaysLocal(today, -14));
  const heat = rooms.map((r) =>
    hours.map((h) => {
      const mins = recent.filter((b) => b.roomIds.includes(r.id) && b.status !== "cancelled" && b.start < (h + 1) * 60 && b.end > h * 60).length;
      return mins / 12;
    }),
  );
  const done = recent.filter((b) => b.status === "completed" || b.status === "no_show");
  const ghostRate = done.length ? Math.round((done.filter((b) => b.status === "no_show").length / done.length) * 100) : 0;
  const util = Math.round((recent.filter((b) => b.status !== "cancelled").reduce((m, b) => m + b.end - b.start, 0) / (BOOKABLE_ROOMS.length * 12 * 60 * 12)) * 100);
  // Solar vs load: simple bell curve for rooftop PV against booked-room HVAC/lighting load.
  const solar = hours.map((h) => Math.max(0, Math.round(60 * Math.sin(((h - 6.5) / 12.5) * Math.PI))));
  const load = hours.map((h) => Math.round(engine.bookings.filter((b) => b.date === today && HOLDING.concat("completed").includes(b.status) && b.start < (h + 1) * 60 && b.end > h * 60).length * 1.4));
  const points = Object.entries(engine.points).sort((a, b) => b[1] - a[1]).slice(0, 6);
  return (
    <div className="space-y-5 text-xs">
      <div className="grid grid-cols-3 gap-2">
        <Stat label="Utilisation (14d)" value={`${util}%`} />
        <Stat label="Ghost-booking rate" value={`${ghostRate}%`} />
        <Stat label="Forecast: labs next wk" value="~88%" />
      </div>
      <section>
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">Utilisation heatmap · Level {floor} · last 14 days</h3>
        <div className="grid gap-px" style={{ gridTemplateColumns: `90px repeat(${hours.length}, 1fr)` }}>
          <span />
          {hours.map((h) => (
            <span key={h} className="text-center font-mono text-[9px] text-muted">
              {h}
            </span>
          ))}
          {rooms.map((r, i) => (
            <Row key={r.id} label={r.short} cells={heat[i]} />
          ))}
        </div>
      </section>
      <section>
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">Rooftop solar vs room load · today (kW)</h3>
        <svg viewBox="0 0 240 90" className="w-full">
          {hours.map((h, i) => (
            <g key={h}>
              <rect x={i * 20 + 3} y={80 - solar[i]} width={7} height={solar[i]} fill="#f2c14e" rx={1} />
              <rect x={i * 20 + 11} y={80 - Math.min(75, load[i])} width={7} height={Math.min(75, load[i])} fill="#1d4ed8" rx={1} />
              <text x={i * 20 + 10} y={89} fontSize={6} textAnchor="middle" fill="#6b7280">
                {h}
              </text>
            </g>
          ))}
        </svg>
        <p className="mt-1 text-muted">
          <span className="text-[#c99a1e]">■</span> solar <span className="ml-2 text-brand">■</span> load. Consolidating 2 half-empty afternoon lectures into LH 3 would save ~6 kWh today.
        </p>
      </section>
      <section>
        <h3 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">Responsible clubs leaderboard</h3>
        <ol className="space-y-1">
          {points.map(([who, p], i) => (
            <li key={who} className="flex justify-between rounded bg-black/[.03] px-2 py-1">
              <span>
                {i + 1}. {who}
              </span>
              <b>{p} pts</b>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

const Stat = ({ label, value }: { label: string; value: string }) => (
  <div className="rounded-lg border border-[var(--line)] p-2">
    <div className="font-display text-2xl font-bold">{value}</div>
    <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
  </div>
);

const Row = ({ label, cells }: { label: string; cells: number[] }) => (
  <>
    <span className="truncate pr-1 text-[10px]">{label}</span>
    {cells.map((v, i) => (
      <span key={i} className="h-4 rounded-[2px]" style={{ background: `rgba(29,78,216,${Math.min(1, 0.06 + v)})` }} title={`${Math.round(v * 100)}%`} />
    ))}
  </>
);

function addDaysLocal(date: string, n: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
