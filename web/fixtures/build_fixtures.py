#!/usr/bin/env python3
"""Build gateway-shaped fixtures from REAL Modal API captures.

Inputs (captured with curl against the test deployment):
  modal_analyze_job.json  — GET /v1/jobs/{id} of a completed /v1/analyze job
  modal_video_job.json    — GET /v1/jobs/{id} of a completed /v1/videos job

Outputs (what the GATEWAY serves — shapes must mirror
gateway/internal/api/projects.go projectResponse and handlers.go
conversionResponse exactly):
  project.json            — GET /v1/projects/{id} (analyze succeeded)
  conversion_succeeded.json, conversion_processing.json, conversion_created.json
  scene_profile.json      — the project's scene_profile (adaptive per-scene
                            SHOT_PARAMS), from the video job's
                            metadata.depth_script (first_src/last_src shots)
  downloads_succeeded.json — includes outputs.depth_vis when the job
                            produced the browser-playable 8-bit depth video

scene_profile.json and downloads_succeeded.json are currently HAND-AUTHORED
(marked with a top-level "_note") because the captured modal_video_job.json
predates depth_script/depth_vis; re-running this script against a recapture
(job 82e0a6878392) trues them up and drops the notes.

Run from web/fixtures/:  python3 build_fixtures.py
"""

import json
from pathlib import Path

HERE = Path(__file__).parent
PROJECT_ID = "a1b2c3d4e5f6"


def load(name):
    return json.loads((HERE / name).read_text())


def save(name, data):
    (HERE / name).write_text(json.dumps(data, indent=2) + "\n")
    print(f"wrote {name}")


def build_project(analyze_job: dict) -> dict:
    m = analyze_job["metadata"]
    probe = m["probe"]
    return {
        "project_id": PROJECT_ID,
        "name": "dKmPEhJ4wjY",
        "source_bytes": 110712074,
        "analyze": {
            "state": "succeeded",
            "error": "",
            "credit_cents": 50,
            "credit_available": True,
        },
        "probe": {
            "width": probe["width"],
            "height": probe["height"],
            "fps": probe["fps"],
            "fps_rational": probe["fps_rational"],
            "duration_s": probe["duration"],
            "num_frames": probe["num_frames"],
        },
        "scenes": {
            "version": 1,
            "cuts": m["scene_cuts"],
            "edited": False,
            "updated_at": "2026-07-02T07:00:00Z",
        },
        "crop": m.get("crop") or "",
        "preview_url": (m.get("preview") or {}).get("url", ""),
        "strip_thumbs": m["thumbnails"]["strip"],
        "scene_thumbs": [
            {"frame": t["frame"], "url": t["url"]} for t in m["thumbnails"]["scenes"]
        ],
        "created_at": "2026-07-02T06:55:00Z",
        "updated_at": "2026-07-02T07:00:00Z",
    }


def build_scene_profile(video_job: dict, project: dict) -> None:
    """Emit scene_profile.json from the job's adaptive profiler output
    (metadata.depth_script: shots with first_src/last_src in SOURCE-frame
    space, half-open, tiling the timeline). Skipped when the capture
    predates the profiler — the hand-authored fixture stays in place."""
    script = (video_job.get("metadata") or {}).get("depth_script")
    if not script:
        print("modal_video_job.json has no metadata.depth_script — "
              "keeping the hand-authored scene_profile.json")
        return
    shots = [
        {
            "first_src": s["first_src"],
            "last_src": s["last_src"],
            "shot_type": s["shot_type"],
            "displacement": s["displacement"],
            "placement": s["placement"],
        }
        for s in script
    ]
    save("scene_profile.json", {
        "scene_profile": {
            # id of the succeeded conversion fixture the profile came from
            "conversion_id": "c0ffee000003",
            "scenes_version": project["scenes"]["version"],
            "shots": shots,
            "updated_at": "2026-07-02T07:12:00Z",
        },
    })


def build_conversions(video_job: dict, project: dict) -> None:
    outputs = sorted((video_job.get("outputs") or {}).keys())
    cuts = project["scenes"]["cuts"]
    base_params = {
        "preset": "draft",
        "formats": ["anaglyph"],
        "target_fps": 6,
        "inpaint": "none",
        "scene_cuts": cuts,
    }
    quote = {
        "amount_cents": 50,  # 2.5 min × 10¢/min = 25¢ → 50¢ minimum floor
        "currency": "usd",
        "breakdown": {
            "step": "depth_preview",
            "preset": "draft",
            "billable_seconds": 149.45,
            "cents_per_minute": 10,
            "subtotal_cents": 25,
            "reuse_stages": [],
            "reuse_discount_cents": 0,
            "discount_cents": 0,
            "analyze_credit_cents": 0,
        },
    }
    common = {
        "kind": "video",
        "project_id": PROJECT_ID,
        "step": "depth_preview",
        "scenes_version": 1,
        "params": base_params,
        "quote": quote,
        "created_at": "2026-07-02T07:05:00Z",
    }
    save("conversion_created.json", {
        **common,
        "conversion_id": "c0ffee000001",
        "state": "created",
        "progress": 0,
        "stage": "",
        "eta_seconds": 0,
        "updated_at": "2026-07-02T07:05:00Z",
        "payment": {
            "payment_intent_client_secret": "pi_mock_secret_c0ffee000001",
            "ephemeral_key_secret": "ek_mock",
            "customer_id": "cus_mock",
            "publishable_key": "pk_test_mock",
        },
    })
    save("conversion_processing.json", {
        **common,
        "conversion_id": "c0ffee000002",
        "state": "processing",
        "progress": 0.42,
        "stage": "video_stereo",
        "eta_seconds": 95,
        "updated_at": "2026-07-02T07:08:00Z",
    })
    save("conversion_succeeded.json", {
        **common,
        "conversion_id": "c0ffee000003",
        "state": "succeeded",
        "progress": 1,
        "stage": "",
        "eta_seconds": 0,
        "outputs": outputs,
        "updated_at": "2026-07-02T07:12:00Z",
    })
    # Real signed-URL response shape for GET .../downloads (mock serves the
    # REAL public URLs from the captured job — they render in the browser).
    # A recapture with outputs.depth_vis flows through here unchanged.
    save("downloads_succeeded.json", {
        "downloads": video_job.get("outputs") or {},
        "expires_in": 86400,
    })


def main():
    analyze_job = load("modal_analyze_job.json")
    project = build_project(analyze_job)
    save("project.json", project)
    try:
        video_job = load("modal_video_job.json")
        build_conversions(video_job, project)
        build_scene_profile(video_job, project)
    except FileNotFoundError:
        print("modal_video_job.json not captured yet — skipping conversion fixtures")


if __name__ == "__main__":
    main()
