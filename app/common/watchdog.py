"""Orchestrator-side heartbeat watchdog for fan-out GPU workers.

A GPU worker can hang *silently*: it stops emitting progress but raises
no exception, so Modal's (multi-hour) function timeout won't catch it
for ages and ``fail_fast``/retries never fire. Meanwhile the
orchestrator (``process_video_job``) is blocked in the fan-out gather
(``[h.get() for h in handles]``) and can't notice.

Healthy fan-out workers call ``jobs.report_progress`` every few seconds
(per batch), which bumps the job record's ``updated_at``. This watchdog
gathers the handles while *also* watching that timestamp: if it goes
stale beyond ``stall_timeout_s`` (no worker made progress at all), we
treat it as a silent hang — cancel the remaining workers, mark the job
failed, and raise so the orchestrator's except block runs and the job
can be resubmitted.

We key on ``updated_at`` (the per-batch heartbeat), NOT on elapsed wall
time, so a genuinely slow batch / model reload / brief GCS stall (work
is still emitting progress) does NOT trip it — only *total silence*
does.

The time source and job-timestamp read are injectable seams (``now_fn``
/ ``read_updated_at_fn``) so the gather logic is unit-testable without
Modal or a GPU.
"""

import time

from app.common.debug import get_logger

logger = get_logger(__name__)

# Healthy fan-out workers heartbeat every few seconds via report_progress.
# 10 min of TOTAL silence is unambiguously a silent hang, while still
# tolerating a slow batch / cold model reload / brief GCS stall (those
# keep emitting progress, so updated_at keeps advancing and the watchdog
# stays quiet). Overridable per request via "stall_timeout_s".
STALL_TIMEOUT_S = 600


def _modal_not_ready_exc():
    """The exception ``FunctionCall.get(timeout=N)`` raises when the call
    hasn't finished yet. Imported lazily so this module stays importable
    without Modal installed (and so tests don't need it)."""
    try:
        from modal.exception import FunctionTimeoutError

        return FunctionTimeoutError
    except Exception:  # pragma: no cover - modal always present in containers
        return TimeoutError


def gather_with_heartbeat(
    job_id,
    handles,
    jlog,
    *,
    stall_timeout_s,
    poll_s=20,
    label="stage",
    now_fn=time.time,
    read_updated_at_fn=None,
    not_ready_exc=None,
):
    """Block until all ``handles`` complete, but FAIL FAST on a silent hang.

    Polls each not-yet-done handle with ``h.get(timeout=poll_s)``; a
    poll-timeout means "not ready yet" and we move on. After any full
    sweep in which NO handle newly completed, we read the job's
    ``updated_at`` and, if ``now - updated_at > stall_timeout_s``, treat
    it as a silent hang: cancel all remaining handles, mark the job
    failed, and raise ``RuntimeError`` (so the orchestrator's except
    block runs).

    Healthy/slow-but-progressing work keeps bumping ``updated_at`` and
    never trips. A real worker exception surfacing from ``h.get()``
    propagates unchanged (it is NOT masked as a stall).

    Returns results in handle order on success.

    Injectable seams (default to real impls):
      - ``now_fn()`` -> wall-clock seconds.
      - ``read_updated_at_fn(job_id)`` -> the job's ``updated_at`` float
        (defaults to reading the modal.Dict job record).
      - ``not_ready_exc`` -> the exception class meaning "not ready yet"
        (defaults to Modal's FunctionTimeoutError).
    """
    if read_updated_at_fn is None:
        read_updated_at_fn = _default_read_updated_at
    if not_ready_exc is None:
        not_ready_exc = _modal_not_ready_exc()

    n = len(handles)
    results = [None] * n
    done = [False] * n

    while not all(done):
        completed_this_sweep = False
        for i, h in enumerate(handles):
            if done[i]:
                continue
            try:
                results[i] = h.get(timeout=poll_s)
                done[i] = True
                completed_this_sweep = True
            except not_ready_exc:
                # not finished yet — keep waiting on the rest
                continue
            # NOTE: any other exception (a real worker error) propagates
            # out of the function — it must NOT be swallowed as a stall.

        if completed_this_sweep:
            continue  # progress happened (a handle finished); don't check staleness

        # Full sweep, nothing newly finished: is the job still heartbeating?
        updated_at = read_updated_at_fn(job_id)
        silent_for = now_fn() - (updated_at or now_fn())
        if silent_for > stall_timeout_s:
            pending = [h for i, h in enumerate(handles) if not done[i]]
            jlog.error(
                f"🚨 watchdog: no progress for {int(silent_for)}s in {label} "
                f"— cancelling {len(pending)} worker(s)"
            )
            for h in pending:
                try:
                    h.cancel()
                except Exception:  # best-effort: a worker may already be gone
                    logger.warning("watchdog: failed to cancel a worker", exc_info=True)
            from app.common import jobs

            err = (
                f"{label} stalled: no worker progress for {stall_timeout_s}s "
                f"(silent hang) — cancelled and failed; resubmit"
            )
            jobs.update_job(job_id, status=jobs.FAILED, error=err)
            raise RuntimeError(err)
        # else: a poll cycle just elapsed without completions, but the job
        # is still heartbeating (slow batch) — keep waiting.

    return results


def _default_read_updated_at(job_id):
    from app.common import jobs

    job = jobs.get_job(job_id)
    return (job or {}).get("updated_at")
