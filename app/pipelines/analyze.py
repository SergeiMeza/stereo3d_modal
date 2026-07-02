"""Video analysis orchestrator (pro step pipeline): probe + crop detect +
scene detect + filmstrip thumbnails. CPU-only and cheap — the funnel entry
for the web client (free upfront, credited against the first paid
conversion; see web/DESIGN.md).

Single-container by design: the source is decoded ONCE into a small H.264
proxy, and scene detection + all thumbnails run from the proxy inside this
container. Two reasons:
- robustness: PySceneDetect/OpenCV silently finds nothing on some sources
  (observed: 4K AV1 webm → 0 cuts on a 79-shot video); ffmpeg decodes
  everything, so the proxy is the reliable substrate;
- cost accuracy: one container under one stage_timer — no idle orchestrator
  blocking on a remote worker the estimate can't see.

All frame indices in the result are SOURCE-frame space (the proxy is a
frame-exact 1:1 transcode — verified, job fails loudly on any mismatch), so
the web scene editor round-trips indices straight into ``scene_cuts`` of
POST /v1/videos.
"""

import subprocess
from pathlib import Path

from app.common import jobs
from app.common.debug import get_logger
from app.common.storage import PIPELINE_VOLUMES, slack_secret
from app.images import media_image
from app.modal_app import app

logger = get_logger(__name__)

PROXY_SHORT_SIDE = 480    # proxy resolution (short side); also scene-thumb height
STRIP_HEIGHT = 90         # filmstrip tile height (timeline scrubber)
DEFAULT_STRIP_COUNT = 100
MAX_STRIP_COUNT = 300


def _strip_indices(num_frames: int, count: int) -> list[int]:
    """``count`` evenly spaced frame indices across [0, num_frames),
    always including frame 0 and the last frame, deduped and sorted."""
    if num_frames <= 0:
        return []
    count = max(1, min(count, num_frames))
    if count == 1:
        return [0]
    return sorted({round(i * (num_frames - 1) / (count - 1)) for i in range(count)})


def _make_proxy(src: Path, dest: Path, short_side: int) -> None:
    """Frame-exact 1:1 proxy transcode (scale only — no fps/trim filters, so
    proxy frame n IS source frame n). Audio rides along (AAC) when the source
    has a track — review with sound in the web player; ``0:a:0?`` keeps
    silent sources valid. faststart fronts the moov atom so playback starts
    before the whole file arrives."""
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error", "-i", str(src),
            "-map", "0:v:0", "-map", "0:a:0?",
            "-vf", f"scale=-2:{short_side}",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-c:a", "aac", "-b:a", "128k",
            "-movflags", "+faststart",
            str(dest),
        ],
        check=True,
    )


def _detect_scenes_inline(path: Path) -> list[dict]:
    from scenedetect import AdaptiveDetector, SceneManager, open_video

    video = open_video(str(path))
    manager = SceneManager()
    manager.add_detector(AdaptiveDetector())
    manager.detect_scenes(video=video)
    return [
        {"start": start.get_frames(), "end": end.get_frames(),
         "start_sec": start.get_seconds(), "end_sec": end.get_seconds()}
        for start, end in manager.get_scene_list()
    ]


def _extract_frames(src: Path, indices: list[int], height: int,
                    out_dir: Path, prefix: str) -> list[dict]:
    """One ffmpeg pass over the proxy: keep exactly the frames in
    ``indices``, scale to ``height``. Output files number 1..k in ascending
    frame order (select preserves order), so file n maps to indices[n-1].
    Returns [{"frame", "url"}, …]."""
    from app.common.storage import public_url

    if not indices:
        return []
    out_dir.mkdir(parents=True, exist_ok=True)
    expr = "+".join(f"eq(n\\,{i})" for i in indices)
    subprocess.run(
        [
            "ffmpeg", "-y", "-v", "error", "-i", str(src),
            "-vf", f"select='{expr}',scale=-2:{height}",
            "-vsync", "0", "-q:v", "4",
            str(out_dir / f"{prefix}_%05d.jpg"),
        ],
        check=True,
    )
    thumbs = []
    for n, frame in enumerate(indices, start=1):
        f = out_dir / f"{prefix}_{n:05d}.jpg"
        if f.exists():  # tail indices past a short container count may miss
            thumbs.append({"frame": frame, "url": public_url(f)})
    return thumbs


@app.function(
    image=media_image,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    cpu=4,
    memory=(2 * 1024, 8 * 1024),
    timeout=2 * 3600,
    nonpreemptible=True,
)
def process_analyze_job(job_id: str, request: dict) -> dict:
    """request: {"input_path": ..., "remove_black_bars"?: bool,
    "strip_count"?: int}. Results land in job metadata:
    probe (fps_rational!), crop, scenes, scene_cuts (source frames),
    thumbnails {strip: [{frame,url}], scenes: [{scene,frame,url}]}."""
    from app.common.debug import job_logger
    from app.common.storage import bucket_path, job_cache_dir, job_output_dir, public_url
    from app.stages.media import detect_crop, probe_video

    jlog = job_logger(job_id)
    try:
        input_path = request["input_path"]
        src = bucket_path(input_path)
        if not src.exists():
            raise FileNotFoundError(f"input video not found: {input_path}")

        jobs.update_job(job_id, status=jobs.IN_PROGRESS, stage="analyze", progress=0.05)
        with jobs.stage_timer(job_id, "analyze"):
            probe = probe_video(src)
            jlog.info(f"🎯 analyze: {probe['width']}x{probe['height']} "
                      f"{probe['num_frames']}f @ {probe['fps_rational']}")
            crop = detect_crop(src, probe) if request.get("remove_black_bars", True) else None

            # single decode of the source → frame-exact proxy; everything
            # below reads the proxy
            jobs.update_job(job_id, progress=0.15, stage="proxy")
            proxy = job_cache_dir(job_id) / "analyze_proxy.mp4"
            _make_proxy(src, proxy, PROXY_SHORT_SIDE)
            proxy_probe = probe_video(proxy)
            # The proxy is a full 1:1 decode, so ITS frame count is the
            # source's true decodable count. Container metadata can only
            # estimate (webm has no nb_frames; duration×fps rounds up —
            # observed: 3588 estimated vs 3587 real). Adopt the decoded
            # count; fail only when the decode is truly truncated.
            if proxy_probe["num_frames"] <= 0:
                raise RuntimeError("proxy decode produced no frames")
            if abs(proxy_probe["num_frames"] - probe["num_frames"]) > max(2, probe["num_frames"] // 100):
                raise RuntimeError(
                    f"proxy decoded {proxy_probe['num_frames']} frames but the "
                    f"source claims {probe['num_frames']} — decode truncated?"
                )
            if proxy_probe["num_frames"] != probe["num_frames"]:
                jlog.info(f"📐 frame count corrected: container metadata said "
                          f"{probe['num_frames']}, decode says {proxy_probe['num_frames']}")
                probe["num_frames"] = proxy_probe["num_frames"]

            jobs.update_job(job_id, progress=0.45, stage="scene_detect")
            scenes = _detect_scenes_inline(proxy) or [
                {"start": 0, "end": probe["num_frames"],
                 "start_sec": 0.0, "end_sec": probe["duration"]}
            ]
            cuts = [s["start"] for s in scenes[1:]]
            jlog.info(f"🎬 {len(scenes)} scene(s), crop={crop}")

            jobs.update_job(job_id, progress=0.7, stage="thumbnails")
            strip_count = int(request.get("strip_count", DEFAULT_STRIP_COUNT))
            strip_count = max(10, min(strip_count, MAX_STRIP_COUNT))
            thumbs_dir = job_output_dir(job_id) / "thumbs"
            strip = _extract_frames(
                proxy, _strip_indices(probe["num_frames"], strip_count),
                STRIP_HEIGHT, thumbs_dir, "strip",
            )
            # per-scene keyframe: the middle frame is more representative
            # than the first (cuts often land on transitions/black frames)
            mids = [(s["start"] + max(s["start"], s["end"] - 1)) // 2 for s in scenes]
            keyframes = _extract_frames(proxy, mids, PROXY_SHORT_SIDE, thumbs_dir, "scene")

            # Publish the proxy as a browser-playable preview: h264/mp4 plays
            # everywhere (the SOURCE may be AV1/HEVC and unplayable in the
            # client), and it's frame-exact 1:1 with the source, so the web
            # editor can scrub/seek it and trust frame identity.
            import shutil

            preview_path = job_output_dir(job_id) / "preview.mp4"
            shutil.copyfile(proxy, preview_path)
            proxy.unlink(missing_ok=True)

        jobs.update_job(
            job_id,
            status=jobs.COMPLETED,
            stage=None,
            progress=1.0,
            error=None,
            metadata={
                "probe": probe,
                "crop": crop,
                # frame-exact 1:1 h264 proxy for in-browser playback/scrub
                "preview": {
                    "url": public_url(preview_path),
                    "short_side": PROXY_SHORT_SIDE,
                },
                "scenes": scenes,          # [{start, end, start_sec, end_sec}]
                "scene_cuts": cuts,        # source-frame indices, /v1/videos-ready
                "thumbnails": {
                    "strip": strip,
                    "scenes": [
                        {"scene": i, **t} for i, t in enumerate(keyframes)
                    ],
                },
            },
        )
        jlog.info(f"🏁 analyze completed: {len(scenes)} scene(s), "
                  f"{len(strip)} strip + {len(keyframes)} scene thumb(s)")
        return {"job_id": job_id, "status": jobs.COMPLETED, "scenes": len(scenes)}

    except Exception as exc:
        logger.exception(f"❌ analyze job {job_id} failed")
        jobs.update_job(job_id, status=jobs.FAILED, error=str(exc))
        raise


@app.function(
    image=media_image,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    cpu=2,
    memory=(2 * 1024, 8 * 1024),
    timeout=1800,
    nonpreemptible=True,
)
def process_profile_job(job_id: str, request: dict) -> dict:
    """Standalone shot-profiling job (no paid conversion needed): run the
    adaptive ShotProfiler over the ANALYZE PROXY and return the depth script
    as metadata — the gateway folds it into project.scene_profile so the
    per-scene stereo editors have measured defaults before the first render.

    request: {"input_path": <frame-exact 1:1 proxy key>, "scene_cuts"?: [int],
    "profiler"?: "da3-metric"|"depth-pro", "depth_scale"?: float,
    "auto_comfort"?: bool, "comfort_budget"?: float}.

    The proxy is 1:1 with the source (analyze pipeline invariant), so work
    space == SOURCE space here: scene_cuts are used as boundaries directly
    and the script's first_src/last_src are identities. Profiling reads
    statistics (medians, near fractions) at input_size=518 — the 480p proxy
    is plenty for that, and being h264 it always decodes."""
    from app.common.debug import job_logger
    from app.common.storage import bucket_path
    from app.stages.media import probe_video
    from app.stages.video_depth_models import ShotProfiler

    jlog = job_logger(job_id)
    try:
        input_path = request["input_path"]
        src = bucket_path(input_path)
        if not src.exists():
            raise FileNotFoundError(f"input video not found: {input_path}")

        jobs.update_job(job_id, status=jobs.IN_PROGRESS, stage="profile_scenes", progress=0.05)
        probe = probe_video(str(src))
        num_frames = probe["num_frames"]

        cuts = [int(c) for c in (request.get("scene_cuts") or [])]
        if any(c <= 0 or c >= num_frames for c in cuts) or cuts != sorted(set(cuts)):
            raise ValueError(f"scene_cuts must be strictly increasing in (0, {num_frames})")
        starts = [0, *cuts]
        scene_ranges = [
            (s, e) for s, e in zip(starts, [*cuts, num_frames]) if e > s
        ]

        profiler = request.get("profiler", "da3-metric")
        depth_scale = float(request.get("depth_scale", 1.0))
        auto_comfort = bool(request.get("auto_comfort", True))
        comfort_budget = float(request.get("comfort_budget", 0.02))
        jlog.info(
            f"🎛  profile-only: {len(scene_ranges)} shot(s) with {profiler} "
            f"(depth_scale={depth_scale}, auto_comfort={auto_comfort})"
        )
        depth_script = ShotProfiler(model_name=profiler).profile_scenes.remote(
            job_id, str(src), scene_ranges, input_size=518,
            auto_comfort=auto_comfort, comfort_budget=comfort_budget,
            depth_scale=depth_scale,
        )
        from app.common.errors import check_worker_result

        check_worker_result(depth_script, "profile_scenes")
        # identity mapping: the proxy is 1:1 with the source (no trim, no
        # decimation), so work-space spans ARE source-space spans
        for shot in depth_script:
            shot["first_src"] = int(shot["first"])
            shot["last_src"] = int(shot["last"])

        jobs.update_job(
            job_id,
            status=jobs.COMPLETED,
            stage=None,
            progress=1.0,
            error=None,
            depth_script=depth_script,
            metadata={"probe": probe, "depth_script": depth_script},
        )
        jlog.info(f"🏁 profile completed: {len(depth_script)} shot(s)")
        return {"job_id": job_id, "status": jobs.COMPLETED, "shots": len(depth_script)}

    except Exception as exc:
        logger.exception(f"❌ profile job {job_id} failed")
        jobs.update_job(job_id, status=jobs.FAILED, error=str(exc))
        raise
