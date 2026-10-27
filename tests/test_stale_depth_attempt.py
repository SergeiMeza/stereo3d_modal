"""A depth call that outlived its coordinator steps aside (2026-10-27)."""
import app.common.jobs as jobs


def _with(monkeypatch, record):
    monkeypatch.setattr(jobs, "job_dict", {"j": record})


def test_current_attempt_runs(monkeypatch):
    _with(monkeypatch, {"status": jobs.IN_PROGRESS, "depth_attempt": "a2"})
    assert jobs.stale_depth_attempt("j", "a2") is None


def test_older_attempt_is_skipped(monkeypatch):
    _with(monkeypatch, {"status": jobs.IN_PROGRESS, "depth_attempt": "a2"})
    assert "superseded" in jobs.stale_depth_attempt("j", "a1")
    assert "superseded" in jobs.stale_depth_attempt("j", None)


def test_untokened_call_runs_when_nothing_is_on_record(monkeypatch):
    _with(monkeypatch, {"status": jobs.IN_PROGRESS})
    assert jobs.stale_depth_attempt("j", None) is None


def test_finished_job_is_skipped(monkeypatch):
    for status in (jobs.COMPLETED, jobs.FAILED):
        _with(monkeypatch, {"status": status})
        assert "already" in jobs.stale_depth_attempt("j", None)


def test_unknown_job_runs(monkeypatch):
    monkeypatch.setattr(jobs, "job_dict", {})
    assert jobs.stale_depth_attempt("j", None) is None
