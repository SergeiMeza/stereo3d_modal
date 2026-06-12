#!/usr/bin/env python3
"""Benchmark the pipeline across resolutions and modes.

Runs the sample matrix through the deployed API, collects the per-stage
timings each job records, estimates cost from Modal's pricing, and
writes docs/BENCHMARKS.md.

    python scripts/benchmark.py --base-url https://...modal.run
    python scripts/benchmark.py --base-url ... --quick       # 1s clips only

Requires: requests
"""

import argparse
import datetime
import json
import time
from pathlib import Path

import requests

DOCS = Path(__file__).resolve().parent.parent / "docs"

# $/hour, from Modal pricing (2026-06)
GPU_RATES = {
    "B200": 6.25, "H200": 4.54, "H100": 3.95, "RTX-PRO-6000": 3.03,
    "A100-80GB": 2.50, "A100-40GB": 2.10, "L40S": 1.95, "A10G": 1.10,
    "L4": 0.80, "T4": 0.59,
}
CPU_RATE_PER_CORE = 0.0473  # rough: ignores memory

VIDEO_MATRIX = [
    # (clip, input_size, inpaint)
    ("videos/clip_1s_480p.mp4", 518, "none"),
    ("videos/clip_1s_480p.mp4", 518, "propainter"),
    ("videos/clip_1s_720p.mp4", 700, "propainter"),
    ("videos/clip_1s_1080p.mp4", 980, "propainter"),
    ("videos/clip_1s_2160p.mp4", 980, "propainter"),
    ("videos/clip_10s_scenes_480p.mp4", 518, "propainter"),
    ("videos/clip_10s_scenes_1080p.mp4", 980, "propainter"),
    ("videos/clip_10s_scenes_2160p.mp4", 980, "propainter"),
    ("videos/letterbox_10s_1080p.mp4", 980, "propainter"),
]
QUICK_MATRIX = [row for row in VIDEO_MATRIX if "_1s_" in row[0]]

IMAGES = [
    "images/001_Sg3XwuEpybU.jpg",
    "images/004_qO-PIF84Vxg.jpg",
    "images/007_5yAhL8ViUVg.jpg",
    "images/013_5Vr_RVPfbMI.jpg",
    "images/019_fliwkBbS7oM.jpg",
    "images/letterbox_frame_2160p.png",
]


def run_job(base: str, path: str, body: dict, timeout: float = 5400) -> dict:
    r = requests.post(f"{base}{path}", json=body, timeout=60)
    r.raise_for_status()
    job_id = r.json()["job_id"]
    print(f"  job {job_id} ← {json.dumps(body)[:100]}")
    start = time.time()
    while time.time() - start < timeout:
        job = requests.get(f"{base}/v1/jobs/{job_id}", timeout=60).json()
        if job["status"] in ("completed", "failed"):
            print(f"  job {job_id} → {job['status']} in {time.time() - start:.0f}s wall")
            return job
        time.sleep(15)
    raise TimeoutError(job_id)


def stage_cost(timing: dict) -> float:
    rate = GPU_RATES.get(timing.get("gpu") or "", 0.0) + CPU_RATE_PER_CORE * 2
    return timing["seconds"] / 3600 * rate


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--quick", action="store_true")
    parser.add_argument("--skip-images", action="store_true")
    args = parser.parse_args()
    base = args.base_url.rstrip("/")

    rows = []
    matrix = QUICK_MATRIX if args.quick else VIDEO_MATRIX
    for clip, input_size, inpaint in matrix:
        print(f"▶ video {clip} input_size={input_size} inpaint={inpaint}")
        job = run_job(base, "/v1/videos", {
            "input_path": f"inputs/samples/{clip}",
            "input_size": input_size,
            "inpaint": inpaint,
        })
        total_s = sum(t["seconds"] for t in job.get("timings", []))
        total_cost = sum(stage_cost(t) for t in job.get("timings", []))
        rows.append({
            "kind": "video", "input": clip, "input_size": input_size,
            "inpaint": inpaint, "status": job["status"],
            "timings": job.get("timings", []),
            "total_seconds": round(total_s, 1), "est_cost_usd": round(total_cost, 4),
            "outputs": job.get("outputs", {}),
        })

    if not args.skip_images:
        print("▶ images (batch of all samples)")
        job = run_job(base, "/v1/images", {
            "items": [{"input_path": f"inputs/samples/{p}"} for p in IMAGES],
            "formats": ["lr", "anaglyph"],
        })
        total_s = sum(t["seconds"] for t in job.get("timings", []))
        rows.append({
            "kind": "image-batch", "input": f"{len(IMAGES)} images",
            "status": job["status"], "timings": job.get("timings", []),
            "total_seconds": round(total_s, 1),
            "est_cost_usd": round(sum(stage_cost(t) for t in job.get("timings", [])), 4),
            "outputs": job.get("outputs", {}),
        })

    write_report(rows)
    print(f"📊 wrote {DOCS / 'BENCHMARKS.md'}")


def write_report(rows: list[dict]) -> None:
    DOCS.mkdir(exist_ok=True)
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [
        f"# Pipeline benchmarks\n\nGenerated {now} by scripts/benchmark.py.\n",
        "Cost estimates use Modal on-demand GPU rates plus ~2 CPU cores;",
        "they exclude container cold starts and storage.\n",
        "| kind | input | depth size | inpaint | status | total s | est. $ |",
        "|---|---|---|---|---|---|---|",
    ]
    for r in rows:
        lines.append(
            f"| {r['kind']} | {r['input']} | {r.get('input_size', '-')} | "
            f"{r.get('inpaint', '-')} | {r['status']} | {r['total_seconds']} | {r['est_cost_usd']} |"
        )
    lines.append("\n## Per-stage timings\n")
    for r in rows:
        lines.append(f"### {r['kind']}: {r['input']} ({r.get('inpaint', '-')})\n")
        lines.append("| stage | seconds | gpu | detail |")
        lines.append("|---|---|---|---|")
        for t in r["timings"]:
            detail = {k: v for k, v in t.get("detail", {}).items() if k != "failed"}
            lines.append(f"| {t['stage']} | {t['seconds']} | {t.get('gpu') or 'cpu'} | {detail} |")
        lines.append("")
    (DOCS / "BENCHMARKS.md").write_text("\n".join(lines))
    (DOCS / "benchmarks.json").write_text(json.dumps(rows, indent=2))


if __name__ == "__main__":
    main()
