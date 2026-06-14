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
# With PER-CHUNK heartbeat tracking (see gather_with_heartbeat), a single
# chunk going silent for this long is unambiguously hung — the other
# chunks' progress no longer masks it (the old GLOBAL clock needed 600s to
# avoid a slow batch on ANY chunk resetting the whole video's timer; the
# per-chunk clock can be tighter because each chunk is judged on its own
# heartbeat). 240s tolerates a cold model reload / brief GCS stall while
# catching a real hang ~2.5× faster. Overridable per request.
STALL_TIMEOUT_S = 240
# A hung chunk is RESUBMITTED (fresh container) up to this many times
# before the job is failed — a chunk that hangs repeatedly is a real bug,
# not a transient GPU wedge. Per chunk, not per job.
MAX_CHUNK_RETRIES = 2
# Wedged-pool backstop: fail the job only if NO chunk anywhere advances for
# this long. Must be well above STALL_TIMEOUT_S because with the
# max_containers cap, late chunks legitimately sit QUEUED for many minutes
# while earlier ones run — but as long as SOME chunk heartbeats, the job is
# alive. Only total job-wide silence (a stuck pool) trips this. Generous so
# normal queueing never mis-fires.
START_TIMEOUT_S = 1800


def _modal_not_ready_exc():
    """The exception(s) ``FunctionCall.get(timeout=N)`` raises when the
    call hasn't finished yet. Modal's poll-timeout surfaces as a PLAIN
    builtin ``TimeoutError`` (from the container IO manager), NOT the
    ``FunctionTimeoutError`` that signals a function's own execution
    timeout — so we must catch the base ``TimeoutError`` here or healthy
    in-progress chunks get mis-read as worker failures. We return a tuple
    of both to be safe across Modal versions. Imported lazily so the
    module stays importable (and testable) without Modal."""
    try:
        from modal.exception import FunctionTimeoutError

        return (TimeoutError, FunctionTimeoutError)
    except Exception:  # pragma: no cover - modal always present in containers
        return (TimeoutError,)


def gather_with_heartbeat(
    job_id,
    handles,
    jlog,
    *,
    stall_timeout_s,
    poll_s=10,
    label="stage",
    chunk_keys=None,
    respawn_fn=None,
    max_chunk_retries=MAX_CHUNK_RETRIES,
    start_timeout_s=START_TIMEOUT_S,
    register_handles_fn=None,
    now_fn=time.time,
    read_updated_at_fn=None,
    read_chunk_progress_fn=None,
    not_ready_exc=None,
):
    """Block until all ``handles`` complete, SELF-HEALING a single hung
    chunk instead of failing the whole job.

    Each chunk worker heartbeats per batch via ``jobs.report_progress``,
    which records its chunk-local ``done`` count in the job's
    ``chunk_progress`` map keyed by ``chunk_keys[i]``. We watch each
    chunk's OWN counter: a chunk whose count hasn't advanced for
    ``stall_timeout_s`` is hung — detected independently of the other
    chunks (which previously masked it, since they kept the job-global
    ``updated_at`` fresh).

    On a hung chunk:
      - if ``respawn_fn`` is given and the chunk has retries left, cancel
        its (wedged) handle and RESUBMIT it on a fresh container
        (``respawn_fn(i)`` returns a new handle for the same frame range).
        The healthy chunks keep running untouched.
      - otherwise (no respawn_fn, or retries exhausted) fall back to the
        legacy behavior: cancel all pending, fail the job, raise.

    ``register_handles_fn(handles)`` (optional) is called whenever the
    handle set changes (initial + after each respawn) so the job's
    child-call registry — used by DELETE /v1/jobs/{id} — stays current
    and a user-cancel still reaches the resubmitted worker.

    Without ``chunk_keys`` this degrades to the old global-heartbeat
    watchdog (back-compat for callers that don't fan out by chunk).

    A real worker exception from ``h.get()`` propagates unchanged (NOT
    masked as a stall). Returns results in handle order on success.

    Injectable seams (default to real impls): ``now_fn``,
    ``read_updated_at_fn(job_id)``, ``read_chunk_progress_fn(job_id)`` ->
    the job's ``chunk_progress`` dict, ``not_ready_exc``.
    """
    if read_updated_at_fn is None:
        read_updated_at_fn = _default_read_updated_at
    if read_chunk_progress_fn is None:
        read_chunk_progress_fn = _default_read_chunk_progress
    if not_ready_exc is None:
        not_ready_exc = _modal_not_ready_exc()

    n = len(handles)
    handles = list(handles)  # mutable: a hung chunk's handle is swapped out
    results = [None] * n
    done = [False] * n
    # per-chunk heartbeat bookkeeping (only used when chunk_keys given)
    per_chunk = chunk_keys is not None and respawn_fn is not None
    last_done = [0] * n          # last-seen chunk-local progress count
    last_advance = [now_fn()] * n  # when that count last increased
    started = [False] * n        # has this chunk emitted a first heartbeat?
    retries = [0] * n            # a queued chunk (not yet started) is NOT hung

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
                continue  # not finished yet
            # any OTHER exception (a real worker error) propagates out.

        if completed_this_sweep:
            continue  # a handle finished — don't check staleness this round

        if per_chunk:
            # ---- per-chunk staleness: judge each pending chunk alone ----
            progress = read_chunk_progress_fn(job_id) or {}
            now = now_fn()
            for i, h in enumerate(handles):
                if done[i]:
                    continue
                key = str(chunk_keys[i])
                # A chunk only appears in chunk_progress once it STARTS
                # running and emits its first heartbeat. With the
                # max_containers concurrency cap, chunks beyond the first N
                # sit QUEUED (no entry) — that is NOT a hang, even for many
                # minutes (they wait for a slot). Don't judge a never-started
                # chunk on its own clock. The wedged-pool case (NOTHING in
                # the whole job advances) is caught separately below via the
                # job-global silence guard, so the job can't hang forever.
                if key not in progress and not started[i]:
                    continue
                cur = int(progress.get(key, 0))
                if not started[i]:
                    # first time we see it report → it has started running;
                    # begin its clock NOW (not at spawn, which may have been
                    # a long time ago while it queued)
                    started[i] = True
                    last_done[i] = cur
                    last_advance[i] = now
                    continue
                if cur > last_done[i]:
                    last_done[i] = cur
                    last_advance[i] = now
                    continue
                if now - last_advance[i] <= stall_timeout_s:
                    continue  # this chunk still within its heartbeat window
                # chunk i is hung (it had started, then went silent)
                if retries[i] < max_chunk_retries:
                    retries[i] += 1
                    jlog.warning(
                        f"🩹 watchdog: chunk {chunk_keys[i]} silent for "
                        f"{int(now - last_advance[i])}s in {label} — resubmitting "
                        f"(retry {retries[i]}/{max_chunk_retries})"
                    )
                    try:
                        h.cancel()  # free the wedged container
                    except Exception:
                        logger.warning("watchdog: cancel of hung chunk failed",
                                       exc_info=True)
                    handles[i] = respawn_fn(i)  # fresh container, same range
                    # the resubmitted chunk re-queues behind the cap — reset
                    # its started flag so we don't immediately re-judge it as
                    # hung while it waits for a slot (the bug this whole
                    # started[] tracking prevents)
                    started[i] = False
                    last_done[i] = 0
                    last_advance[i] = now_fn()
                    if register_handles_fn is not None:
                        register_handles_fn(handles)
                else:
                    # retries exhausted on this chunk → genuine failure
                    _fail_all(job_id, handles, done, jlog, label, retries[i],
                              chunk_keys[i])

            # wedged-pool backstop: if NO chunk advanced anywhere in the
            # whole job for start_timeout_s (much looser than the per-chunk
            # stall — normal queueing keeps SOME chunk heartbeating), the
            # pool is stuck. Fail rather than hang forever on queued chunks
            # that will never get a slot.
            updated_at = read_updated_at_fn(job_id)
            ref = now if updated_at is None else updated_at
            if now - ref > start_timeout_s:
                _fail_all(job_id, handles, done, jlog, label, None, None,
                          silent_for=now - ref, stall_timeout_s=start_timeout_s)
            continue

        # ---- legacy global heartbeat (no chunk_keys/respawn_fn) ----
        updated_at = read_updated_at_fn(job_id)
        # explicit None check: a real updated_at is a unix timestamp, but
        # `updated_at or now_fn()` would mis-read a legit 0.0 as "missing"
        # and never trip — guard against that degenerate case.
        ref = now_fn() if updated_at is None else updated_at
        silent_for = now_fn() - ref
        if silent_for > stall_timeout_s:
            _fail_all(job_id, handles, done, jlog, label, None, None,
                      silent_for=silent_for, stall_timeout_s=stall_timeout_s)

    return results


def _fail_all(job_id, handles, done, jlog, label, retries, chunk_key,
              *, silent_for=None, stall_timeout_s=None):
    """Cancel every pending handle, mark the job failed, and raise — the
    terminal path when recovery is impossible (no respawn_fn, or a chunk
    exhausted its retries)."""
    pending = [h for i, h in enumerate(handles) if not done[i]]
    if chunk_key is not None:
        reason = (f"chunk {chunk_key} hung and exhausted {retries} resubmit(s)")
    else:
        reason = (f"no worker progress for {int(silent_for or 0)}s (silent hang)")
    jlog.error(f"🚨 watchdog: {label} — {reason}; cancelling {len(pending)} worker(s)")
    for h in pending:
        try:
            h.cancel()
        except Exception:
            logger.warning("watchdog: failed to cancel a worker", exc_info=True)
    from app.common import jobs

    err = f"{label} failed: {reason} — cancelled; resubmit"
    jobs.update_job(job_id, status=jobs.FAILED, error=err)
    raise RuntimeError(err)


def _default_read_chunk_progress(job_id):
    from app.common import jobs

    job = jobs.get_job(job_id)
    return (job or {}).get("chunk_progress")


def _default_read_updated_at(job_id):
    from app.common import jobs

    job = jobs.get_job(job_id)
    return (job or {}).get("updated_at")
