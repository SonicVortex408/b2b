"""XIE Spaces solver: CP-SAT auto-scheduler + simple demand forecast.

POST /solver/schedule  events + rooms + constraints -> conflict-free timetable that
                       minimises moves from the requested room/slot and floor travel.
POST /forecast         booking history -> next-week utilisation per room type.
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta
from statistics import mean

from fastapi import FastAPI
from ortools.sat.python import cp_model
from pydantic import BaseModel, Field

app = FastAPI(title="XIE Spaces solver")


class Room(BaseModel):
    id: str
    type: str
    capacity: int
    floor: int
    tags: list[str] = []


class Event(BaseModel):
    id: str
    size: int
    duration_slots: int = Field(ge=1)
    room_types: list[str] = []          # empty = any
    tags: list[str] = []                 # required tags
    faculty: str | None = None
    preferred_floor: int | None = None
    current_room: str | None = None      # what the user asked for (moves are penalised)
    current_slot: int | None = None
    allowed_slots: list[int] | None = None


class Blocked(BaseModel):
    room: str
    slot: int


class Unavailable(BaseModel):
    faculty: str
    slot: int


class ScheduleRequest(BaseModel):
    rooms: list[Room]
    events: list[Event]
    slots: int = 24                      # e.g. 30-min slots 08:00-20:00
    blocked: list[Blocked] = []          # already-held room slots
    faculty_unavailable: list[Unavailable] = []
    time_limit_s: float = 5.0


class Assignment(BaseModel):
    event_id: str
    room: str
    slot: int
    moved: bool


class ScheduleResponse(BaseModel):
    status: str
    assignments: list[Assignment]
    unscheduled: list[str]
    moves: int
    floor_travel: int


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/solver/schedule", response_model=ScheduleResponse)
def schedule(req: ScheduleRequest) -> ScheduleResponse:
    m = cp_model.CpModel()
    rooms = {r.id: r for r in req.rooms}
    blocked = {(b.room, b.slot) for b in req.blocked}
    unavailable = {(u.faculty, u.slot) for u in req.faculty_unavailable}

    x: dict[tuple[str, str, int], cp_model.IntVar] = {}
    for e in req.events:
        starts = e.allowed_slots if e.allowed_slots is not None else range(req.slots)
        for r in req.rooms:
            if r.capacity < e.size or (e.room_types and r.type not in e.room_types) or not set(e.tags) <= set(r.tags):
                continue
            for s in starts:
                span = range(s, s + e.duration_slots)
                if s + e.duration_slots > req.slots or any((r.id, t) in blocked for t in span):
                    continue
                if e.faculty and any((e.faculty, t) in unavailable for t in span):
                    continue
                x[e.id, r.id, s] = m.NewBoolVar(f"x_{e.id}_{r.id}_{s}")

    by_event = defaultdict(list)
    for (eid, rid, s), v in x.items():
        by_event[eid].append(v)
    scheduled = {}
    for e in req.events:
        scheduled[e.id] = m.NewBoolVar(f"sched_{e.id}")
        m.Add(sum(by_event[e.id]) == scheduled[e.id])

    events = {e.id: e for e in req.events}
    # Room capacity in time: at most one event occupies a room per slot.
    occ = defaultdict(list)
    fac = defaultdict(list)
    for (eid, rid, s), v in x.items():
        for t in range(s, s + events[eid].duration_slots):
            occ[rid, t].append(v)
            if events[eid].faculty:
                fac[events[eid].faculty, t].append(v)
    for vs in occ.values():
        m.Add(sum(vs) <= 1)
    for vs in fac.values():
        m.Add(sum(vs) <= 1)

    # No back-to-back across floors for the same faculty member.
    by_fac = defaultdict(list)
    for (eid, rid, s), v in x.items():
        f = events[eid].faculty
        if f:
            by_fac[f].append((eid, rid, s, v))
    for items in by_fac.values():
        for e1, r1, s1, v1 in items:
            end = s1 + events[e1].duration_slots
            for e2, r2, s2, v2 in items:
                if e1 != e2 and s2 == end and rooms[r1].floor != rooms[r2].floor:
                    m.AddBoolOr([v1.Not(), v2.Not()])

    # Objective: schedule everything, then minimise moves and floor travel.
    cost = []
    for (eid, rid, s), v in x.items():
        e = events[eid]
        moved = (e.current_room is not None and rid != e.current_room) or (e.current_slot is not None and s != e.current_slot)
        travel = abs(rooms[rid].floor - e.preferred_floor) if e.preferred_floor else 0
        cost.append(v * (10 * int(moved) + 3 * travel + abs(s - (e.current_slot or s))))
    m.Minimize(sum(1000 * (1 - b) for b in scheduled.values()) + sum(cost))

    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = req.time_limit_s
    solver.parameters.num_workers = 8
    status = solver.Solve(m)
    if status not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
        return ScheduleResponse(status=solver.StatusName(status), assignments=[], unscheduled=list(events), moves=0, floor_travel=0)

    out, moves, travel = [], 0, 0
    for (eid, rid, s), v in x.items():
        if solver.Value(v):
            e = events[eid]
            mv = (e.current_room is not None and rid != e.current_room) or (e.current_slot is not None and s != e.current_slot)
            moves += int(mv)
            travel += abs(rooms[rid].floor - e.preferred_floor) if e.preferred_floor else 0
            out.append(Assignment(event_id=eid, room=rid, slot=s, moved=mv))
    done = {a.event_id for a in out}
    return ScheduleResponse(status=solver.StatusName(status), assignments=out, unscheduled=[e for e in events if e not in done], moves=moves, floor_travel=travel)


class HistoryRow(BaseModel):
    date: date
    room_type: str
    utilisation: float  # 0..1 for that day and room type


class ForecastRequest(BaseModel):
    history: list[HistoryRow]
    exam_dates: list[date] = []


@app.post("/forecast")
def forecast(req: ForecastRequest):
    """Weekday-seasonal baseline with a short trend term and an exam-week bump.
    Deliberately simple (spec allows LightGBM/Prophet; this needs no training step)."""
    by = defaultdict(lambda: defaultdict(list))
    for h in req.history:
        by[h.room_type][h.date.weekday()].append(h.utilisation)
    last = max((h.date for h in req.history), default=date.today())
    out = {}
    for rtype, wd in by.items():
        series = sorted((h.date, h.utilisation) for h in req.history if h.room_type == rtype)
        recent = mean(u for _, u in series[-5:]) if series else 0
        older = mean(u for _, u in series[-10:-5]) if len(series) > 5 else recent
        trend = (recent - older) / 5
        days = []
        for i in range(1, 8):
            d = last + timedelta(days=i)
            if d.weekday() == 6:
                continue
            base = mean(wd[d.weekday()]) if wd.get(d.weekday()) else recent
            bump = 0.15 if d in req.exam_dates else 0
            days.append({"date": d.isoformat(), "utilisation": round(min(1, max(0, base + trend * i + bump)), 3)})
        out[rtype] = {"next_week_avg": round(mean(x["utilisation"] for x in days), 3), "days": days}
    return out
