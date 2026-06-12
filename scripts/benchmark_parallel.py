#!/usr/bin/env python3
"""Parallel benchmark runner.

Submits the whole matrix at once (each pipeline stage holds at most one
GPU, so the matrix fits the 10-GPU workspace limit), then collects.

    python scripts/benchmark_parallel.py --base-url URL submit
    python scripts/benchmark_parallel.py --base-url URL collect   # repeat until done

State in /tmp/stereo3d_bench.json; report in docs/BENCHMARKS.md.
"""

import argparse
import datetime
import json
import sys
from pathlib import Path

import requests

from benchmark import GPU_RATES, CPU_RATE_PER_CORE, IMAGES, VIDEO_MATRIX  # reuse

STATE = Path("/tmp/stereo3d_bench.json")
DOCS = Path(__file__).resolve().parent.parent / "docs"


def stage_cost(timing: dict) -> float:
    rate = GPU_RATES.get(timing.get("gpu") or "", 0.0) + CPU_RATE_PER_CORE * 2
    return timing["seconds"] / 3600 * rate


def submit(base: str) -> None:
    runs = []
    for clip, input_size, inpaint in VIDEO_MATRIX:
        body = {"input_path": f"inputs/samples/{clip}", "input_size": input_size,
                "inpaint": inpaint}
        r = requests.post(f"{base}/v1/videos", json=body, timeout=60)
        r.raise_for_status()
        runs.append({"kind": "video", "input": clip, "input_size": input_size,
                     "inpaint": inpaint, "job_id": r.json()["job_id"]})
        print(f"submitted {clip} ({inpaint}, {input_size}) -> {runs[-1]['job_id']}")

    body = {"items": [{"input_path": f"inputs/samples/{p}"} for p in IMAGES],
            "formats": ["lr", "anaglyph"]}
    r = requests.post(f"{base}/v1/images", json=body, timeout=60)
    r.raise_for_status()
    runs.append({"kind": "image-batch", "input": f"{len(IMAGES)} images",
                 "job_id": r.json()["job_id"]})
    print(f"submitted image batch -> {runs[-1]['job_id']}")
    STATE.write_text(json.dumps(runs, indent=2))


def collect(base: str) -> int:
    runs = json.loads(STATE.read_text())
    pending = 0
    for run in runs:
        if run.get("status") in ("completed", "failed"):
            continue
        job = requests.get(f"{base}/v1/jobs/{run['job_id']}", timeout=60).json()
        run["status"] = job["status"]
        run["stage"] = job.get("stage")
        if job["status"] in ("completed", "failed"):
            run["timings"] = job.get("timings", [])
            run["outputs"] = job.get("outputs", {})
            run["error"] = job.get("error")
            run["total_seconds"] = round(sum(t["seconds"] for t in run["timings"]), 1)
            run["est_cost_usd"] = round(sum(stage_cost(t) for t in run["timings"]), 4)
        else:
            pending += 1
        state = run.get("status", "?")
        print(f"  {run['job_id']} {run['input']:42s} {state:12s} stage={run.get('stage')}")
    STATE.write_text(json.dumps(runs, indent=2))
    if pending == 0:
        write_report(runs)
        print(f"\n📊 all done — wrote {DOCS / 'BENCHMARKS.md'}")
    else:
        print(f"\n{pending} run(s) still pending")
    return pending


def write_report(rows: list[dict]) -> None:
    DOCS.mkdir(exist_ok=True)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        f"# Pipeline benchmarks\n\nGenerated {now} by scripts/benchmark_parallel.py.\n",
        "Cost estimates: Modal on-demand GPU rates + ~2 CPU cores; excludes",
        "cold starts and storage. Stage timings are recorded by the jobs themselves.\n",
        "| kind | input | depth size | inpaint | status | total s | est. $ |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['kind']} | {r['input']} | {r.get('input_size', '-')} | "
            f"{r.get('inpaint', '-')} | {r.get('status')} | {r.get('total_seconds', '-')} | "
            f"{r.get('est_cost_usd', '-')} |"
        )
    lines.append("\n## Per-stage timings\n")
    for r in rows:
        lines.append(f"### {r['kind']}: {r['input']} ({r.get('inpaint', '-')}, depth {r.get('input_size', '-')})\n")
        lines.append("| stage | seconds | gpu | detail |")
        lines.append("|---|---|---|---|")
        for t in r.get("timings", []):
            detail = {k: v for k, v in t.get("detail", {}).items() if k != "failed"}
            lines.append(f"| {t['stage']} | {t['seconds']} | {t.get('gpu') or 'cpu'} | {detail} |")
        lines.append("")
    (DOCS / "BENCHMARKS.md").write_text("\n".join(lines))
    (DOCS / "benchmarks.json").write_text(json.dumps(rows, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("mode", choices=["submit", "collect"])
    args = parser.parse_args()
    base = args.base_url.rstrip("/")
    if args.mode == "submit":
        submit(base)
    else:
        sys.exit(1 if collect(base) else 0)
