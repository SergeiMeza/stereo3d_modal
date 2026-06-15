"""Per-run cost estimation for Modal pipeline stages.

Modal does NOT expose a per-call dollar cost in its SDK/API — billing
lives in the dashboard usage system, aggregated per app/function. So we
estimate cost ourselves: every stage already records its wall-clock
``seconds`` and ``gpu`` (see app/common/jobs.py stage_timer), and we
multiply by Modal's published per-second rates.

Three line items, all billed for the stage's wall-clock seconds:

  - GPU      — by GPU type (the dominant cost on GPU stages)
  - CPU      — per physical core, by the function's ``cpu=`` request
  - memory   — per GiB, by the function's memory CEILING (the limit half
               of ``memory=(request, limit)``)

Memory is billed at the ceiling on purpose (conservative upper bound):
Modal actually bills usage between request and limit, which the SDK does
not return per-run. At 24 cores / 300GB alongside a GPU, CPU+memory are a
real fraction of the bill, not rounding error — so they are first-class
here, not dropped.

RATES ARE A MANUAL MIRROR of https://modal.com/pricing and drift when
Modal changes prices. Reconcile the monthly total against the dashboard
Usage export; expect our estimate to run slightly UNDER actual because
container cold-start/import time outside the timed region is not billed
here (the timer wraps the heavy stage, not the whole container).
"""

from __future__ import annotations

# --- Modal published rates, $/second ---------------------------------------
# Source: modal.com/pricing. Update together; stamp RATES_REVISION on bump.
RATES_REVISION = "2026-06-15"

# GPU, $/sec, keyed by the substring Modal/torch report. Lookup is by
# substring match so "NVIDIA H200" or "A100-80GB" both resolve. Order
# matters: more specific keys (A100-80GB) before less specific (A100).
GPU_RATES: dict[str, float] = {
    "H200": 0.001097,        # ~$3.95/hr
    "H100": 0.001097,        # ~$3.95/hr
    "B200": 0.001736,        # ~$6.25/hr
    "A100-80GB": 0.000944,   # ~$3.40/hr
    "A100": 0.000694,        # 40GB, ~$2.50/hr
    "L40S": 0.000542,        # ~$1.95/hr
    "A10G": 0.000306,        # ~$1.10/hr
    "L4": 0.000222,          # ~$0.80/hr
    "T4": 0.000164,          # ~$0.59/hr
}

# CPU billed per physical core-second. Modal: $0.0000131/core/s (~$0.047/hr).
CPU_RATE_PER_CORE_S = 0.0000131

# Memory billed per GiB-second. Modal: $0.00000222/GiB/s (~$0.008/GiB/hr).
MEM_RATE_PER_GIB_S = 0.00000222


def gpu_rate(gpu: str | None) -> float | None:
    """$/sec for a GPU name (substring match), or None if unknown/absent."""
    if not gpu:
        return None
    for key, rate in GPU_RATES.items():
        if key in gpu:
            return rate
    return None


def estimate_cost(
    seconds: float,
    gpu: str | None = None,
    cpu: float | None = None,
    mem_gib: float | None = None,
) -> dict:
    """Estimate the cost of one stage run in USD.

    ``seconds``  wall-clock of the stage (from stage_timer).
    ``gpu``      GPU name as reported by torch/Modal (e.g. "L40S",
                 "NVIDIA H200"); None for CPU-only stages.
    ``cpu``      cores reserved (the function's ``cpu=`` request).
    ``mem_gib``  memory CEILING in GiB (the limit half of ``memory=``).

    Returns a breakdown dict: per-line-item USD plus ``total`` and the
    inputs, so the per-stage YAML is self-explanatory. Unknown GPU →
    gpu line is null and ``gpu_unpriced`` flags it (so a missing rate is
    visible, not silently $0).
    """
    g_rate = gpu_rate(gpu)
    gpu_cost = round(seconds * g_rate, 6) if g_rate is not None else None
    cpu_cost = round(seconds * cpu * CPU_RATE_PER_CORE_S, 6) if cpu else None
    mem_cost = round(seconds * mem_gib * MEM_RATE_PER_GIB_S, 6) if mem_gib else None

    total = round(sum(c for c in (gpu_cost, cpu_cost, mem_cost) if c), 6)
    return {
        "total_usd": total,
        "gpu_usd": gpu_cost,
        "cpu_usd": cpu_cost,
        "mem_usd": mem_cost,
        "seconds": round(seconds, 3),
        "gpu": gpu,
        "cpu_cores": cpu,
        "mem_gib": mem_gib,
        "gpu_unpriced": bool(gpu) and g_rate is None,
        "rates_revision": RATES_REVISION,
    }
