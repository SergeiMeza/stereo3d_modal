"""Time a job spends waiting for a GPU, on its job record.

The workspace's GPU limit is shared with other apps, so a job's GPU calls
can sit QUEUED for long stretches. Clients see that through two fields of
the job record (names shared with the Lifelike app):

- ``waiting_for_gpu``: true while at least one of the job's GPU calls is
  queued and none is running.
- ``queued_s``: total seconds the job spent in that state, across stages.

``GpuWait`` keeps both current. The coordinator tells it, on every poll,
whether the job is waiting; it writes on transitions and at most every
``interval_s`` while waiting, never on every poll.

``gpu_call`` replaces a blocking ``method.remote(...)`` on a GPU worker:
it takes a slot of the app-wide GPU cap (app/common/gpu_slots.py), spawns
the call, registers it for DELETE /v1/jobs/{id}, and polls it while
tracking the wait (the slot wait counts as waiting for a GPU). A call
counts as running once the job's ``stage_starts`` counter (bumped by
``jobs.stage_timer.__enter__`` inside the worker) moves past its value at
spawn; until then it is queued.
"""

import time

from app.common.debug import get_logger

logger = get_logger(__name__)

# While waiting, refresh queued_s at most this often.
WRITE_INTERVAL_S = 30.0
# gpu_call poll interval (one job-record read per poll).
POLL_S = 10.0


class GpuWait:
    """Tracks one job's GPU wait and writes it to the job record.

    Best effort: a failed read or write is logged and never raised, so the
    bookkeeping can't fail a job. ``read_fn()`` -> the job's current
    ``queued_s``; ``write_fn(waiting, queued_s)`` writes both fields.
    """

    def __init__(self, job_id, *, interval_s=WRITE_INTERVAL_S, now_fn=time.time,
                 read_fn=None, write_fn=None):
        self.job_id = job_id
        self.interval_s = interval_s
        self._now = now_fn
        self._read = read_fn or self._default_read
        self._write_fn = write_fn or self._default_write
        self.waiting = False
        self._since = None       # start of the current waiting stretch
        self._base = None        # queued_s before the current stretch
        self._last_write = None

    def update(self, waiting: bool) -> None:
        now = self._now()
        if waiting and not self.waiting:
            if self._base is None:
                self._base = self._safe_read()
            self.waiting = True
            self._since = now
            self._write(True, self._base, now)
        elif waiting:
            if now - self._last_write >= self.interval_s:
                self._write(True, self._base + (now - self._since), now)
        elif self.waiting:
            self._base += now - self._since
            self.waiting = False
            self._since = None
            self._write(False, self._base, now)

    def close(self) -> None:
        """The calls finished, failed or were cancelled: stop waiting."""
        self.update(False)

    @property
    def queued_s(self) -> float:
        base = self._base or 0.0
        if self.waiting:
            base += self._now() - self._since
        return base

    def _write(self, waiting, queued_s, now):
        self._last_write = now
        try:
            self._write_fn(waiting, round(queued_s, 1))
        except Exception:
            logger.warning("gpu wait: job record write failed", exc_info=True)

    def _safe_read(self) -> float:
        try:
            return float(self._read() or 0.0)
        except Exception:
            logger.warning("gpu wait: job record read failed", exc_info=True)
            return 0.0

    def _default_read(self):
        from app.common import jobs

        return (jobs.get_job(self.job_id) or {}).get("queued_s")

    def _default_write(self, waiting, queued_s):
        from app.common import jobs

        jobs.update_job(self.job_id, waiting_for_gpu=waiting, queued_s=queued_s)


def gpu_call(job_id, method, *args, **kwargs):
    """``method.remote(*args, **kwargs)`` for a GPU worker, with the wait
    tracked on the job record, a slot of the app-wide GPU cap held for the
    call's lifetime, and the call cancellable through DELETE /v1/jobs/{id}.
    Returns the result or raises the worker's exception, like ``.remote()``."""
    return _gpu_call(job_id, method, args, kwargs)


def _gpu_call(job_id, method, args, kwargs, *, poll_s=POLL_S, gpu_wait=None,
              slots=None, sleep_fn=time.sleep, read_starts_fn=None,
              register_fn=None, clear_fn=None, not_ready_exc=None):
    from app.common.gpu_slots import GpuSlots, acquire
    from app.common.watchdog import _modal_not_ready_exc

    if read_starts_fn is None:
        read_starts_fn = _default_read_starts
    if register_fn is None:
        register_fn = _default_register
    if clear_fn is None:
        clear_fn = _default_clear
    if not_ready_exc is None:
        not_ready_exc = _modal_not_ready_exc()
    if gpu_wait is None:
        gpu_wait = GpuWait(job_id)
    if slots is None:
        slots = GpuSlots()

    gpu_wait.update(True)  # waiting for a slot, then queued until the start mark
    lease = call = None
    try:
        lease = acquire(slots, job_id, gpu_wait=gpu_wait, poll_s=poll_s,
                        sleep_fn=sleep_fn)
        starts0 = _safe_starts(read_starts_fn, job_id)
        call = method.spawn(*args, **kwargs)
        slots.attach(lease, call.object_id)
        try:
            register_fn(job_id, [call.object_id])
        except Exception:
            logger.warning("gpu call: child-call registration failed", exc_info=True)
        started = False
        while True:
            try:
                return call.get(timeout=poll_s)
            except not_ready_exc:
                pass
            slots.renew(lease)
            if not started:
                cur = _safe_starts(read_starts_fn, job_id)
                started = starts0 is not None and cur is not None and cur > starts0
            gpu_wait.update(not started)
    except BaseException as exc:
        if call is not None and not isinstance(exc, Exception):
            # the coordinator itself is being cancelled or torn down: don't
            # leave its GPU call running
            try:
                call.cancel()
            except Exception:
                pass
        raise
    finally:
        slots.release(lease)
        gpu_wait.close()
        if call is not None:
            try:
                clear_fn(job_id)
            except Exception:
                logger.warning("gpu call: child-call clear failed", exc_info=True)


def _safe_starts(read_starts_fn, job_id):
    try:
        return int(read_starts_fn(job_id) or 0)
    except Exception:
        logger.warning("gpu call: stage_starts read failed", exc_info=True)
        return None


def _default_read_starts(job_id):
    from app.common import jobs

    return (jobs.get_job(job_id) or {}).get("stage_starts")


def _default_register(job_id, call_ids):
    from app.common import jobs

    jobs.register_child_calls(job_id, call_ids)


def _default_clear(job_id):
    from app.common import jobs

    jobs.clear_child_calls(job_id)
