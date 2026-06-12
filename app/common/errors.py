"""Fail-fast error policy for workers.

Modal's ``retries=`` re-runs a function on ANY exception — for a
deterministic bug (import error, bad argument, frame-count mismatch,
OOM on the same input) that means N expensive cold starts before the
job is finally marked failed (observed: 31 min for an instant
ModuleNotFoundError on a GPU worker).

Preemption recovery does NOT depend on retries (Modal always restarts
preempted calls), so retries only need to cover transient faults.

``fail_fast`` wraps a worker entrypoint: transient errors re-raise
(Modal retries them), everything else returns an error envelope on the
FIRST attempt. Callers unwrap with ``check_worker_result``.
"""

import functools
import traceback

from app.common.debug import get_logger

logger = get_logger(__name__)

# Errors worth a retry: network/filesystem races, timeouts, downloads.
# Everything else (ImportError, ValueError, RuntimeError, torch OOM on
# the same input, ...) will fail identically on every attempt.
TRANSIENT_ERRORS = (OSError, TimeoutError)

FAILED_KEY = "_worker_failed"


def fail_fast(fn):
    @functools.wraps(fn)
    def wrapper(*args, **kwargs):
        try:
            return fn(*args, **kwargs)
        except TRANSIENT_ERRORS:
            raise  # let Modal's retry policy handle it
        except Exception as exc:
            logger.exception(f"💥 deterministic failure in {fn.__name__} — not retrying")
            return {
                FAILED_KEY: True,
                "error": f"{type(exc).__name__}: {exc}",
                "traceback": traceback.format_exc()[-2000:],
            }

    return wrapper


def check_worker_result(result: dict, stage: str) -> dict:
    """Raise if a fail_fast worker returned an error envelope."""
    if isinstance(result, dict) and result.get(FAILED_KEY):
        raise RuntimeError(f"{stage} failed: {result['error']}")
    return result
