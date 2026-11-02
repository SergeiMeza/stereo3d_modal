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

# How long a job may wait with none of its chunks RUNNING before the wedged-
# pool backstop fails it: GPU queueing behind other work, not a hang. Measured
# from the start of each all-queued stretch, so a job whose first chunks
# finished and whose rest wait for a GPU gets this, not START_TIMEOUT_S.
QUEUE_TIMEOUT_S = 4 * 3600
# A hung chunk is RESUBMITTED (fresh container) up to this many times
# before the job is failed — a chunk that hangs repeatedly is a real bug,
# not a transient GPU wedge. Per chunk, not per job.
MAX_CHUNK_RETRIES = 2
# Wedged-pool backstop: while at least one chunk RUNS, fail the job only if
# nothing advances job-wide for this long. Must be well above STALL_TIMEOUT_S.
# The clock stops whenever none of the job's chunks is running (all pending
# chunks queued for a GPU): that stretch is bounded by QUEUE_TIMEOUT_S
# instead. The workspace's GPU limit is shared with other apps, so remaining
# chunks can wait far longer than this after the first ones finished
# (2026-11-03).
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
    read_chunk_state_fn=None,
    clear_chunk_progress_fn=None,
    not_ready_exc=None,
    gpu_wait=None,
    slots=None,
    max_in_flight=None,
    sleep_fn=time.sleep,
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

    ``gpu_wait`` (optional, an ``app.common.gpu_wait.GpuWait``) is told
    on every check whether the job is waiting for a GPU (some chunk pending,
    none running), which keeps the job's ``waiting_for_gpu`` / ``queued_s``
    fields current. Per-chunk mode only.

    ``slots`` (optional, an ``app.common.gpu_slots.GpuSlots``) gates
    spawning on the app-wide GPU cap: pass ``handles`` as ``[None] * n`` and
    the chunks are spawned with ``respawn_fn(i)`` as slots free up, at most
    ``max_in_flight`` of this job at a time. Each spawned chunk holds its
    slot until it finishes (a resubmit reuses the slot of the call it
    cancels); every slot is released on return, failure or cancellation.
    A chunk waiting for a slot is queued, never stalled.

    Injectable seams (default to real impls): ``now_fn``,
    ``read_updated_at_fn(job_id)``, ``read_chunk_progress_fn(job_id)`` ->
    the job's ``chunk_progress`` dict, ``not_ready_exc``.
    """
    if read_updated_at_fn is None:
        read_updated_at_fn = _default_read_updated_at
    if read_chunk_progress_fn is None:
        read_chunk_progress_fn = _default_read_chunk_progress
    if read_chunk_state_fn is None:
        read_chunk_state_fn = _default_read_chunk_state
    if clear_chunk_progress_fn is None:
        clear_chunk_progress_fn = _default_clear_chunk_progress
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
    # Backstop clocks, exactly one set at a time. running_since:
    # start of the current stretch with at least one chunk running.
    # queued_since: start of the current stretch with none running (every
    # pending chunk queued); the spawn counts as its start.
    running_since = None
    queued_since = now_fn()
    tracking = per_chunk and gpu_wait is not None
    gated = slots is not None
    if gated and not per_chunk:
        raise ValueError("slots needs chunk_keys and respawn_fn")
    leases = [None] * n  # the GPU slot each spawned, unfinished chunk holds

    def fill_slots():
        """Spawn waiting chunks while this job is under max_in_flight and
        the app has free GPU slots."""
        in_flight = sum(1 for i in range(n) if handles[i] is not None and not done[i])
        spawned = False
        for i in range(n):
            if done[i] or handles[i] is not None:
                continue
            if max_in_flight is not None and in_flight >= max_in_flight:
                break
            lease = slots.try_acquire(job_id)
            if lease is None:
                break
            leases[i] = lease
            handles[i] = respawn_fn(i)
            slots.attach(lease, handles[i].object_id)
            started[i] = False
            last_done[i] = 0
            last_advance[i] = now_fn()
            in_flight += 1
            spawned = True
        if spawned and register_handles_fn is not None:
            register_handles_fn([h for h in handles if h is not None])

    if tracking:
        gpu_wait.update(True)  # just spawned: queued until a chunk starts
    try:
        while not all(done):
            if gated:
                fill_slots()
            completed_this_sweep = False
            polled = False
            for i, h in enumerate(handles):
                if done[i] or h is None:
                    continue
                polled = True
                try:
                    results[i] = h.get(timeout=poll_s)
                    done[i] = True
                    completed_this_sweep = True
                    if leases[i] is not None:
                        slots.release(leases[i])
                        leases[i] = None
                except not_ready_exc:
                    continue  # not finished yet
                # any OTHER exception (a real worker error) propagates out.
                finally:
                    if gated:
                        for lease in leases:
                            if lease is not None:
                                slots.renew(lease)  # throttled inside
            if gated and not polled:
                sleep_fn(poll_s)  # every pending chunk is waiting for a slot

            if completed_this_sweep:
                continue  # a handle finished — don't check staleness this round

            if per_chunk:
                # ---- per-chunk staleness: judge each pending chunk alone ----
                progress = read_chunk_progress_fn(job_id) or {}
                states = read_chunk_state_fn(job_id) or {}
                now = now_fn()
                for i, h in enumerate(handles):
                    if done[i]:
                        continue
                    key = str(chunk_keys[i])
                    # A chunk appears in chunk_progress only once it STARTS
                    # running and writes a heartbeat. With the max_containers
                    # cap, chunks beyond the first N sit QUEUED (no entry) for
                    # many minutes — NOT a hang; a queued chunk gets UNBOUNDED
                    # patience. This is reliable because on resubmit we CLEAR the
                    # cancelled worker's stale entry (clear_chunk_progress_fn),
                    # so "key not in progress" genuinely means "not running" —
                    # without that clear, a resubmitted chunk's stale key would
                    # mark it started while still queued (the death-spiral bug).
                    # The wedged-pool case (nothing advances job-wide) is the
                    # job-global guard below, so the job can't hang forever.
                    # A chunk its container marked "queued" (preempted, or a
                    # transient error Modal will retry) keeps its last progress
                    # value but is waiting for a GPU again: queued, not stalled,
                    # until a fresh heartbeat marks it running.
                    if states.get(key) == "queued":
                        started[i] = False
                        continue
                    if key not in progress and not started[i]:
                        continue
                    cur = int(progress.get(key, 0))
                    if not started[i]:
                        # first heartbeat seen → running; start its clock NOW
                        # (not at spawn, which may have been a long queue ago)
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
                        # CRITICAL: drop the stale chunk_progress entry the
                        # cancelled worker left behind. The resubmitted worker
                        # reuses the SAME key (frame_range); if the stale value
                        # lingers, `key in progress` stays true, started[] flips
                        # back to True immediately, and the stall clock runs
                        # against a frozen value WHILE the fresh container is
                        # still QUEUED — a resubmit death-spiral (the queued-15min
                        # then instant-cancel pathology). Clearing makes the
                        # chunk genuinely "not started" until its fresh worker
                        # emits a real heartbeat.
                        clear_chunk_progress_fn(job_id, key)
                        handles[i] = respawn_fn(i)  # fresh container, same range
                        if leases[i] is not None:
                            # the cancelled call's GPU slot passes to its
                            # replacement
                            slots.attach(leases[i], handles[i].object_id)
                        # reset so the resubmitted chunk is treated as queued
                        # (unbounded patience) until its first real heartbeat
                        started[i] = False
                        last_done[i] = 0
                        last_advance[i] = now_fn()
                        if register_handles_fn is not None:
                            register_handles_fn([x for x in handles if x is not None])
                    else:
                        # retries exhausted on this chunk → genuine failure
                        _fail_all(job_id, handles, done, jlog, label, retries[i],
                                  chunk_keys[i])

                # wedged-pool backstop. While at least one of THIS job's chunks
                # RUNS: fail if nothing advanced job-wide (updated_at, the
                # heartbeat) for start_timeout_s since the later of the last
                # heartbeat and the start of this running stretch — much looser
                # than the per-chunk stall, so it only catches a stuck pool.
                #
                # While none runs (every pending chunk queued for a GPU, before
                # the first start or after earlier chunks finished), the clock
                # above stops: queueing behind other GPU work lasts longer than
                # start_timeout_s under load and failed healthy jobs as "silent
                # hangs" (audits 2026-10-03, 2026-11-03). That stretch is
                # bounded by QUEUE_TIMEOUT_S from its own start instead. It
                # ignores updated_at, which the waiting_for_gpu writes bump.
                running = any(started[i] and not done[i] for i in range(len(handles)))
                if running:
                    queued_since = None
                    if running_since is None:
                        running_since = now
                    updated_at = read_updated_at_fn(job_id)
                    ref = running_since
                    if updated_at is not None and updated_at > ref:
                        ref = updated_at
                    limit = start_timeout_s
                else:
                    running_since = None
                    if queued_since is None:
                        queued_since = now
                    ref = queued_since
                    limit = max(start_timeout_s, QUEUE_TIMEOUT_S)
                if tracking:
                    gpu_wait.update(not running)
                if now - ref > limit:
                    _fail_all(job_id, handles, done, jlog, label, None, None,
                              silent_for=now - ref, stall_timeout_s=limit,
                              queued=not running)
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
    finally:
        for i, lease in enumerate(leases):
            if lease is not None:
                slots.release(lease)
                leases[i] = None
        if tracking:
            gpu_wait.close()


def _fail_all(job_id, handles, done, jlog, label, retries, chunk_key,
              *, silent_for=None, stall_timeout_s=None, queued=False):
    """Cancel every pending handle, mark the job failed, and raise — the
    terminal path when recovery is impossible (no respawn_fn, or a chunk
    exhausted its retries)."""
    pending = [h for i, h in enumerate(handles) if not done[i] and h is not None]
    if chunk_key is not None:
        reason = (f"chunk {chunk_key} hung and exhausted {retries} resubmit(s)")
    elif queued:
        reason = f"no GPU for {int(silent_for or 0)}s (all chunks queued)"
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


def _default_clear_chunk_progress(job_id, chunk_key):
    from app.common import jobs

    jobs.clear_chunk_progress_key(job_id, chunk_key)


def _default_read_chunk_state(job_id):
    from app.common import jobs

    job = jobs.get_job(job_id) or {}
    return job.get("chunk_state") or {}


def _default_read_updated_at(job_id):
    from app.common import jobs

    job = jobs.get_job(job_id)
    return (job or {}).get("updated_at")
