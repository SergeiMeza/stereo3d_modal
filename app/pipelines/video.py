"""End-to-end video pipeline orchestrator.

Runs on a cheap CPU container and drives the GPU stages:

    preprocess (CPU)  →  video depth (GPU)  →  stereo+inpaint (GPU)
                                              →  encode outputs (CPU)

Stage workers write intermediates to the shared cache volume; only
final deliverables are published to the bucket. Every stage records
its wall time on the job, so completed jobs double as benchmark runs.
"""

import modal

from app.common import jobs
from app.common.debug import get_logger
from app.common.storage import PIPELINE_VOLUMES, slack_secret
from app.images import media_image
from app.modal_app import app

logger = get_logger(__name__)

# Resolution/quality presets: bundle target output resolution with the
# matched depth resolution, inpainting working res, and (implicitly via
# routing) GPU tier. Explicit request fields override preset values.
PRESETS = {
    "draft":   {"target_height": 1080, "input_size": 518, "inpaint": "none"},
    "1080p":   {"target_height": 1080, "input_size": 980},
    "qhd":     {"target_height": 1440, "input_size": 1148},   # 2560x1440, all-L40S
    "3k":      {"target_height": 1620, "input_size": 1148},   # 2880x1620, all-L40S
    "4k":      {"target_height": 2160, "input_size": 1442,    # A100 depth + H200 stereo
                "work_height": 1080, "work_width": 1920},
}


@app.function(
    image=media_image,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    cpu=2,
    memory=(1024, 8 * 1024),
    timeout=2 * 3600,
    # the coordinator must outlive every GPU stage; CPU-only functions
    # can opt out of preemption (3x CPU/mem price on a tiny container)
    nonpreemptible=True,
)
def process_video_job(job_id: str, request: dict) -> dict:
    """request (all optional except input_path):
    {
      "input_path": "inputs/samples/clip_1s_1080p.mp4",
      "displacement": 0.0125,
      "inpaint": "propainter" | "none" | "m2svid",
      "input_size": 980,            # depth model resolution
      "depth_model": "vda" | "da2-metric-indoor" | "da2-metric-outdoor"
                     | "da3" | "da3-metric" | "depth-pro",
                     # depth-pro (R&D only, apple-amlr weights) also
                     # reports per-scene mean "fov_deg" in metadata
      "encoder": "vitl" | "vits",   # vda only
      "remove_black_bars": true,
      "formats": ["sbs", "half_sbs", "anaglyph", "tb", "half_tb"],
      "include_audio": true,
      "output_depth": true,
      "adaptive": false,         # per-shot depth script (R&D prototype)
      "profiler": "da3-metric" | "depth-pro"
                     # adaptive only: profiling backend. depth-pro (R&D
                     # only, apple-amlr weights) classifies in TRUE
                     # meters and biases by the shot-mean FOV (v3)
    }

    adaptive: detect scenes, profile 3 keyframes per shot with the
    ``profiler`` model (default da3-metric), and drive per-shot
    displacement/placement through the stereo stage (decisions stored
    in metadata["depth_script"]). The MAIN depth pass still uses
    whatever ``depth_model`` says (default vda). Prototype limits:
    sequential stereo only — combining with explicit ``parallel`` or
    ``inpaint="m2svid"`` raises (follow-ups).
    """
    from app.common.debug import job_logger
    from app.common.errors import check_worker_result
    from app.stages.media import encode_outputs, preprocess_video, publish_file

    preset = PRESETS.get(request.get("preset", ""))
    if preset:
        request = {**preset, **request}  # explicit fields win over the preset
    from app.stages.video_depth import VideoDepthWorker
    from app.stages.video_stereo import VideoStereoWorker

    jlog = job_logger(job_id)

    try:
        jlog.info(f"🎯 video job started: {request.get('input_path')} "
                  f"(inpaint={request.get('inpaint', 'propainter')}, "
                  f"input_size={request.get('input_size', 980)})")
        jobs.update_job(job_id, status=jobs.IN_PROGRESS, stage="preprocess", progress=0.05)

        pre = preprocess_video.remote(
            job_id,
            request["input_path"],
            remove_black_bars=request.get("remove_black_bars", True),
            target_height=request.get("target_height"),
        )
        probe = pre["probe"]
        jlog.info(f"📋 preprocess done: {probe['width']}x{probe['height']} "
                  f"{probe['num_frames']}f @ {probe['fps_rational']}, crop={pre['crop']}")
        jobs.update_job(job_id, progress=0.15, stage="video_depth")

        fps_rational = pre["probe"].get("fps_rational")
        # route depth to a GPU with enough VRAM for the model resolution
        input_size = int(request.get("input_size", 980))
        # long videos fan out scene-aligned chunks across parallel GPU
        # workers (identical output: depth alignment resets at cuts and
        # stereo segments align to batch boundaries)
        parallel = bool(request.get("parallel", pre["probe"]["num_frames"] > 1500))
        depth_model = request.get("depth_model", "vda")

        # -------------------------------- adaptive per-shot depth script
        adaptive = bool(request.get("adaptive", False))
        depth_script: list[dict] | None = None
        if adaptive:
            # prototype limits (follow-ups): the parallel stereo fan-out
            # and the M2SVid worker don't take scene_params yet — fail
            # loudly rather than silently dropping the depth script
            if request.get("inpaint", "propainter") == "m2svid":
                raise RuntimeError("adaptive=true is not supported with inpaint='m2svid' yet")
            if request.get("parallel"):
                raise RuntimeError("adaptive=true is not supported with parallel=true yet")
            if parallel:  # implicit long-video fan-out: fall back, don't fail
                jlog.info("🎛  adaptive: forcing sequential path (fan-out unsupported)")
                parallel = False

            from app.stages.media import detect_scenes
            from app.stages.video_depth_models import FrameDepthWorker

            jobs.update_job(job_id, stage="profile_scenes", progress=0.17)
            scenes = detect_scenes.remote(pre["work_path"])["scenes"]
            scene_ranges = (
                [(s["start"], s["end"]) for s in scenes]
                or [(0, pre["probe"]["num_frames"])]
            )
            # v3: the profiling backend is selectable ("profiler":
            # "da3-metric" default | "depth-pro" true-meters + FOV
            # modifier), independent of the depth_model used for the
            # MAIN depth pass below
            profiler = request.get("profiler", "da3-metric")
            # uniform multiplier on every shot's displacement — tone the
            # whole effect down/up without touching the script structure
            depth_scale = float(request.get("depth_scale", 1.0))
            jlog.info(
                f"🎛  adaptive: profiling {len(scene_ranges)} shot(s) with "
                f"{profiler} (depth_scale={depth_scale})"
            )
            depth_script = FrameDepthWorker(model_name=profiler).profile_scenes.remote(
                job_id, pre["work_path"], scene_ranges, input_size=518,
                depth_scale=depth_scale,
            )
            check_worker_result(depth_script, "profile_scenes")
            # persist the per-shot decisions immediately so they are
            # inspectable while the job is still running (and survive a
            # later-stage failure); also folded into final metadata below
            jobs.update_job(job_id, depth_script=depth_script)
            for shot in depth_script:
                jlog.info(
                    f"🎛  shot [{shot['first']}, {shot['last']}): {shot['shot_type']} "
                    f"disp={shot['displacement']} placement={shot['placement']} "
                    f"(median={shot['median']}, near_fraction={shot['near_fraction']})"
                )
        if depth_model == "vda":
            # VRAM scales with pixel count ∝ input_size² × aspect; the
            # L40S/A100 ceilings below were calibrated on 16:9 sources.
            # Wider frames (e.g. 2.31:1 after letterbox crop) OOM at the
            # same input_size, so route on an aspect-corrected size.
            aspect = probe["width"] / max(probe["height"], 1)
            eff_size = input_size * max(aspect / (16 / 9), 1.0) ** 0.5
            depth_gpu = "L40S" if eff_size <= 1148 else ("A100-80GB" if eff_size <= 1442 else "H200")
            worker_cls = (
                VideoDepthWorker if depth_gpu == "L40S"
                else VideoDepthWorker.with_options(gpu=depth_gpu)
            )
            jlog.info(
                f"🖥  depth GPU: {depth_gpu} (input_size={input_size}, "
                f"effective={eff_size:.0f} at {aspect:.2f}:1, parallel={parallel})"
            )
            worker = worker_cls(encoder=request.get("encoder", "vitl"))
            if parallel:
                depth = _parallel_depth(
                    job_id, jlog, worker, pre, input_size, fps_rational,
                    max_workers=int(request.get("max_gpu_workers", 4)),
                )
            else:
                depth = worker.generate.remote(
                    job_id,
                    pre["work_path"],
                    input_size=input_size,
                    fps_rational=fps_rational,
                    band=(0.15, 0.5),
                )
        else:
            # per-frame backends (DA2-metric / DA3 / Depth Pro): single L40S worker
            # regardless of length — per-frame inference is much lighter
            # than VDA's 32-frame windows, and metric mode needs one
            # job-wide normalization pass, which a fan-out would break
            from app.stages.video_depth_models import FrameDepthWorker

            jlog.info(f"🖥  depth GPU: L40S (depth_model={depth_model}, input_size={input_size})")
            depth = FrameDepthWorker(model_name=depth_model).generate.remote(
                job_id,
                pre["work_path"],
                input_size=input_size,
                fps_rational=fps_rational,
                band=(0.15, 0.5),
            )
        check_worker_result(depth, "video_depth")
        # frame-count invariant: any silent drop would desync audio
        if depth["num_frames"] != pre["probe"]["num_frames"]:
            raise RuntimeError(
                f"depth produced {depth['num_frames']} frames for a "
                f"{pre['probe']['num_frames']}-frame source"
            )
        jlog.info(f"📋 depth done: {depth['num_frames']}f at {depth['depth_shape']}, "
                  f"{len(depth['scene_cuts'])} scene cut(s)")
        jobs.update_job(job_id, progress=0.5, stage="video_stereo")

        inpaint = request.get("inpaint", "propainter")
        if inpaint == "m2svid":
            from app.stages.video_stereo_m2svid import M2SVID_STEREO_GPU, M2SVidStereoWorker

            # M2SVid always runs at its trained ~512-tier model
            # resolution (the worker derives a 64-multiple width from
            # the source aspect); the ProPainter work_height/work_width
            # knobs do not apply. Left eye stays the original frame.
            m2svid_kwargs = dict(
                stereo_mode=request.get("stereo_mode", "right"),
                video_path=pre["work_path"],
                depth_path=depth["depth_path"],
                displacement=float(request.get("displacement", 0.0125)),
                fps_rational=fps_rational,
            )
            jlog.info(f"🖥  stereo GPU: {M2SVID_STEREO_GPU} (m2svid)")
            if parallel:
                stereo = _parallel_stereo_m2svid(
                    job_id, jlog, pre, m2svid_kwargs,
                    max_workers=int(request.get("max_gpu_workers", 4)),
                )
            else:
                stereo = M2SVidStereoWorker().generate.remote(
                    job_id, band=(0.5, 0.85), **m2svid_kwargs
                )
        else:
            stereo_kwargs = dict(
                video_path=pre["work_path"],
                depth_path=depth["depth_path"],
                displacement=float(request.get("displacement", 0.0125)),
                inpaint=inpaint,
                stereo_mode=request.get("stereo_mode", "both"),
                work_height=int(request.get("work_height", 720)),
                work_width=int(request.get("work_width", 1280)),
                fps_rational=fps_rational,
                scene_params=depth_script,  # None unless adaptive
            )
            # ProPainter VRAM scales with work res × source res: above the
            # default 720p working res (or 4K sources), L40S 48GB OOMs
            big_work = stereo_kwargs["work_height"] * stereo_kwargs["work_width"] > 1280 * 720
            # >720p ProPainter needs ~80+ GB (project A ran 1080p on H200)
            stereo_cls = (
                VideoStereoWorker.with_options(gpu="H200") if big_work else VideoStereoWorker
            )
            jlog.info(f"🖥  stereo GPU: {'H200' if big_work else 'L40S'}")
            if parallel:
                stereo = _parallel_stereo(
                    job_id, jlog, pre, stereo_kwargs, stereo_cls,
                    max_workers=int(request.get("max_gpu_workers", 4)),
                )
            else:
                stereo = stereo_cls().generate.remote(
                    job_id, band=(0.5, 0.85), **stereo_kwargs
                )
        check_worker_result(stereo, "video_stereo")
        if stereo["num_frames"] != pre["probe"]["num_frames"]:
            raise RuntimeError(
                f"stereo produced {stereo['num_frames']} frames for a "
                f"{pre['probe']['num_frames']}-frame source"
            )
        jlog.info(f"📋 stereo done: {stereo['sbs_path']} ({stereo['width']}x{stereo['height']})")
        jobs.update_job(job_id, progress=0.85, stage="encode_outputs")

        formats = request.get("formats", ["sbs", "half_sbs", "anaglyph"])
        encoded = encode_outputs.remote(
            job_id,
            sbs_path=stereo["sbs_path"],
            original_path=pre["source_path"],  # pristine input carries the audio
            formats=[f for f in formats if f != "mvhevc"],
            include_audio=request.get("include_audio", True),
        )

        outputs = dict(encoded["outputs"])
        if "mvhevc" in formats:
            from app.stages.mvhevc import encode_mvhevc, encode_mvhevc_x265

            jobs.update_job(job_id, stage="encode_mvhevc", progress=0.92)
            # x265 = Apple spatial badge (default); nvenc = fast, for custom players
            encoder_fn = (
                encode_mvhevc if request.get("mvhevc_encoder") == "nvenc" else encode_mvhevc_x265
            )
            mv = encoder_fn.remote(
                job_id,
                sbs_path=stereo["sbs_path"],
                original_path=pre["source_path"] if request.get("include_audio", True) else None,
                spatial=request.get("spatial"),
            )
            check_worker_result(mv, "encode_mvhevc")
            outputs["mvhevc"] = mv["mvhevc"]
        if request.get("output_depth", True):
            outputs["depth"] = publish_file.remote(job_id, depth["depth_path"], "depth.mp4")

        jobs.update_job(
            job_id,
            status=jobs.COMPLETED,
            stage=None,
            progress=1.0,
            outputs=outputs,
            metadata={
                "probe": pre["probe"],
                "crop": pre["crop"],
                "scene_cuts": depth["scene_cuts"],
                "depth_shape": depth["depth_shape"],
                "av_sync_ms": encoded.get("av_sync_ms"),
                **({"depth_script": depth_script} if depth_script is not None else {}),
                # additive: per-scene mean horizontal FOV (depth-pro
                # only) for shot-type classification
                **({"fov_deg": depth["fov_deg"]} if "fov_deg" in depth else {}),
            },
        )
        jlog.info(f"🏁 job completed: {len(outputs)} output(s) published")
        return {"job_id": job_id, "status": jobs.COMPLETED, "outputs": outputs}

    except Exception as exc:
        logger.exception(f"❌ video job {job_id} failed")
        jobs.update_job(job_id, status=jobs.FAILED, error=str(exc))
        raise


# ---------------------------------------------------- long-video fan-out

def _chunk_ranges(boundaries: list, total: int, target: int) -> list:
    """Group scene ranges into chunks of ~target frames."""
    chunks, cur, size = [], [], 0
    for first, last in boundaries:
        cur.append((first, last))
        size += last - first
        if size >= target:
            chunks.append(cur)
            cur, size = [], 0
    if cur:
        chunks.append(cur)
    return chunks


def _parallel_depth(job_id, jlog, worker, pre, input_size, fps_rational, max_workers):
    from app.common.errors import check_worker_result
    from app.stages.media import concat_cache_segments, detect_scenes

    scenes = detect_scenes.remote(pre["work_path"])["scenes"]
    boundaries = [(s["start"], s["end"]) for s in scenes] or [(0, pre["probe"]["num_frames"])]
    total = pre["probe"]["num_frames"]
    chunks = _chunk_ranges(boundaries, total, target=max(600, total // max_workers + 1))
    jlog.info(f"🧩 depth fan-out: {len(boundaries)} scene(s) → {len(chunks)} chunk(s)")

    results = list(worker.generate_scenes.starmap(
        [(job_id, pre["work_path"], chunk, input_size, fps_rational) for chunk in chunks]
    ))
    segments, num_frames = [], 0
    for r in results:
        check_worker_result(r, "video_depth[chunk]")
        segments += r["segments"]
        num_frames += r["num_frames"]

    from app.common.storage import job_cache_dir

    depth_path = str(job_cache_dir(job_id) / "depth.mp4")
    concat_cache_segments.remote(job_id, sorted(segments), depth_path, num_frames)
    return {
        "depth_path": depth_path,
        "num_frames": num_frames,
        "depth_shape": results[0]["depth_shape"],
        "scene_cuts": [b for _, b in boundaries[:-1]],
    }


def _parallel_stereo(job_id, jlog, pre, stereo_kwargs, stereo_cls, max_workers):
    from app.common.errors import check_worker_result
    from app.common.storage import job_cache_dir
    from app.stages.media import concat_cache_segments
    from app.stages.video_stereo import SEGMENT_FRAMES, _pick_batch_size

    total = pre["probe"]["num_frames"]
    batch_size = _pick_batch_size(total)
    seg_len = batch_size * max(1, round(SEGMENT_FRAMES / batch_size))
    # chunk = several segments, aligned so results are identical
    chunk_len = seg_len * max(1, (total // max_workers) // seg_len + 1)
    ranges = [(s, min(s + chunk_len, total)) for s in range(0, total, chunk_len)]
    jlog.info(f"🧩 stereo fan-out: {total}f → {len(ranges)} chunk(s) of ≤{chunk_len}f")

    # spawn all chunks, then gather — parallel across ≤max_workers containers
    handles = [
        stereo_cls().generate.spawn(
            job_id, frame_range=r, batch_size=batch_size, concat=False,
            band=(0.5, 0.85), **stereo_kwargs,
        )
        for r in ranges
    ]
    results = [h.get() for h in handles]
    segments, num_frames = [], 0
    for r in results:
        check_worker_result(r, "video_stereo[chunk]")
        segments += r["segments"]
        num_frames += r["num_frames"]

    inpaint = stereo_kwargs["inpaint"]
    sbs_path = str(job_cache_dir(job_id) / f"sbs_{inpaint}.mp4")
    concat_cache_segments.remote(job_id, sorted(segments), sbs_path, num_frames)
    first = results[0]
    return {
        "sbs_path": sbs_path,
        "num_frames": num_frames,
        "fps": first["fps"],
        "width": first["width"],
        "height": first["height"],
        "inpaint": inpaint,
    }


def _parallel_stereo_m2svid(job_id, jlog, pre, m2svid_kwargs, max_workers):
    """Same fan-out as _parallel_stereo, but chunks align to the fixed
    25-frame M2SVid model window (its segmentation invariant) instead
    of ProPainter's adaptive batch size. Windows are independent and
    deterministic, so chunking never changes results."""
    from app.common.errors import check_worker_result
    from app.common.storage import job_cache_dir
    from app.stages.media import concat_cache_segments
    from app.stages.video_stereo_m2svid import M2SVID_CHUNK, SEGMENT_FRAMES, M2SVidStereoWorker

    total = pre["probe"]["num_frames"]
    batch_size = M2SVID_CHUNK
    seg_len = batch_size * max(1, round(SEGMENT_FRAMES / batch_size))
    # chunk = several segments, aligned so results are identical
    chunk_len = seg_len * max(1, (total // max_workers) // seg_len + 1)
    ranges = [(s, min(s + chunk_len, total)) for s in range(0, total, chunk_len)]
    jlog.info(f"🧩 stereo[m2svid] fan-out: {total}f → {len(ranges)} chunk(s) of ≤{chunk_len}f")

    # spawn all chunks, then gather — parallel across ≤max_workers containers
    handles = [
        M2SVidStereoWorker().generate.spawn(
            job_id, frame_range=r, batch_size=batch_size, concat=False,
            band=(0.5, 0.85), **m2svid_kwargs,
        )
        for r in ranges
    ]
    results = [h.get() for h in handles]
    segments, num_frames = [], 0
    for r in results:
        check_worker_result(r, "video_stereo[chunk]")
        segments += r["segments"]
        num_frames += r["num_frames"]

    sbs_path = str(job_cache_dir(job_id) / "sbs_m2svid.mp4")
    concat_cache_segments.remote(job_id, sorted(segments), sbs_path, num_frames)
    first = results[0]
    return {
        "sbs_path": sbs_path,
        "num_frames": num_frames,
        "fps": first["fps"],
        "width": first["width"],
        "height": first["height"],
        "inpaint": "m2svid",
    }
