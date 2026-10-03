"""A repeated submit with the same client_ref returns the first job."""
import types

import app.api.main as api


class FakeDict(dict):
    def put(self, key, value, *, skip_if_exists=False):
        if skip_if_exists and key in self:
            return False
        self[key] = value
        return True


def _wire(monkeypatch, jobs_store):
    refs = FakeDict()
    monkeypatch.setattr(api.jobs, "submit_refs", refs)
    monkeypatch.setattr(api.jobs, "create_job", lambda jid, kind, body: jobs_store.__setitem__(jid, {"status": "pending"}))
    monkeypatch.setattr(api.jobs, "update_job", lambda jid, **f: jobs_store[jid].update(f))
    monkeypatch.setattr(api.jobs, "get_job", lambda jid: jobs_store.get(jid))
    return refs


def test_same_ref_returns_first_job(monkeypatch):
    store, spawned = {}, []
    _wire(monkeypatch, store)
    spawner = lambda jid: spawned.append(jid) or types.SimpleNamespace(object_id="fc-" + jid)
    first = api._submit("image", {"client_ref": "conv1"}, spawner)
    again = api._submit("image", {"client_ref": "conv1"}, spawner)
    assert again["job_id"] == first["job_id"]
    assert spawned == [first["job_id"]]


def test_no_ref_always_spawns(monkeypatch):
    store, spawned = {}, []
    _wire(monkeypatch, store)
    spawner = lambda jid: spawned.append(jid) or types.SimpleNamespace(object_id="fc")
    api._submit("image", {}, spawner)
    api._submit("image", {}, spawner)
    assert len(spawned) == 2


def test_ref_without_recorded_job_is_taken_over(monkeypatch):
    store, spawned = {}, []
    refs = _wire(monkeypatch, store)
    refs["conv2"] = "deadbeef0000"  # reserved, but the job was never created
    spawner = lambda jid: spawned.append(jid) or types.SimpleNamespace(object_id="fc")
    out = api._submit("video", {"client_ref": "conv2"}, spawner)
    assert out["job_id"] != "deadbeef0000" and spawned == [out["job_id"]]
    assert refs["conv2"] == out["job_id"]
