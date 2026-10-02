from fastapi.testclient import TestClient
from main import app

c = TestClient(app)
ROOMS = [
    {"id": "F2-10", "type": "lh", "capacity": 75, "floor": 2, "tags": ["smart-board"]},
    {"id": "F2-11", "type": "lh", "capacity": 75, "floor": 2, "tags": ["smart-board"]},
    {"id": "F3-13", "type": "lh", "capacity": 75, "floor": 3, "tags": ["smart-board"]},
]


def test_conflicting_requests_resolve_without_overlap():
    events = [{"id": f"e{i}", "size": 60, "duration_slots": 2, "room_types": ["lh"], "current_room": "F2-10", "current_slot": 4, "preferred_floor": 2} for i in range(4)]
    r = c.post("/solver/schedule", json={"rooms": ROOMS, "events": events, "slots": 24}).json()
    assert r["status"] in ("OPTIMAL", "FEASIBLE")
    assert not r["unscheduled"]
    taken = set()
    for a in r["assignments"]:
        for t in (a["slot"], a["slot"] + 1):
            assert (a["room"], t) not in taken
            taken.add((a["room"], t))
    assert r["moves"] == 3  # one keeps its request; three move minimally


def test_faculty_no_cross_floor_back_to_back():
    events = [
        {"id": "a", "size": 50, "duration_slots": 2, "faculty": "Iyer", "allowed_slots": [0], "room_types": ["lh"], "preferred_floor": 2},
        {"id": "b", "size": 50, "duration_slots": 2, "faculty": "Iyer", "allowed_slots": [2], "room_types": ["lh"]},
    ]
    blocked = [{"room": "F2-10", "slot": 2}, {"room": "F2-10", "slot": 3}, {"room": "F2-11", "slot": 2}, {"room": "F2-11", "slot": 3}]
    r = c.post("/solver/schedule", json={"rooms": ROOMS, "events": events, "blocked": blocked}).json()
    # b could only go to floor 3 right after a on floor 2, which is forbidden -> one is unscheduled or a moves to F3
    floors = {a["event_id"]: {"F2-10": 2, "F2-11": 2, "F3-13": 3}[a["room"]] for a in r["assignments"]}
    if "a" in floors and "b" in floors:
        assert floors["a"] == floors["b"]


def test_forecast():
    hist = [{"date": f"2026-09-{d:02d}", "room_type": "lab", "utilisation": 0.8} for d in range(1, 29)]
    r = c.post("/forecast", json={"history": hist}).json()
    assert 0.7 < r["lab"]["next_week_avg"] <= 1
