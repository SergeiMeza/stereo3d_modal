"""Logging + tensor shape tracking.

Conventions:
- module loggers via ``get_logger(__name__)``; level from LOG_LEVEL env
  (default INFO).
- everything that happens on behalf of a job logs through
  ``job_logger(job_id)`` so lines are greppable per job across
  containers: ``... [job:abc123] message``.
- tensors are logged at stage boundaries via ``track()``
  (shape/dtype/device/range); disable with TRACK_TENSORS=0.
- stage start/finish lines come from jobs.stage_timer, so the Modal log
  stream alone tells the pipeline story.
"""

import logging
import os

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

TRACK_TENSORS = os.environ.get("TRACK_TENSORS", "1") != "0"


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def job_logger(job_id: str, name: str = "job") -> "_JobAdapter":
    """Logger that prefixes every line with the job id, so one job can
    be traced across interleaved container logs."""
    return _JobAdapter(logging.getLogger(name), job_id)


class _JobAdapter(logging.LoggerAdapter):
    def __init__(self, logger: logging.Logger, job_id: str):
        super().__init__(logger, {"job_id": job_id})
        self.job_id = job_id

    def process(self, msg, kwargs):
        return f"[job:{self.job_id}] {msg}", kwargs


def track(name: str, tensor, logger: logging.Logger | None = None):
    """Log shape/dtype/device/range of a tensor (or pass-through None)."""
    if not TRACK_TENSORS or tensor is None:
        return tensor
    log = (logger or logging.getLogger("tensor")).info
    try:
        mn = tensor.min().item()
        mx = tensor.max().item()
        log(
            f"📐 {name}: shape={tuple(tensor.shape)} dtype={tensor.dtype} "
            f"device={tensor.device} range=[{mn:.4g}, {mx:.4g}]"
        )
    except Exception:
        log(f"📐 {name}: type={type(tensor)}")
    return tensor
