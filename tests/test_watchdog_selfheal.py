"""Offline tests for the self-healing fan-out watchdog.

Exercises gather_with_heartbeat's per-chunk recovery via the injectable
seams (now_fn / read_chunk_progress_fn / not_ready_exc) — no Modal, no GPU.

Run: python -m pytest tests/test_watchdog_selfheal.py
"""

import importlib.util
import sys
import types


def _load_watchdog():
    # stub app.common.jobs so _fail_all / default readers import cleanly
    jobs = types.ModuleType("app.common.jobs")
    jobs.FAILED = "failed"
    jobs._failed = False

    def update_job(job_id, **f):
        if f.get("status") == "failed":
            jobs._failed = True

    jobs.update_job = update_job
    jobs.get_job = lambda j: {}
    jobs.clear_chunk_progress_key = lambda job_id, key: None  # no-op stub
    sys.modules["app.common.jobs"] = jobs
    # If another test already imported the REAL app.common package,
    # watchdog's `from app.common import jobs` resolves the package
    # ATTRIBUTE (bound at first import), not sys.modules — patch it too so
    # the stub wins regardless of test ordering.
    if "app.common" in sys.modules:
        sys.modules["app.common"].jobs = jobs
    spec = importlib.util.spec_from_file_location(
        "wd", "app/common/watchdog.py")
    wd = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(wd)
    return wd, jobs


class _NotReady(Exception):
    pass


class _Handle:
    _n = 0

    def __init__(self, key, done_fn):
        self.key = key
        self._done = done_fn
        self.cancelled = False
        self.id = f"c{_Handle._n}"
        _Handle._n += 1

    def get(self, timeout=0):
        if self._done(_T[0]):
            return {"ok": True, "key": self.key}
        raise _NotReady()

    def cancel(self):
        self.cancelled = True

    @property
    def object_id(self):
        return self.id


_T = [0]


def _log():
    return types.SimpleNamespace(info=lambda *a: None, warning=lambda *a: None,
                                 error=lambda *a: None)


def test_healthy_completes_without_resubmit():
    wd, jobs = _load_watchdog()
    _T[0] = 0
    _Handle._n = 0
    keys = [0, 100, 200]
    handles = [_Handle(k, lambda t: t >= 3) for k in keys]
    prog = {str(k): 0 for k in keys}

    def read_cp(job):
        _T[0] += 1
        for k in keys:
            prog[str(k)] = _T[0] * 10
        return dict(prog)

    res = wd.gather_with_heartbeat(
        "job", handles, _log(), stall_timeout_s=2, poll_s=0, label="t",
        chunk_keys=keys, respawn_fn=lambda i: handles[i],
        register_handles_fn=lambda hs: None, now_fn=lambda: _T[0],
        read_chunk_progress_fn=read_cp, not_ready_exc=(_NotReady,))
    assert [r["key"] for r in res] == keys
    assert jobs._failed is False


def test_single_hung_chunk_resubmits_and_recovers():
    wd, jobs = _load_watchdog()
    _T[0] = 0
    _Handle._n = 0
    keys = [0, 100, 200]
    resub_at = [None]
    prog = {str(k): 0 for k in keys}
    handles = [
        _Handle(0, lambda t: t >= 6),
        _Handle(100, lambda t: resub_at[0] is not None and t >= resub_at[0] + 4),
        _Handle(200, lambda t: t >= 8),
    ]

    def respawn(i):
        resub_at[0] = _T[0]
        return _Handle(keys[i], lambda t: t >= resub_at[0] + 4)

    def read_cp(job):
        _T[0] += 1
        prog["0"] = _T[0] * 10
        prog["200"] = _T[0] * 10
        if resub_at[0] is not None:
            prog["100"] = (_T[0] - resub_at[0]) * 10
        return dict(prog)

    res = wd.gather_with_heartbeat(
        "job", handles, _log(), stall_timeout_s=2, poll_s=0, label="t",
        chunk_keys=keys, respawn_fn=respawn,
        register_handles_fn=lambda hs: None, now_fn=lambda: _T[0],
        read_chunk_progress_fn=read_cp, not_ready_exc=(_NotReady,))
    assert sorted(r["key"] for r in res) == keys
    assert jobs._failed is False


def test_chunk_failing_past_max_retries_fails_job():
    wd, jobs = _load_watchdog()
    _T[0] = 0
    _Handle._n = 0
    keys = [0, 100, 200]
    prog = {str(k): 0 for k in keys}
    # chunk 100 NEVER advances, even after resubmit
    handles = [
        _Handle(0, lambda t: t >= 4),
        _Handle(100, lambda t: False),
        _Handle(200, lambda t: t >= 4),
    ]

    def respawn(i):
        return _Handle(keys[i], lambda t: False)  # still hung

    def read_cp(job):
        _T[0] += 1
        prog["0"] = _T[0] * 10
        prog["200"] = _T[0] * 10
        prog["100"] = 5  # started (wrote a heartbeat) then FROZE at 5
        return dict(prog)

    raised = False
    try:
        wd.gather_with_heartbeat(
            "job", handles, _log(), stall_timeout_s=2, poll_s=0, label="t",
            chunk_keys=keys, respawn_fn=respawn, max_chunk_retries=2,
            register_handles_fn=lambda hs: None, now_fn=lambda: _T[0],
            read_chunk_progress_fn=read_cp, not_ready_exc=(_NotReady,))
    except RuntimeError:
        raised = True
    assert raised is True
    assert jobs._failed is True


def test_queued_chunk_not_killed_while_others_progress():
    """Regression: with more chunks than workers, late chunks sit QUEUED
    (never appear in chunk_progress) for many minutes. They must NOT be
    judged hung while running chunks heartbeat — the bug that failed both
    new videos on chunk 2880 (the 5th chunk behind a 4-worker cap)."""
    wd, jobs = _load_watchdog()
    _T[0] = 0
    _Handle._n = 0
    keys = [0, 100, 200, 300, 400]  # 5 chunks
    # chunks 0..3 run and finish over time; chunk 400 stays QUEUED (never
    # reports) until t>=20, then runs and finishes — like a slot freeing.
    handles = [
        _Handle(0, lambda t: t >= 5),
        _Handle(100, lambda t: t >= 6),
        _Handle(200, lambda t: t >= 7),
        _Handle(300, lambda t: t >= 8),
        _Handle(400, lambda t: t >= 25),  # starts late, finishes later
    ]
    prog = {}

    def respawn(i):  # should NEVER be called for the queued chunk
        respawn.called += 1
        return handles[i]
    respawn.called = 0

    def read_cp(job):
        _T[0] += 1
        # running chunks advance; chunk 400 has NO entry until t>=20
        for k in (0, 100, 200, 300):
            prog[str(k)] = _T[0] * 10
        if _T[0] >= 20:
            prog["400"] = (_T[0] - 20) * 10
        return dict(prog)

    res = wd.gather_with_heartbeat(
        "job", handles, _log(), stall_timeout_s=3, start_timeout_s=10_000,
        poll_s=0, label="t", chunk_keys=keys, respawn_fn=respawn,
        register_handles_fn=lambda hs: None, now_fn=lambda: _T[0],
        read_chunk_progress_fn=read_cp, not_ready_exc=(_NotReady,))
    assert sorted(r["key"] for r in res) == keys
    assert jobs._failed is False
    assert respawn.called == 0  # queued chunk was never mistaken for hung


def test_resubmitted_chunk_stale_key_does_not_death_spiral():
    """Regression (the production bug): a hung chunk's CANCELLED worker
    leaves a stale chunk_progress[key]. The resubmit reuses the same key
    but sits QUEUED for a long time. Without clearing the stale entry, the
    watchdog sees key-present, flips started=True, and runs the stall clock
    against the frozen stale value WHILE queued — resubmitting again and
    again until retries exhaust (the 15-min-queue-then-instant-cancel
    pathology). With the clear, the resubmitted chunk is correctly treated
    as queued (unbounded patience) until its fresh worker advances."""
    wd, jobs = _load_watchdog()
    _T[0] = 0
    _Handle._n = 0
    keys = [0, 100]
    prog = {"0": 0, "100": 7}  # chunk 100 started, wrote 7, then froze
    cleared = {"100": False}
    resub_at = [None]

    handles = [
        _Handle(0, lambda t: t >= 30),
        _Handle(100, lambda t: False),  # original hangs frozen at 7
    ]

    def respawn(i):
        resub_at[0] = _T[0]
        # fresh worker sits QUEUED a long time (20 ticks) then advances
        return _Handle(keys[i],
                       lambda t: resub_at[0] is not None and t >= resub_at[0] + 25)

    def clear_cp(job_id, key):
        cleared[str(key)] = True
        prog.pop(str(key), None)  # the real clear: drop the stale entry

    def read_cp(job):
        _T[0] += 1
        prog["0"] = _T[0]
        # after resubmit + clear, chunk 100 stays ABSENT (queued) for 20
        # ticks, then the fresh worker starts advancing
        if resub_at[0] is not None and _T[0] >= resub_at[0] + 20:
            prog["100"] = (_T[0] - (resub_at[0] + 20)) + 1
        return dict(prog)

    res = wd.gather_with_heartbeat(
        "job", handles, _log(), stall_timeout_s=3, start_timeout_s=10_000,
        poll_s=0, label="t", chunk_keys=keys, respawn_fn=respawn,
        max_chunk_retries=2, register_handles_fn=lambda hs: None,
        now_fn=lambda: _T[0], read_chunk_progress_fn=read_cp,
        clear_chunk_progress_fn=clear_cp, not_ready_exc=(_NotReady,))
    assert sorted(r["key"] for r in res) == keys
    assert jobs._failed is False
    assert cleared["100"] is True  # stale key WAS cleared on resubmit


def test_legacy_global_path_still_fails_on_total_silence():
    wd, jobs = _load_watchdog()
    _T[0] = 0
    _Handle._n = 0
    handles = [_Handle(0, lambda t: False)]  # never completes

    def read_updated(job):
        return 1.0  # ancient but truthy (0.0 would read as "missing")

    raised = False
    try:
        wd.gather_with_heartbeat(
            "job", handles, _log(), stall_timeout_s=2, poll_s=0, label="t",
            now_fn=lambda: 1000.0, read_updated_at_fn=read_updated,
            not_ready_exc=(_NotReady,))  # no chunk_keys → legacy path
    except RuntimeError:
        raised = True
    assert raised is True
    assert jobs._failed is True
