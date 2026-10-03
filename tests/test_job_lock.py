"""Concurrent read-modify-writes of one job record keep every update."""
import threading
import time

import app.common.jobs as jobs


class SlowDict:
    """A Dict whose reads lag, so unlocked writers would interleave."""

    def __init__(self):
        self.d, self.m = {}, threading.Lock()

    def get(self, k, default=None):
        time.sleep(0.002)
        with self.m:
            v = self.d.get(k, default)
            return dict(v) if isinstance(v, dict) else v

    def __setitem__(self, k, v):
        with self.m:
            self.d[k] = dict(v) if isinstance(v, dict) else v

    def put(self, k, v, *, skip_if_exists=False):
        with self.m:
            if skip_if_exists and k in self.d:
                return False
            self.d[k] = v
            return True

    def pop(self, k):
        with self.m:
            return self.d.pop(k, None)


def test_parallel_child_registrations_are_all_kept(monkeypatch):
    store, locks = SlowDict(), SlowDict()
    store["j1"] = {"job_id": "j1", "child_call_ids": []}
    monkeypatch.setattr(jobs, "job_dict", store)
    monkeypatch.setattr(jobs, "job_locks", locks)
    threads = [threading.Thread(target=jobs.register_child_calls, args=("j1", [f"fc-{i}"])) for i in range(20)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(store.get("j1")["child_call_ids"]) == sorted(f"fc-{i}" for i in range(20))
    assert locks.d == {}  # every lock released


def test_requeue_marks_live_chunks_queued(monkeypatch):
    store, locks = SlowDict(), SlowDict()
    store["j2"] = {"job_id": "j2", "chunk_state": {"0": "running", "240": "running"}}
    monkeypatch.setattr(jobs, "job_dict", store)
    monkeypatch.setattr(jobs, "job_locks", locks)
    jobs._live_chunks.clear()
    jobs._live_chunks.add(("j2", "240"))
    jobs.requeue_live_chunks()
    assert store.get("j2")["chunk_state"] == {"0": "running", "240": "queued"}
    assert jobs._live_chunks == set()
