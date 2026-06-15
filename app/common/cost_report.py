"""Per-stage and final cost YAML written to GCS next to job outputs.

For each timed stage we drop ``costs/<stage>.yaml`` into the job's bucket
output dir (alongside depth.mp4, sbs.mp4, the mvhevc, etc). When the job
completes we write ``cost.yaml`` — the rolled-up total across stages.

We hand-serialize a small, flat YAML rather than depend on PyYAML, which
is not installed in most of the pipeline's Modal images. The structures
here are fully under our control (cost breakdowns, simple scalars and
short lists), so a minimal emitter is safe and avoids touching every
image definition.

Writes go through the CloudBucketMount (see app/common/storage.py), so a
plain file write lands in GCS. Everything here is best-effort: callers
wrap in try/except so a storage hiccup never fails a pipeline job.
"""

from __future__ import annotations

import time
from pathlib import Path


def _scalar(v) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return repr(v)
    s = str(v)
    # quote when YAML could misread it (special chars, leading/trailing ws)
    if s == "" or s != s.strip() or any(c in s for c in ":#[]{}&*!|>%@`\"'\n"):
        return '"' + s.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return s


def _emit(obj, indent: int = 0) -> list[str]:
    """Serialize a dict/list/scalar tree to YAML lines. Flat-ish: enough
    for cost breakdowns and short detail maps, not a general emitter."""
    pad = "  " * indent
    lines: list[str] = []
    if isinstance(obj, dict):
        if not obj:
            return [pad + "{}"]
        for k, v in obj.items():
            if isinstance(v, (dict, list)) and v:
                lines.append(f"{pad}{k}:")
                lines.extend(_emit(v, indent + 1))
            else:
                lines.append(f"{pad}{k}: {_scalar(v) if not isinstance(v, (dict, list)) else ('{}' if isinstance(v, dict) else '[]')}")
    elif isinstance(obj, list):
        if not obj:
            return [pad + "[]"]
        for item in obj:
            if isinstance(item, (dict, list)) and item:
                lines.append(f"{pad}-")
                lines.extend(_emit(item, indent + 1))
            else:
                lines.append(f"{pad}- {_scalar(item)}")
    else:
        lines.append(pad + _scalar(obj))
    return lines


def dumps(obj) -> str:
    return "\n".join(_emit(obj)) + "\n"


def _costs_dir(job_id: str) -> Path:
    from app.common.storage import job_output_dir

    d = job_output_dir(job_id) / "costs"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _safe_name(stage: str) -> str:
    """Stage names contain '[', ']', ':' (e.g. video_depth[0:240]); make a
    filesystem-safe slug so each fan-out chunk gets its own yaml."""
    return "".join(c if (c.isalnum() or c in "-_.") else "_" for c in stage)


def write_stage_cost(job_id: str, stage: str, cost: dict, detail: dict | None = None) -> None:
    """Write costs/<stage>.yaml for one timed stage."""
    doc = {
        "job_id": job_id,
        "stage": stage,
        "written_at": round(time.time(), 3),
        "cost": cost,
    }
    if detail:
        doc["detail"] = detail
    path = _costs_dir(job_id) / f"{_safe_name(stage)}.yaml"
    path.write_text(dumps(doc))


def summarize(timings: list[dict]) -> dict:
    """Roll per-stage costs in a job's ``timings`` into a final summary."""
    total = gpu = cpu = mem = 0.0
    per_stage = []
    by_gpu: dict[str, float] = {}
    unpriced: list[str] = []
    for t in timings:
        c = t.get("cost") or {}
        st = t.get("stage", "?")
        total += c.get("total_usd") or 0.0
        gpu += c.get("gpu_usd") or 0.0
        cpu += c.get("cpu_usd") or 0.0
        mem += c.get("mem_usd") or 0.0
        if c.get("gpu_unpriced"):
            unpriced.append(st)
        g = c.get("gpu")
        if g and c.get("gpu_usd"):
            by_gpu[g] = round(by_gpu.get(g, 0.0) + c["gpu_usd"], 6)
        per_stage.append(
            {
                "stage": st,
                "seconds": t.get("seconds"),
                "gpu": g,
                "total_usd": c.get("total_usd"),
            }
        )
    summary = {
        "total_usd": round(total, 6),
        "gpu_usd": round(gpu, 6),
        "cpu_usd": round(cpu, 6),
        "mem_usd": round(mem, 6),
        "total_seconds": round(sum(t.get("seconds") or 0.0 for t in timings), 3),
        "stage_count": len(timings),
        "by_gpu_usd": by_gpu,
        "stages": per_stage,
    }
    if unpriced:
        # surfaced, not hidden: a missing GPU rate understates the total
        summary["gpu_unpriced_stages"] = unpriced
    return summary


def write_final_cost(job_id: str, timings: list[dict]) -> dict:
    """Write costs/cost.yaml (the rolled-up total) and return the summary."""
    summary = summarize(timings)
    doc = {
        "job_id": job_id,
        "written_at": round(time.time(), 3),
        **summary,
    }
    path = _costs_dir(job_id) / "cost.yaml"
    path.write_text(dumps(doc))
    return summary
