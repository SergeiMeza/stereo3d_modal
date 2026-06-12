"""Logging + tensor shape tracking.

Tensor shape/dtype/range tracking was an afterthought in the old
project; here every stage logs tensors at its boundaries via
``track()``. Cheap (a couple of reductions) but can be silenced for
production with TRACK_TENSORS=0.
"""

import logging
import os

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)

TRACK_TENSORS = os.environ.get("TRACK_TENSORS", "1") != "0"


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


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
