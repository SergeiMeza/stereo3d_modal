"""App-wide cap on concurrent GPU calls: a lease semaphore in a modal.Dict.

Modal has no app-level GPU cap, and the workspace's GPU limit is shared with
other apps, so this app holds itself to ``cap()`` GPU calls at a time across
every GPU class and variant and across concurrent jobs. Every GPU call is
spawned from a CPU coordinator, so the coordinators enforce it: acquire a
slot before a spawn, release it when the call finishes, fails or is
cancelled (``gpu_call``, ``watchdog.gather_with_heartbeat``).

Layout of the Dict (``stereo3d-gpu-slots-<env>``, one per environment):

- ``slot:<i>`` for i < cap: a lease ``{"job_id", "call_id", "token",
  "acquired_at", "expires_at"}``. Taken with an atomic
  ``put(skip_if_exists=True)``, so at most one lease per slot.
- ``cap`` (optional): runtime override of the cap, an int >= 1. Without it
  the cap is ``STEREO3D_MAX_GPUS`` from the environment, default 8. Set it
  without a redeploy: ``modal.Dict.from_name("stereo3d-gpu-slots-<env>")["cap"] = 6``.

The coordinator renews its leases while it polls; a crashed coordinator's
leases expire after ``LEASE_TTL_S`` and are taken over. Lowering the cap
lets slots at or above the new cap drain without being refilled.

Best effort by design: a Dict error while acquiring counts as "no slot yet"
and the coordinator retries; errors while renewing or releasing are logged
(the lease then expires). An expired-lease takeover can race in a narrow
window; the cost is one call over the cap until a lease ends.
"""

import os
import time
import uuid

from app.common.debug import get_logger

logger = get_logger(__name__)

DEFAULT_MAX_GPUS = 8
CAP_KEY = "cap"
SLOT_PREFIX = "slot:"
# A coordinator renews every RENEW_EVERY_S while it polls; a lease not
# renewed for LEASE_TTL_S belongs to a dead coordinator.
LEASE_TTL_S = 300.0
RENEW_EVERY_S = 60.0


def env_cap() -> int:
    try:
        return max(1, int(os.environ.get("STEREO3D_MAX_GPUS", DEFAULT_MAX_GPUS)))
    except ValueError:
        return DEFAULT_MAX_GPUS


def _valid_cap(value):
    try:
        cap = int(value)
    except (TypeError, ValueError):
        return None
    return cap if cap >= 1 else None


class Lease:
    def __init__(self, key, token, job_id):
        self.key = key
        self.token = token
        self.job_id = job_id
        self.call_id = None
        self.renewed_at = None


class GpuSlots:
    def __init__(self, store=None, *, now_fn=time.time, ttl_s=LEASE_TTL_S):
        self._store = store
        self._now = now_fn
        self.ttl_s = ttl_s

    @property
    def store(self):
        if self._store is None:
            import modal

            from app.env import APP_ENV

            self._store = modal.Dict.from_name(
                f"stereo3d-gpu-slots-{APP_ENV}", create_if_missing=True)
        return self._store

    def cap(self) -> int:
        try:
            override = _valid_cap(self.store.get(CAP_KEY))
        except Exception:
            logger.warning("gpu slots: cap read failed", exc_info=True)
            override = None
        return override or env_cap()

    def leases(self) -> dict:
        """slot key -> lease, every slot currently held (expired too)."""
        return {k: v for k, v in self.store.items()
                if isinstance(k, str) and k.startswith(SLOT_PREFIX)}

    def try_acquire(self, job_id, call_id=None):
        """A Lease, or None when every slot below the cap is held."""
        try:
            items = dict(self.store.items())
        except Exception:
            logger.warning("gpu slots: listing failed", exc_info=True)
            return None
        cap = _valid_cap(items.get(CAP_KEY)) or env_cap()
        now = self._now()
        for i in range(cap):
            key = f"{SLOT_PREFIX}{i}"
            cur = items.get(key)
            if cur is not None:
                if (cur.get("expires_at") or 0) >= now:
                    continue
                if not self._evict(key, cur):
                    continue
            lease = Lease(key, uuid.uuid4().hex, job_id)
            try:
                if self.store.put(key, self._value(lease, call_id, now),
                                  skip_if_exists=True):
                    lease.call_id = call_id
                    lease.renewed_at = now
                    return lease
            except Exception:
                logger.warning("gpu slots: put failed", exc_info=True)
        return None

    def _evict(self, key, expired) -> bool:
        """Drop an expired lease. If someone replaced it since our listing,
        put theirs back and leave the slot alone."""
        try:
            popped = self.store.pop(key, None)
        except Exception:
            logger.warning("gpu slots: evict failed", exc_info=True)
            return False
        if popped is not None and popped.get("token") != expired.get("token"):
            try:
                self.store.put(key, popped, skip_if_exists=True)
            except Exception:
                pass
            return False
        if popped is not None:
            logger.warning(f"gpu slots: took over expired {key} of job "
                           f"{expired.get('job_id')} (call {expired.get('call_id')})")
        return True

    def _value(self, lease, call_id, now):
        return {"job_id": lease.job_id, "call_id": call_id, "token": lease.token,
                "acquired_at": now, "expires_at": now + self.ttl_s}

    def attach(self, lease, call_id) -> None:
        """Record the call that holds the slot (and renew the lease)."""
        lease.call_id = call_id
        self.renew(lease, force=True)

    def renew(self, lease, *, force=False) -> bool:
        """Push the lease's expiry out; throttled to RENEW_EVERY_S unless
        forced. False when the lease is gone (expired and taken over, or
        released by DELETE /v1/jobs/{id})."""
        now = self._now()
        if not force and lease.renewed_at is not None and now - lease.renewed_at < RENEW_EVERY_S:
            return True
        try:
            cur = self.store.get(lease.key)
            if not cur or cur.get("token") != lease.token:
                return False
            cur = dict(cur)
            cur["call_id"] = lease.call_id
            cur["expires_at"] = now + self.ttl_s
            self.store[lease.key] = cur
            lease.renewed_at = now
            return True
        except Exception:
            logger.warning("gpu slots: renew failed", exc_info=True)
            return True  # transient: the lease outlives a few failed renews

    def release(self, lease) -> None:
        if lease is None:
            return
        try:
            cur = self.store.get(lease.key)
            if cur and cur.get("token") == lease.token:
                self.store.pop(lease.key, None)
        except Exception:
            logger.warning("gpu slots: release failed (lease will expire)", exc_info=True)

    def release_job(self, job_id) -> int:
        """Drop every lease of ``job_id`` (DELETE /v1/jobs/{id})."""
        n = 0
        try:
            for key, cur in self.leases().items():
                if (cur or {}).get("job_id") == job_id:
                    self.store.pop(key, None)
                    n += 1
        except Exception:
            logger.warning("gpu slots: release_job failed", exc_info=True)
        return n


def acquire(slots, job_id, *, gpu_wait=None, poll_s=10.0, sleep_fn=time.sleep):
    """Block until a slot is free; the wait counts as waiting for a GPU."""
    while True:
        lease = slots.try_acquire(job_id)
        if lease is not None:
            return lease
        if gpu_wait is not None:
            gpu_wait.update(True)
        sleep_fn(poll_s)
