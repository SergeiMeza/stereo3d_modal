"""waiting_for_gpu / queued_s bookkeeping (app/common/gpu_wait.py) and the
stage_starts start mark — offline, no Modal calls."""

import app.common.jobs as jobs
from app.common.gpu_wait import GpuWait, _gpu_call
from tests.test_job_lock import SlowDict


class _Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def _tracker(clock, base=0.0):
    writes = []
    w = GpuWait("j", interval_s=30, now_fn=clock, read_fn=lambda: base,
                write_fn=lambda waiting, q: writes.append((clock.t, waiting, q)))
    return w, writes


def test_writes_on_transitions_and_throttles_while_waiting():
    clock = _Clock()
    w, writes = _tracker(clock, base=12.0)
    w.update(True)
    for t in range(1, 100):  # poll every second while waiting
        clock.t = t
        w.update(True)
    clock.t = 100
    w.update(False)
    w.update(False)  # no transition: no write
    assert writes[0] == (0, True, 12.0)
    assert writes[-1] == (100, False, 112.0)
    # 1 start + every 30 s + 1 stop, not one per poll
    assert len(writes) == 5
    assert [x[0] for x in writes[1:4]] == [30, 60, 90]


def test_queued_s_accumulates_across_stretches():
    clock = _Clock()
    w, writes = _tracker(clock)
    w.update(True)
    clock.t = 10
    w.update(False)  # 10 s queued
    clock.t = 50
    w.update(False)  # running: no change
    w.update(True)
    clock.t = 55
    w.close()  # 5 s more
    assert writes[-1] == (55, False, 15.0)
    assert w.queued_s == 15.0


def test_write_failure_never_raises():
    clock = _Clock()

    def boom(*a):
        raise OSError("dict down")

    w = GpuWait("j", now_fn=clock, read_fn=boom, write_fn=boom)
    w.update(True)
    clock.t = 5
    w.close()
    assert w.queued_s == 5.0


class _Call:
    object_id = "fc-1"

    def __init__(self, ready_at, clock, result=None, exc=None):
        self.ready_at, self.clock = ready_at, clock
        self.result, self.exc = result, exc
        self.cancelled = False

    def get(self, timeout=0):
        self.clock.t += 1
        if self.clock.t < self.ready_at:
            raise TimeoutError()
        if self.exc:
            raise self.exc
        return self.result


class _Method:
    def __init__(self, call):
        self.call, self.args = call, None

    def spawn(self, *args, **kwargs):
        self.args = (args, kwargs)
        return self.call


def _run(call, starts_at, clock):
    """starts_at: the clock time the worker's stage_timer bumps
    stage_starts (None: never)."""
    w, writes = _tracker(clock)
    registered, cleared = [], []
    method = _Method(call)

    def read_starts(job_id):
        return 3 if starts_at is None or clock.t < starts_at else 4

    out = _gpu_call(
        "j", method, ("j", "x"), {"band": (0, 1)}, poll_s=0, gpu_wait=w,
        read_starts_fn=read_starts,
        register_fn=lambda j, ids: registered.extend(ids),
        clear_fn=lambda j: cleared.append(j),
        not_ready_exc=(TimeoutError,))
    return out, writes, registered, cleared, method


def test_gpu_call_counts_queue_until_the_worker_starts():
    clock = _Clock()
    call = _Call(ready_at=20, clock=clock, result={"ok": 1})
    out, writes, registered, cleared, method = _run(call, starts_at=8, clock=clock)
    assert out == {"ok": 1}
    assert method.args == (("j", "x"), {"band": (0, 1)})
    assert registered == ["fc-1"] and cleared == ["j"]
    assert writes[0][1] is True
    assert writes[-1][1] is False
    assert 7 <= writes[-1][2] <= 9  # queued until the start mark at t=8


def test_gpu_call_never_started_counts_as_queued_and_reraises():
    clock = _Clock()
    call = _Call(ready_at=6, clock=clock, exc=ValueError("worker error"))
    try:
        _run(call, starts_at=None, clock=clock)
        raise AssertionError("expected the worker's exception")
    except ValueError as exc:
        assert str(exc) == "worker error"
    assert call.cancelled is False  # a worker error: the call is finished


def test_gpu_call_cancels_the_worker_when_the_coordinator_is_cancelled():
    clock = _Clock()

    class _Cancelling(_Call):
        def get(self, timeout=0):
            raise KeyboardInterrupt()

        def cancel(self):
            self.cancelled = True

    call = _Cancelling(ready_at=0, clock=clock)
    try:
        _run(call, starts_at=None, clock=clock)
    except KeyboardInterrupt:
        pass
    assert call.cancelled is True


def _store(monkeypatch, record):
    store, locks = SlowDict(), SlowDict()
    store["j"] = record
    monkeypatch.setattr(jobs, "job_dict", store)
    monkeypatch.setattr(jobs, "job_locks", locks)
    monkeypatch.setattr("app.common.notify.job_event", lambda old, new: None)
    return store


def test_create_job_initialises_the_wait_fields(monkeypatch):
    store = _store(monkeypatch, {})
    jobs.create_job("k", "video", {})
    rec = store.get("k")
    assert rec["waiting_for_gpu"] is False and rec["queued_s"] == 0.0


def test_terminal_status_clears_waiting(monkeypatch):
    store = _store(monkeypatch, {"job_id": "j", "status": "in_progress",
                                 "waiting_for_gpu": True, "queued_s": 40.0})
    jobs.update_job("j", status=jobs.FAILED, error="cancelled by user")
    assert store.get("j")["waiting_for_gpu"] is False
    assert store.get("j")["queued_s"] == 40.0
    # a late tracker write after the failure can't set it again
    jobs.update_job("j", waiting_for_gpu=True, queued_s=45.0)
    assert store.get("j")["waiting_for_gpu"] is False


def test_stage_timer_bumps_stage_starts(monkeypatch):
    store = _store(monkeypatch, {"job_id": "j", "status": "in_progress", "timings": []})
    monkeypatch.setattr(jobs, "add_timing", lambda *a, **k: None)
    with jobs.stage_timer("j", "video_depth"):
        pass
    with jobs.stage_timer("j", "video_stereo"):
        pass
    assert store.get("j")["stage_starts"] == 2
