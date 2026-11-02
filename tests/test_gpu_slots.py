"""App-wide GPU slot semaphore (app/common/gpu_slots.py) — offline, with an
in-memory stand-in for modal.Dict."""

import random
import threading
import time
import types

import pytest

from app.common import gpu_slots
from app.common.gpu_slots import GpuSlots, acquire
from app.common.gpu_wait import _gpu_call


class FakeDict:
    """modal.Dict's surface used by GpuSlots; small random lag so
    concurrent callers interleave."""

    def __init__(self, lag=0.0):
        self.d, self.m, self.lag = {}, threading.Lock(), lag

    def _sleep(self):
        if self.lag:
            time.sleep(random.random() * self.lag)

    def get(self, k, default=None):
        self._sleep()
        with self.m:
            v = self.d.get(k, default)
            return dict(v) if isinstance(v, dict) else v

    def __setitem__(self, k, v):
        self._sleep()
        with self.m:
            self.d[k] = dict(v) if isinstance(v, dict) else v

    def put(self, k, v, *, skip_if_exists=False):
        self._sleep()
        with self.m:
            if skip_if_exists and k in self.d:
                return False
            self.d[k] = dict(v) if isinstance(v, dict) else v
            return True

    def pop(self, k, default=None):
        self._sleep()
        with self.m:
            return self.d.pop(k, default)

    def items(self):
        self._sleep()
        with self.m:
            return [(k, dict(v) if isinstance(v, dict) else v) for k, v in self.d.items()]


class Clock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t


def _slots(cap=2, clock=None, store=None):
    store = store or FakeDict()
    store.put("cap", cap)
    return GpuSlots(store, now_fn=clock or Clock(), ttl_s=300), store


def test_acquire_and_release():
    slots, store = _slots(cap=2)
    a = slots.try_acquire("j1")
    b = slots.try_acquire("j2")
    assert a and b and a.key != b.key
    assert slots.try_acquire("j3") is None  # full
    slots.release(a)
    c = slots.try_acquire("j3")
    assert c is not None and c.key == a.key
    slots.release(b)
    slots.release(c)
    assert slots.leases() == {}
    slots.release(c)  # double release is harmless


def test_attach_records_the_call():
    slots, store = _slots(cap=1)
    lease = slots.try_acquire("j1")
    slots.attach(lease, "fc-9")
    assert store.get(lease.key)["call_id"] == "fc-9"
    assert store.get(lease.key)["job_id"] == "j1"


def test_expired_lease_is_taken_over_and_renew_keeps_it_alive():
    clock = Clock()
    slots, store = _slots(cap=1, clock=clock)
    dead = slots.try_acquire("crashed")
    live = slots.try_acquire("other")
    assert live is None
    clock.t += 299
    assert slots.try_acquire("other") is None  # not expired yet
    clock.t += 2
    taken = slots.try_acquire("other")
    assert taken is not None and taken.key == dead.key
    assert slots.renew(dead, force=True) is False  # the crashed one lost it
    slots.release(dead)  # and can't release the new holder's lease
    assert store.get(taken.key)["job_id"] == "other"
    # renewing pushes expiry out
    clock.t += 250
    assert slots.renew(taken) is True
    clock.t += 250
    assert slots.try_acquire("third") is None


def test_cap_comes_from_env_then_dict_override(monkeypatch):
    store = FakeDict()
    slots = GpuSlots(store, now_fn=Clock())
    monkeypatch.delenv("STEREO3D_MAX_GPUS", raising=False)
    assert slots.cap() == gpu_slots.DEFAULT_MAX_GPUS
    monkeypatch.setenv("STEREO3D_MAX_GPUS", "3")
    assert slots.cap() == 3
    held = [slots.try_acquire("j") for _ in range(4)]
    assert sum(1 for x in held if x) == 3
    store.put("cap", 5)  # runtime override, no redeploy
    assert slots.cap() == 5
    store.put("cap", "nonsense")
    assert slots.cap() == 3
    store.put("cap", 1)  # lowered: held slots drain, none refilled
    for x in held:
        slots.release(x)
    assert slots.try_acquire("j") is not None
    assert slots.try_acquire("j") is None


def test_release_job_drops_only_that_jobs_leases():
    slots, store = _slots(cap=4)
    a = slots.try_acquire("j1")
    slots.try_acquire("j1")
    b = slots.try_acquire("j2")
    assert slots.release_job("j1") == 2
    assert list(slots.leases()) == [b.key]
    assert slots.renew(a, force=True) is False


def test_cap_respected_under_concurrency():
    store = FakeDict(lag=0.002)
    store.put("cap", 3)
    slots = GpuSlots(store, ttl_s=300)
    holders, peak, m = [0], [0], threading.Lock()

    def worker(job):
        for _ in range(4):
            lease = acquire(slots, job, poll_s=0.001)
            with m:
                holders[0] += 1
                peak[0] = max(peak[0], holders[0])
            time.sleep(random.random() * 0.005)
            with m:
                holders[0] -= 1
            slots.release(lease)

    threads = [threading.Thread(target=worker, args=(f"j{i}",)) for i in range(12)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert peak[0] == 3
    assert slots.leases() == {}


class _Call:
    _n = 0

    def __init__(self, behaviour):
        _Call._n += 1
        self.object_id = f"fc-{_Call._n}"
        self.behaviour = behaviour
        self.cancelled = False

    def get(self, timeout=0):
        return self.behaviour(self)

    def cancel(self):
        self.cancelled = True


class _Method:
    def __init__(self, behaviour):
        self.behaviour = behaviour
        self.calls = []

    def spawn(self, *a, **k):
        call = _Call(self.behaviour)
        self.calls.append(call)
        return call


class _Wait:
    def __init__(self):
        self.states = []

    def update(self, waiting):
        self.states.append(waiting)

    def close(self):
        self.states.append(False)


def _call(slots, behaviour, wait=None):
    method = _Method(behaviour)
    out = _gpu_call(
        "j", method, ("j",), {}, poll_s=0, gpu_wait=wait or _Wait(), slots=slots,
        sleep_fn=lambda s: None, read_starts_fn=lambda j: 0,
        register_fn=lambda j, ids: None, clear_fn=lambda j: None,
        not_ready_exc=(TimeoutError,))
    return out, method


def test_gpu_call_holds_a_slot_and_releases_it():
    slots, store = _slots(cap=1)
    seen = []

    def finish(call):
        seen.append(dict(slots.leases()))
        return {"ok": True}

    out, method = _call(slots, finish)
    assert out == {"ok": True}
    (lease,) = seen[0].values()
    assert lease["call_id"] == method.calls[0].object_id
    assert slots.leases() == {}


def test_gpu_call_releases_on_worker_exception_and_on_cancel():
    slots, _ = _slots(cap=1)

    def boom(call):
        raise ValueError("worker failed")

    with pytest.raises(ValueError):
        _call(slots, boom)
    assert slots.leases() == {}

    def cancelled(call):
        raise KeyboardInterrupt()  # the coordinator is torn down

    with pytest.raises(KeyboardInterrupt):
        _, method = _call(slots, cancelled)
    assert slots.leases() == {}


def test_gpu_call_waits_for_a_slot_as_queued():
    clock = Clock()
    slots, _ = _slots(cap=1, clock=clock)
    other = slots.try_acquire("someone-else")
    tries = [0]
    orig = slots.try_acquire

    def try_acquire(job_id, call_id=None):
        tries[0] += 1
        if tries[0] == 3:
            slots.release(other)  # the other job's call finished
        return orig(job_id, call_id)

    slots.try_acquire = try_acquire
    wait = _Wait()
    _call(slots, lambda call: {"ok": 1}, wait=wait)
    assert tries[0] == 3
    assert wait.states[:3] == [True, True, True]  # waiting while no slot
    assert slots.leases() == {}


def _load_watchdog():
    from tests.test_watchdog_selfheal import _load_watchdog as load

    return load()


def test_fanout_spawns_only_as_slots_free_and_releases_all():
    wd, jobs = _load_watchdog()
    slots, _ = _slots(cap=2)
    t = [0]
    spawned_at, finish_after = {}, 3
    live_peak = [0]

    class H:
        def __init__(self, i):
            self.i, self.object_id = i, f"c{i}-{t[0]}"

        def get(self, timeout=0):
            t[0] += 1
            live = len(slots.leases())
            live_peak[0] = max(live_peak[0], live)
            if t[0] - spawned_at[self.i] >= finish_after:
                return {"key": self.i}
            raise TimeoutError()

        def cancel(self):
            pass

    def spawn(i):
        spawned_at[i] = t[0]
        return H(i)

    keys = list(range(5))
    registered = []
    res = wd.gather_with_heartbeat(
        "job", [None] * 5, types.SimpleNamespace(info=print, warning=print, error=print),
        stall_timeout_s=10_000, poll_s=0, label="t", chunk_keys=keys,
        respawn_fn=spawn, register_handles_fn=lambda hs: registered.append(len(hs)),
        now_fn=lambda: t[0], read_chunk_progress_fn=lambda j: {},
        read_updated_at_fn=lambda j: t[0], not_ready_exc=(TimeoutError,),
        slots=slots, max_in_flight=3, sleep_fn=lambda s: t.__setitem__(0, t[0] + 1))
    assert [r["key"] for r in res] == keys
    assert live_peak[0] == 2  # the app cap (2) beat the job's max_in_flight (3)
    assert slots.leases() == {}
    assert registered[-1] == 5
    assert jobs._failed is False


def test_fanout_failure_releases_every_slot():
    wd, jobs = _load_watchdog()
    slots, _ = _slots(cap=4)

    class H:
        def __init__(self, i):
            self.i, self.object_id = i, f"c{i}"

        def get(self, timeout=0):
            if self.i == 1:
                raise RuntimeError("worker crashed")
            raise TimeoutError()

        def cancel(self):
            pass

    with pytest.raises(RuntimeError):
        wd.gather_with_heartbeat(
            "job", [None] * 3, types.SimpleNamespace(info=print, warning=print, error=print),
            stall_timeout_s=10_000, poll_s=0, label="t", chunk_keys=[0, 1, 2],
            respawn_fn=H, now_fn=lambda: 0, read_chunk_progress_fn=lambda j: {},
            read_updated_at_fn=lambda j: 0, not_ready_exc=(TimeoutError,),
            slots=slots, max_in_flight=4, sleep_fn=lambda s: None)
    assert slots.leases() == {}
