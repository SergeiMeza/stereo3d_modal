#!/usr/bin/env python3
"""Smoke-test the deployed API with the sample inputs.

    python scripts/smoke_test.py --base-url https://stereo-crafter-test--stereo3d-api-test.modal.run
    python scripts/smoke_test.py --base-url ... --only image
    python scripts/smoke_test.py --base-url ... --only video --video clip_1s_480p.mp4 --inpaint none

Requires: requests (pip install requests)
"""

import argparse
import json
import sys
import time

import requests

POLL_SECONDS = 10


def submit(base: str, path: str, body: dict) -> str:
    r = requests.post(f"{base}{path}", json=body, timeout=60)
    r.raise_for_status()
    data = r.json()
    print(f"→ {path}: job {data['job_id']}")
    return data["job_id"]


def wait(base: str, job_id: str, timeout: float = 3600) -> dict:
    start = time.time()
    while time.time() - start < timeout:
        r = requests.get(f"{base}/v1/jobs/{job_id}", timeout=60)
        r.raise_for_status()
        job = r.json()
        status = job["status"]
        stage = job.get("stage") or "-"
        print(f"   {job_id}: {status} (stage={stage}, progress={job.get('progress', 0):.0%})")
        if status in ("completed", "failed"):
            return job
        time.sleep(POLL_SECONDS)
    raise TimeoutError(f"job {job_id} did not finish in {timeout}s")


def report(job: dict) -> None:
    print(json.dumps({k: job.get(k) for k in ("status", "outputs", "error")}, indent=2))
    for t in job.get("timings", []):
        gpu = t.get("gpu") or "cpu"
        print(f"   ⏱  {t['stage']}: {t['seconds']:.1f}s on {gpu}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", required=True)
    parser.add_argument("--only", choices=["health", "image", "video", "scene", "crop"])
    parser.add_argument("--video", default="videos/clip_1s_480p.mp4")
    parser.add_argument("--image", default="images/004_qO-PIF84Vxg.jpg")
    parser.add_argument("--inpaint", default="propainter", choices=["propainter", "none"])
    parser.add_argument("--input-size", type=int, default=518)
    args = parser.parse_args()
    base = args.base_url.rstrip("/")

    failures = 0

    r = requests.get(f"{base}/health", timeout=30)
    print(f"health: {r.status_code} {r.json()}")
    if args.only == "health":
        return 0

    if args.only in (None, "crop"):
        job_id = submit(base, "/v1/stages/crop-detect",
                        {"input_path": "inputs/samples/videos/letterbox_1s_1080p.mp4"})
        job = wait(base, job_id, timeout=900)
        report(job)
        failures += job["status"] != "completed"

    if args.only in (None, "scene"):
        job_id = submit(base, "/v1/stages/scene-detect",
                        {"input_path": "inputs/samples/videos/clip_10s_scenes_480p.mp4"})
        job = wait(base, job_id, timeout=900)
        report(job)
        failures += job["status"] != "completed"

    if args.only in (None, "image"):
        job_id = submit(base, "/v1/images", {
            "input_path": f"inputs/samples/{args.image}",
            "formats": ["lr", "anaglyph"],
        })
        job = wait(base, job_id, timeout=1800)
        report(job)
        failures += job["status"] != "completed"

    if args.only in (None, "video"):
        job_id = submit(base, "/v1/videos", {
            "input_path": f"inputs/samples/{args.video}",
            "inpaint": args.inpaint,
            "input_size": args.input_size,
            "formats": ["sbs", "half_sbs", "anaglyph"],
        })
        job = wait(base, job_id, timeout=3600)
        report(job)
        failures += job["status"] != "completed"

    print("✅ all passed" if failures == 0 else f"❌ {failures} test(s) failed")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
