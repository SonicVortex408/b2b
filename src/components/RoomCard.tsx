"use client";

import gsap from "gsap";
import { Flip } from "gsap/Flip";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { BOOKABLE_ROOMS, describe, KIND_LABEL, ROOM_BY_ID } from "@/data/campus";
import { HOLD_MS, initialStatus, previewBooking, PURPOSE_LABEL, score } from "@/lib/engine";
import { bookingsFor, freeSlots, liveState, STATE_META } from "@/lib/status";
import { DAY_END, DAY_START, fmtDate, fmtTime } from "@/lib/time";
import type { BookResult, Purpose, Room } from "@/lib/types";
import { roomName, useStore } from "@/store/useStore";
import { useT } from "@/i18n";
import { FloorMap } from "./FloorMap";
import { ScoreBars } from "./ScoreBars";

gsap.registerPlugin(Flip);

export interface Origin {
  left: number;
  top: number;
  width: number;
  height: number;
  fill: string;
}

const reduced = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function RoomCard({ room, origin, onClose }: { room: Room; origin: Origin; onClose: () => void }) {
  const cardRef = useRef<HTMLDivElement>(null);
  const proxyRef = useRef<HTMLDivElement>(null);
  const closing = useRef(false);
  const engine = useStore((s) => s.engine);
  const date = useStore((s) => s.date);
  const time = useStore((s) => s.time);
  const today = useStore((s) => s.today);
  const nowMin = useStore((s) => s.nowMin);
  const role = useStore((s) => s.role);
  const me = useStore((s) => s.me);
  const book = useStore((s) => s.book);
  const act = useStore((s) => s.act);
  const waitlist = useStore((s) => s.waitlist);
  const setStore = useStore((s) => s.set);

  const [dur, setDur] = useState(60);
  const [purpose, setPurpose] = useState<Purpose>(role === "student" ? "casual" : "academic_class");
  const [attendees, setAttendees] = useState(Math.min(room.capacity ?? 10, role === "student" ? 6 : Math.round((room.capacity ?? 20) * 0.8)));
  const [title, setTitle] = useState("");
  const [more, setMore] = useState(false);
  const [result, setResult] = useState<BookResult | null>(null);
  const [extra, setExtra] = useState("");
  const [pick, setPick] = useState<{ start: number; roomId: string; date: string; expires: number } | null>(null);
  const [, tickNow] = useState(0);
  const dispatch = useStore((s) => s.dispatch);
  const t = useT();

  const live = liveState(engine, room.id, date, time, today, nowMin);
  const meta = STATE_META[live.state];
  const startFrom = date === today ? Math.max(time, Math.ceil(nowMin / 15) * 15) : time;
  const slots = useMemo(() => freeSlots(engine, room.id, date, startFrom, dur, more ? 16 : 8), [engine, room.id, date, startFrom, dur, more]);
  const day = bookingsFor(engine, room.id, date);
  const nextSlot = slots[0];
  const needsApproval = initialStatus({ roomIds: [room.id], date, start: 0, end: 0, title: "", requester: "", role, purpose, attendees }) === "pending_approval";
  const myScore = score(engine, { purpose, role, date, start: startFrom, requester: me }, { today, nowMin });

  // ---- GSAP Flip: the room shape expands into this card
  useLayoutEffect(() => {
    const card = cardRef.current!;
    const proxy = proxyRef.current!;
    const content = card.querySelectorAll("[data-stagger]");
    if (reduced()) return;
    // gsap.context + revert: under React StrictMode (dev) effects run twice; reverting restores the
    // original styles so a killed half-finished tween can't leave the card content invisible.
    const ctx = gsap.context(() => {
      Flip.fit(card, proxy, { scale: false, absolute: true });
      const state = Flip.getState(card);
      gsap.set(card, { clearProps: "left,top,width,height,transform,position" });
      Flip.from(state, { duration: 0.6, ease: "power3.inOut", absolute: true, scale: false });
      gsap.fromTo(card, { backgroundColor: origin.fill.startsWith("url") ? "#fdecea" : origin.fill, borderRadius: 2 }, { backgroundColor: getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#fff", borderRadius: 18, duration: 0.6, ease: "power2.out", clearProps: "backgroundColor" });
      gsap.from(content, { opacity: 0, y: 12, duration: 0.35, stagger: 0.04, delay: 0.35, ease: "power2.out" });
    }, card);
    return () => ctx.revert();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id]);

  const close = () => {
    if (closing.current) return;
    closing.current = true;
    const card = cardRef.current!;
    if (reduced()) return onClose();
    gsap.to(card.querySelectorAll("[data-stagger]"), { opacity: 0, duration: 0.15 });
    gsap.to(card, { backgroundColor: origin.fill.startsWith("url") ? "#fdecea" : origin.fill, borderRadius: 2, duration: 0.45 });
    Flip.fit(card, proxyRef.current!, { scale: false, absolute: true, duration: 0.45, ease: "power3.inOut", onComplete: onClose });
  };

  const roomsFor = (roomId: string) => (extra && extra !== roomId ? [roomId, extra] : [roomId]);
  const reqFor = (start: number, roomId = room.id, d = date) => ({ roomIds: roomsFor(roomId), date: d, start, end: start + dur, title: title || `${PURPOSE_LABEL[purpose]} · ${me}`, requester: me, role, purpose, attendees });

  // Step 1: pick a time → 90 s soft-hold + live conflict preview. Step 2: confirm.
  const selectSlot = (start: number, roomId = room.id, d = date) => {
    setResult(null);
    setPick({ start, roomId, date: d, expires: Date.now() + HOLD_MS });
    void dispatch({ type: "hold", roomIds: roomsFor(roomId), date: d, start, end: start + dur }, true);
  };
  const cancelPick = () => {
    setPick(null);
    void dispatch({ type: "unhold" }, true);
  };
  useEffect(() => {
    if (!pick) return;
    const t = setInterval(() => {
      if (Date.now() > pick.expires) cancelPick();
      else tickNow((x) => x + 1);
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick]);
  useEffect(() => () => void useStore.getState().dispatch({ type: "unhold" }, true), []);

  const preview = useMemo(() => (pick ? previewBooking(engine, reqFor(pick.start, pick.roomId, pick.date), { today, nowMin }) : null), [pick, engine, dur, purpose, attendees, extra, today, nowMin]); // eslint-disable-line react-hooks/exhaustive-deps

  const doBook = async (start: number, roomId = room.id, d = date) => {
    const { requester: _r, role: _ro, ...req } = reqFor(start, roomId, d);
    void _r;
    void _ro;
    const res = await book(req);
    setPick(null);
    setResult(res);
    if (res.ok && roomId !== room.id) setStore({ selected: roomId });
  };

  const verb = needsApproval ? "Request" : "Book";

  return (
    <>
      <div
        ref={proxyRef}
        aria-hidden
        className="pointer-events-none fixed"
        style={{ left: origin.left, top: origin.top, width: origin.width, height: origin.height }}
      />
      <div
        ref={cardRef}
        role="dialog"
        aria-label={`${room.name} details`}
        className="surface fixed inset-x-2 bottom-2 top-24 z-40 flex flex-col overflow-hidden rounded-[18px] border shadow-2xl md:absolute md:inset-auto md:right-4 md:top-4 md:bottom-4 md:w-[400px]"
        onKeyDown={(e) => e.key === "Escape" && close()}
      >
        <header className="relative bg-brand px-5 py-3 text-center text-white">
          <div className="font-display text-lg font-semibold leading-tight">{room.name}</div>
          <div className="text-xs opacity-80">
            {room.id} · Floor {room.floor} · {fmtDate(date, { weekday: "short", day: "numeric", month: "short" })}
          </div>
          <button onClick={close} aria-label="Close" className="absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full text-xl leading-none hover:bg-white/15">
            ×
          </button>
        </header>

        <div className="scroll-thin flex-1 space-y-5 overflow-y-auto px-5 py-4">
          <section data-stagger className="text-center">
            <p className="text-[15px]">
              {live.state === "free" ? (
                <>
                  <b>{t("card.available")}</b>
                </>
              ) : (
                <>
                  This space is <b style={{ color: meta.dot }}>{meta.label.toLowerCase()}</b>
                  {live.booking ? ` until ${fmtTime(live.booking.end)}` : ""}
                </>
              )}
            </p>
            {live.booking && (
              <p className="mt-1 text-xs text-muted">
                {live.booking.title} · {live.booking.club ?? live.booking.requester}
              </p>
            )}
            <button
              disabled={nextSlot == null}
              onClick={() => nextSlot != null && selectSlot(nextSlot)}
              className="mt-3 w-full rounded-md bg-free py-2.5 text-sm font-semibold text-white shadow-sm transition hover:brightness-110 disabled:cursor-not-allowed disabled:bg-gray-300 disabled:text-gray-600"
            >
              {nextSlot != null ? `${t(needsApproval ? "card.request" : "card.book")} ${fmtTime(nextSlot)}` : "No free slots left today"}
            </button>
            {live.state !== "free" && (
              <button
                onClick={() => waitlist({ roomIds: [room.id], date, start: time, end: time + dur, title: title || "Waitlisted", purpose, attendees })}
                className="mt-2 w-full rounded-md border border-[var(--line)] py-2 text-sm font-medium hover:bg-black/5"
              >
                {t("card.waitlist")} {fmtTime(time)}
              </button>
            )}
            {live.state !== "free" && live.booking && (
              <button onClick={() => selectSlot(time - (time % 15))} className="mt-2 w-full rounded-md border border-dashed border-[var(--line)] py-2 text-xs text-muted hover:bg-black/5">
                Request {fmtTime(time - (time % 15))} anyway (see who wins)
              </button>
            )}
            {needsApproval && <p className="mt-2 text-[11px] text-pending">Goes to the {room.pool} pool for approval (slot is soft-held meanwhile).</p>}
          </section>

          {pick && preview && (
            <section className="rounded-lg border-2 border-brand/40 bg-brand/5 p-3 text-xs" role="status" aria-live="polite">
              <div className="mb-1 flex items-center justify-between">
                <b>
                  {roomsFor(pick.roomId).map((id) => ROOM_BY_ID.get(id)?.short).join(" + ")} · {fmtTime(pick.start)}–{fmtTime(pick.start + dur)}
                </b>
                <span className="rounded bg-pending/15 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-pending" title="Soft-hold: others can't take this slot while you confirm">
                  held {Math.max(0, Math.ceil((pick.expires - Date.now()) / 1000))}s
                </span>
              </div>
              <p className={`leading-relaxed ${{ confirm: "text-free", pending: "text-pending", bump: "text-busy", negotiate: "text-pending", share: "text-inuse", conflict: "text-busy", rule: "text-busy" }[preview.decision]}`}>{preview.text}</p>
              {preview.theirs && <ScoreBars a={preview.mine} b={preview.theirs} aLabel="You" bLabel="Holder" />}
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button onClick={cancelPick} className="rounded-md border border-[var(--line)] py-1.5">
                  Cancel
                </button>
                <button disabled={preview.decision === "rule"} onClick={() => doBook(pick.start, pick.roomId, pick.date)} className="rounded-md bg-free py-1.5 font-semibold text-white disabled:bg-gray-300">
                  {preview.decision === "pending" ? "Send request" : preview.decision === "confirm" || preview.decision === "bump" ? "Confirm booking" : "Submit anyway"}
                </button>
              </div>
            </section>
          )}

          {result && <Outcome result={result} onPick={(a) => selectSlot(a.start, a.roomId, a.date)} onDismiss={() => setResult(null)} />}

          <section data-stagger className="grid grid-cols-2 gap-2 text-xs">
            <label className="col-span-2 flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted">Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. DBMS Practical · SE Comp A" className="rounded-md border border-[var(--line)] bg-transparent px-2 py-1.5" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted">Purpose</span>
              <select value={purpose} onChange={(e) => setPurpose(e.target.value as Purpose)} className="rounded-md border border-[var(--line)] bg-transparent px-2 py-1.5">
                {Object.entries(PURPOSE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted">Attendees</span>
              <input type="number" min={1} value={attendees} onChange={(e) => setAttendees(Number(e.target.value))} className="rounded-md border border-[var(--line)] bg-transparent px-2 py-1.5" />
            </label>
            <label className="col-span-2 flex flex-col gap-1">
              <span className="font-mono text-[10px] uppercase tracking-widest text-muted">Bundle with (all-or-nothing)</span>
              <select value={extra} onChange={(e) => setExtra(e.target.value)} className="rounded-md border border-[var(--line)] bg-transparent px-2 py-1.5">
                <option value="">Just this room</option>
                {BOOKABLE_ROOMS.filter((r) => r.id !== room.id).map((r) => (
                  <option key={r.id} value={r.id}>
                    + {r.name} (L{r.floor}, {r.capacity})
                  </option>
                ))}
              </select>
            </label>
            <div className="col-span-2 flex items-center gap-1.5">
              <span className="mr-1 font-mono text-[10px] uppercase tracking-widest text-muted">Length</span>
              {[30, 60, 90, 120].map((d) => (
                <button key={d} onClick={() => setDur(d)} className={`rounded-full border px-2.5 py-1 ${dur === d ? "border-brand bg-brand text-white" : "border-[var(--line)] hover:bg-black/5"}`}>
                  {d < 60 ? `${d}m` : `${d / 60}h`}
                </button>
              ))}
              <span className="ml-auto font-mono text-[10px] text-muted" title="0.40·purpose + 0.20·role + 0.15·urgency + 0.15·fairness + 0.10·usage">
                priority {myScore.total}
              </span>
            </div>
          </section>

          <section data-stagger>
            <h4 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">{t("card.otherTimes")}</h4>
            <div className="grid grid-cols-4 gap-1.5">
              {slots.slice(1, more ? 16 : 8).map((t) => (
                <button key={t} onClick={() => selectSlot(t)} className="rounded-md border border-free/60 py-1.5 text-xs font-medium text-free transition hover:bg-free hover:text-white">
                  {fmtTime(t)}
                </button>
              ))}
              <button onClick={() => setMore((m) => !m)} className="rounded-md border border-[var(--line)] py-1.5 text-xs text-muted hover:bg-black/5">
                {more ? "Less" : "More ▾"}
              </button>
            </div>
          </section>

          <section data-stagger>
            <h4 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">{t("card.timeline")}</h4>
            <Timeline bookings={day} time={time} onPick={(t) => setStore({ time: t })} />
          </section>

          <section data-stagger>
            <h4 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">{t("card.scheduled")}</h4>
            <ul className="space-y-1.5">
              {day.length === 0 && <li className="text-xs text-muted">Nothing booked yet.</li>}
              {day.map((b) => {
                const m = STATE_META[b.status === "pending_approval" ? "pending" : b.status === "checked_in" ? "inuse" : b.status === "completed" ? "blackout" : "booked"];
                const mine = b.requester === me;
                return (
                  <li key={b.id} className="flex items-start gap-2 rounded-md border-l-4 bg-black/[.03] px-2 py-1.5 text-xs" style={{ borderColor: m.dot }}>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">
                        {fmtTime(b.start)} – {fmtTime(b.end)} <span className="text-muted">· {b.status.replace("_", " ")}</span>
                      </div>
                      <div className="truncate text-muted">
                        {b.title} · {b.club ?? b.requester}
                      </div>
                    </div>
                    {mine && b.status !== "completed" && (
                      <div className="flex gap-1">
                        {b.status === "confirmed" && (
                          <button className="rounded bg-inuse px-1.5 py-0.5 text-white" onClick={() => act("checkin", b.id)}>
                            Check in
                          </button>
                        )}
                        <button className="rounded border border-[var(--line)] px-1.5 py-0.5" onClick={() => act(b.status === "checked_in" ? "release" : "cancel", b.id)}>
                          {b.status === "checked_in" ? "Release" : "Cancel"}
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          <section data-stagger>
            <h4 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-muted">Visuals &amp; description</h4>
            <div className="h-36 overflow-hidden rounded-lg border border-[var(--line)] bg-paper p-1">
              <FloorMap mini={{ floor: room.floor, highlight: room.id }} onSelect={() => {}} selected={null} />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
              <span className="rounded border border-[var(--line)] px-2 py-0.5">👥 {room.capacity}</span>
              {!room.capacityVerified && (
                <span className="rounded border border-dashed border-pending px-2 py-0.5 text-pending" title="capacity_verified = false: admins should confirm">
                  unverified
                </span>
              )}
              <span className="rounded border border-[var(--line)] px-2 py-0.5">{KIND_LABEL[room.kind]}</span>
              {room.tags.map((t) => (
                <span key={t} className="rounded bg-powder/60 px-2 py-0.5 text-navy">
                  {t}
                </span>
              ))}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted">{describe(room)}</p>
          </section>
        </div>
      </div>
    </>
  );
}

function Timeline({ bookings, time, onPick }: { bookings: ReturnType<typeof bookingsFor>; time: number; onPick: (t: number) => void }) {
  const span = DAY_END - DAY_START;
  const pct = (m: number) => `${((m - DAY_START) / span) * 100}%`;
  return (
    <div>
      <div
        className="relative h-7 cursor-pointer overflow-hidden rounded-md bg-free/15"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          onPick(Math.round((DAY_START + ((e.clientX - r.left) / r.width) * span) / 15) * 15);
        }}
      >
        {bookings.map((b) => (
          <div
            key={b.id}
            title={`${b.title} ${fmtTime(b.start)}–${fmtTime(b.end)}`}
            className="absolute inset-y-0 border-x border-white/70"
            style={{
              left: pct(b.start),
              width: `${((b.end - b.start) / span) * 100}%`,
              background: b.status === "pending_approval" ? "#f5c26b" : b.status === "checked_in" ? "#93b4f5" : b.status === "completed" ? "#d1d5db" : "#f19a92",
            }}
          />
        ))}
        <div className="absolute inset-y-0 w-0.5 bg-navy" style={{ left: pct(time) }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-muted">
        {[8, 10, 12, 14, 16, 18, 20].map((h) => (
          <span key={h}>{h}:00</span>
        ))}
      </div>
    </div>
  );
}

function Outcome({ result, onPick, onDismiss }: { result: BookResult; onPick: (a: { roomId: string; start: number; date: string }) => void; onDismiss: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (reduced()) return;
    const ctx = gsap.context(() => gsap.from(ref.current, { height: 0, opacity: 0, duration: 0.35, ease: "power2.out" }));
    return () => ctx.revert();
  }, [result]);
  const tone = result.ok ? (result.booking.status === "pending_approval" ? "pending" : "free") : "busy";
  const box = { pending: "border-pending/40 bg-pending/10", free: "border-free/40 bg-free/10", busy: "border-busy/40 bg-busy/10" }[tone];
  const head = { pending: "text-pending", free: "text-free", busy: "text-busy" }[tone];
  return (
    <div ref={ref} className={`overflow-hidden rounded-lg border p-3 text-xs ${box}`} role="status">
      <div className="mb-1 flex items-center justify-between">
        <b className={head}>
          {result.ok
            ? result.bumped
              ? "Booked · lower-priority booking bumped"
              : result.booking.status === "pending_approval"
                ? "Request sent · soft-held"
                : "Booked ✓"
            : result.code === "RULE"
              ? "Blocked by a rule"
              : "Conflict detected (23P01)"}
        </b>
        <button onClick={onDismiss} className="text-muted hover:text-ink" aria-label="Dismiss">
          ×
        </button>
      </div>
      <p className="leading-relaxed">{result.event.text}</p>
      {result.event.winnerScore && result.event.loserScore && <ScoreBars a={result.event.winnerScore} b={result.event.loserScore} aLabel={result.ok ? "You" : "Holder"} bLabel={result.ok ? "Bumped" : "You"} />}
      {!result.ok && result.alternatives.length > 0 && (
        <div className="mt-2 space-y-1">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted">Least-disruption alternatives</div>
          {result.alternatives.map((a, i) => (
            <button key={i} onClick={() => onPick(a)} className="flex w-full items-center justify-between rounded-md border border-[var(--line)] bg-[var(--surface)] px-2 py-1.5 text-left hover:border-brand">
              <span>
                <b>{roomName(a.roomId)}</b> · {fmtTime(a.start)}
                <span className="block text-[10px] text-muted">{a.reason}</span>
              </span>
              <span className="font-mono text-[10px] text-muted">disruption {a.disruption}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
