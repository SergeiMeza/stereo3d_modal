"""End-to-end video pipeline orchestrator.

Runs on a cheap CPU container and drives the GPU stages:

    preprocess (CPU)  →  video depth (GPU)  →  stereo+inpaint (GPU)
                                              →  encode outputs (CPU)

Stage workers write intermediates to the shared cache volume; only
final deliverables are published to the bucket. Every stage records
its wall time on the job, so completed jobs double as benchmark runs.
"""

import modal

from app.common import jobs, reuse
from app.common.debug import get_logger
from app.common.storage import PIPELINE_VOLUMES, slack_secret
from app.common.watchdog import STALL_TIMEOUT_S, gather_with_heartbeat
from app.images import media_image
from app.modal_app import app

logger = get_logger(__name__)

# Fan-out chunk ceilings (frames per worker). The point is BOUNDED work
# per container so a worker's wall time never grows with total video
# length — only the worker COUNT grows. Sized so the slowest backend
# stays well under its function timeout (see the stage modules):
#   ProPainter ~0.6 fps  → 1200f ≈ 33 min  (timeout 4h)
#   M2SVid     ~6 fps    → 1200f ≈ 3 min
#   VDA depth  ~11 fps   → 3000f ≈ 5 min   (timeout 2h)
#   per-frame depth ~2 fps (DA3/DepthPro) → 1500f ≈ 12 min
# A long video simply spawns more chunks (bounded by MAX_GPU_WORKERS,
# which the caller can raise toward the workspace's 10-GPU ceiling).
STEREO_CHUNK_FRAMES = 1200
DEPTH_CHUNK_FRAMES = 1500
# fan out once a video exceeds this (overridable per request via
# "parallel"); below it the per-container cold-start isn't worth it
PARALLEL_THRESHOLD = 1500

# Resolution/quality presets: bundle target output resolution with the
# matched depth resolution, inpainting working res, and (implicitly via
# routing) GPU tier. Explicit request fields override preset values.
PRESETS = {
    "draft":   {"target_height": 1080, "input_size": 518, "inpaint": "none"},
    "1080p":   {"target_height": 1080, "input_size": 980},
    "qhd":     {"target_height": 1440, "input_size": 1148},   # 2560x1440, all-L40S
    "3k":      {"target_height": 1620, "input_size": 1148},   # 2880x1620, all-L40S
    "4k":      {"target_height": 2160, "input_size": 1442,    # A100 depth + H200 stereo
                "inpaint_res": 1080},  # short-side; width aspect-derived (was 1080×1920, landscape-only)
}


@app.function(
    image=media_image,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    cpu=2,
    memory=(1024, 8 * 1024),
    # The coordinator blocks on the SUM of every stage (preprocess +
    # depth + stereo + encode), so its timeout must exceed the slowest
    # end-to-end run. With fan-out the stereo/depth stages are bounded
    # by chunk size, but a non-fanned-out path (≤1500f) or a per-frame
    # depth experiment on a long clip can be hours. 8h ceiling — a long
    # multi-minute job should never be dropped mid-flight. (Cheap: a
    # tiny idle CPU container.) CPU-only functions can opt out of
    # preemption (3x CPU/mem price on a tiny container).
    timeout=8 * 3600,
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
      "profiler": "da3-metric" | "depth-pro",
                     # adaptive only: profiling backend. depth-pro (R&D
                     # only, apple-amlr weights) classifies in TRUE
                     # meters and biases by the shot-mean FOV (v3)
      "depth_scale": 1.0,        # adaptive only [0.3, 1.5]: uniform
                     # displacement multiplier; explicit value overrides
                     # auto_comfort
      "auto_comfort": true,      # adaptive only (default true): auto-pick
                     # the scale that lands p95 salient disparity within
                     # comfort_budget; only tones down. Chosen scale ->
                     # metadata["comfort_scale"]
      "comfort_budget": 0.02     # adaptive only (0, 0.05]: target peak
                     # salient screen disparity for auto_comfort
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
    # v7 resolution knobs (client-facing aliases over the internal fields):
    #   depth_res   → input_size       (depth inference resolution)
    #   output_res  → target_short_side (output short side, orientation-agnostic)
    #   inpaint_res → ProPainter short side (consumed in _propainter_work_res)
    # Aliases only set the internal field when not already present, so a
    # preset or an explicit internal field still wins per the merge above.
    if request.get("depth_res") and "input_size" not in request:
        request["input_size"] = int(request["depth_res"])
    from app.stages.video_depth import VideoDepthWorker
    from app.stages.video_stereo import VideoStereoWorker

    jlog = job_logger(job_id)

    try:
        jlog.info(f"🎯 video job started: {request.get('input_path')} "
                  f"(inpaint={request.get('inpaint', 'propainter')}, "
                  f"input_size={request.get('input_size', 980)})")
        jobs.update_job(job_id, status=jobs.IN_PROGRESS, stage="preprocess", progress=0.05)

        # trim: from_frame/to_frame are canonical; from_sec/to_sec are a
        # convenience layer. The sec→frame conversion needs the source fps,
        # which preprocess_video has from its probe, so we pass the raw
        # spec through and resolve it there (keeps one probe, frame-exact).
        trim_spec = _trim_spec(request)
        # target_fps (v7): decimate in preprocess; the work file's probe then
        # carries the decimated fps + frame count, so every downstream stage
        # (depth/stereo/encode) and fps_rational adapt automatically.
        target_fps = request.get("target_fps")
        output_res = request.get("output_res")
        remove_bars = request.get("remove_black_bars", True)

        # ---- content-addressed PREPROCESS reuse (v7) -------------------
        # The work file is a pure function of these inputs; if an identical
        # run already published one, reuse it (no job id needed). The trim
        # is resolved inside preprocess (needs source fps), so for the key
        # we use the raw spec — identical raw spec ⇒ identical resolved trim
        # for the same source. skip_reuse_preprocess forces a recompute.
        pp_key = reuse.preprocess_key(
            request["input_path"], remove_bars, output_res,
            request.get("target_height"), target_fps, trim_spec,
        )
        pre = _reuse_or_preprocess(
            job_id, jlog, request, pp_key, trim_spec, target_fps, output_res,
            remove_bars,
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
        parallel = bool(request.get("parallel", pre["probe"]["num_frames"] > PARALLEL_THRESHOLD))
        depth_model = request.get("depth_model", "vda")
        # Heartbeat-watchdog threshold for the fan-out gathers: fail the
        # job fast if no worker emits progress for this many seconds (a
        # silent hang) instead of stalling until Modal's multi-hour
        # function timeout. Overridable per request.
        stall_timeout_s = int(request.get("stall_timeout_s", STALL_TIMEOUT_S))
        # fan-out tuning: max_gpu_workers caps concurrent containers;
        # stereo_chunk_frames/depth_chunk_frames shrink the per-chunk size
        # so more, shorter chunks run in parallel (faster wall-clock when
        # GPUs are plentiful). Defaults preserve prior behavior.
        max_gpu_workers = int(request.get("max_gpu_workers", 4))
        stereo_chunk_cap = int(request.get("stereo_chunk_frames", STEREO_CHUNK_FRAMES))
        depth_chunk_cap = int(request.get("depth_chunk_frames", DEPTH_CHUNK_FRAMES))

        # -------------------------------- adaptive per-shot depth script
        adaptive = bool(request.get("adaptive", False))
        # v7 draft mode: at very low fps (≤3, set via target_fps for rough
        # previews), scene detection has too few frames to be reliable and
        # the adaptive profiler samples 1-2 frames/shot — its per-shot
        # precision is wasted. Skip profiling and use a flat displacement
        # (cheaper, and the draft is for layout, not final grading).
        eff_fps = (pre.get("fps_decimation") or {}).get("fps") or probe["fps"]
        if adaptive and eff_fps <= 3.0:
            jlog.info(f"🎚  draft fps ({eff_fps:.1f}) → skipping adaptive profiler "
                      "(flat displacement)")
            adaptive = False
        depth_script: list[dict] | None = None
        if adaptive:
            # adaptive composes with the stereo fan-out: the depth script
            # keys on ABSOLUTE frame index and is passed whole to every
            # chunk worker, so each chunk looks up its own frames' params
            # (output is identical to sequential). Both stereo backends
            # thread scene_params through their parallel paths.
            from app.stages.media import detect_scenes
            from app.stages.video_depth_models import ShotProfiler

            jobs.update_job(job_id, stage="profile_scenes", progress=0.17)
            # content-addressed scene-cut reuse (v7): scenes depend ONLY on
            # the work file (preprocess_key), so cache the cut list INLINE in
            # the registry (it's tiny — no GCS file). skip_reuse_scenes forces
            # a re-detect.
            s_key = reuse.scenes_key(pre.get("_pp_key") or pp_key)
            scenes = None
            if not request.get("skip_reuse_scenes"):
                scenes = reuse.lookup_value(s_key)
                if scenes is not None:
                    jlog.info(f"♻️  scene-cut auto-reuse HIT ({s_key}): {len(scenes)} scene(s)")
            if scenes is None:
                scenes = detect_scenes.remote(pre["work_path"])["scenes"]
                try:
                    reuse.register_value(s_key, job_id, scenes)
                except Exception:
                    logger.warning("scenes register failed (non-fatal)", exc_info=True)
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
            # auto_comfort (default ON): let the profiler pick the scale
            # that lands the clip's salient disparities inside the comfort
            # budget. An explicit depth_scale overrides it (the worker
            # enforces this precedence).
            auto_comfort = bool(request.get("auto_comfort", True))
            comfort_budget = float(request.get("comfort_budget", 0.02))
            jlog.info(
                f"🎛  adaptive: profiling {len(scene_ranges)} shot(s) with "
                f"{profiler} (depth_scale={depth_scale}, "
                f"auto_comfort={auto_comfort}, comfort_budget={comfort_budget})"
            )
            # single worker: coverage relies on Modal's profiler function
            # timeout (~10min), not the heartbeat watchdog
            depth_script = ShotProfiler(model_name=profiler).profile_scenes.remote(
                job_id, pre["work_path"], scene_ranges, input_size=518,
                auto_comfort=auto_comfort, comfort_budget=comfort_budget,
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
        # depth reuse: experiments that vary only the stereo/inpaint
        # stage (e.g. propainter vs m2svid, displacement sweeps,
        # adaptive on/off) can skip the depth pass entirely by pointing
        # at a prior job's depth map on the shared cache volume. The
        # source/crop/resolution MUST match — we verify frame count and
        # depth dimensions against this run's preprocess before using it.
        # Explicit reuse_depth_from (job id) WINS; otherwise content-
        # addressed auto-reuse looks up the depth key (preprocess + model +
        # input_size + encoder) and reuses the matching published depth.
        reuse_from = request.get("reuse_depth_from")
        d_key = reuse.depth_key(
            pre.get("_pp_key") or pp_key, depth_model, input_size,
            request.get("encoder", "vitl"),
        )
        if not reuse_from and not request.get("skip_reuse_depth"):
            hit = reuse.lookup(d_key)
            if hit:
                from app.common.notify import notify_slack

                reuse_from = hit["job_id"]
                jlog.info(f"♻️  depth auto-reuse HIT ({d_key}) ← job {reuse_from}")
                notify_slack(
                    f"♻️ *depth reuse* job `{job_id}` reused depth from "
                    f"`{reuse_from}` (key `{d_key}`)"
                )
        if reuse_from:
            from app.stages.media import probe_depth_reuse

            depth = probe_depth_reuse.remote(job_id, reuse_from, pre["probe"]["num_frames"])
            check_worker_result(depth, "video_depth(reuse)")
            jlog.info(
                f"♻️  reusing depth from job {reuse_from}: "
                f"{depth['num_frames']}f at {depth['depth_shape']}"
            )
        elif depth_model == "vda":
            # VRAM scales with the WORKING pixel count: depth resizes the
            # SHORT side to input_size, so long side = input_size × (long/
            # short). Route on an "effective size" = input_size scaled by
            # the elongation past 16:9 — orientation-AGNOSTIC (uses long/
            # short, always ≥1, so a 9:16 portrait routes the same as a 16:9
            # landscape of equal elongation; the old aspect=w/h only handled
            # frames WIDER than 16:9 and under-routed portrait). L40S/A100
            # ceilings calibrated on 16:9.
            long_side = max(probe["width"], probe["height"])
            short_side = max(min(probe["width"], probe["height"]), 1)
            elongation = long_side / short_side  # ≥ 1, orientation-free
            eff_size = input_size * max(elongation / (16 / 9), 1.0) ** 0.5
            depth_gpu = "L40S" if eff_size <= 1148 else ("A100-80GB" if eff_size <= 1442 else "H200")
            worker_cls = (
                VideoDepthWorker if depth_gpu == "L40S"
                else VideoDepthWorker.with_options(gpu=depth_gpu)
            )
            jlog.info(
                f"🖥  depth GPU: {depth_gpu} (input_size={input_size}, "
                f"effective={eff_size:.0f} at {elongation:.2f}:1, parallel={parallel})"
            )
            encoder = request.get("encoder", "vitl")
            if parallel:
                # _parallel_depth applies .with_options(max_containers=) on
                # the CLASS then instantiates per chunk — so it takes the
                # class + ctor args, not a built instance (instances have
                # no .with_options).
                depth = _parallel_depth(
                    job_id, jlog, worker_cls, encoder, pre, input_size, fps_rational,
                    max_workers=max_gpu_workers,
                    stall_timeout_s=stall_timeout_s, chunk_cap=depth_chunk_cap,
                )
            else:
                # single worker: coverage relies on Modal's depth function
                # timeout (2-4h), not the heartbeat watchdog
                depth = worker_cls(encoder=encoder).generate.remote(
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
            # single worker: coverage relies on Modal's depth function
            # timeout (2-4h), not the heartbeat watchdog
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
            # the source aspect). work_height/work_width are DELIBERATELY
            # NOT forwarded from the request here (unlike stereo_kwargs for
            # ProPainter): they are a MODEL constraint, not a tunable —
            # off-tier resolutions degrade the diffusion fill. Do not add
            # them "for parity". See M2SVidStereoWorker.generate docstring.
            # Left eye stays the original frame.
            m2svid_kwargs = dict(
                stereo_mode=request.get("stereo_mode", "right"),
                video_path=pre["work_path"],
                depth_path=depth["depth_path"],
                displacement=float(request.get("displacement", 0.0125)),
                fps_rational=fps_rational,
                scene_params=depth_script,  # None unless adaptive
            )
            jlog.info(f"🖥  stereo GPU: {M2SVID_STEREO_GPU} (m2svid)")
            if parallel:
                stereo = _parallel_stereo_m2svid(
                    job_id, jlog, pre, m2svid_kwargs,
                    max_workers=max_gpu_workers,
                    stall_timeout_s=stall_timeout_s,
                )
            else:
                # single worker: coverage relies on Modal's stereo function
                # timeout, not the heartbeat watchdog
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
                fps_rational=fps_rational,
                scene_params=depth_script,  # None unless adaptive
            )
            # ProPainter work resolution — ORIENTATION-AGNOSTIC: derive
            # (height, width) from a SHORT-SIDE value + the source aspect,
            # so a portrait frame fills a portrait work rect (no 1280×720
            # distortion). Back-compat: explicit work_height/work_width still
            # honored; otherwise short-side default 720 → 1280×720 for 16:9,
            # 720×1280 for 9:16, etc. (inpaint_res knob in v7 sets the short
            # side.)
            wh, ww = _propainter_work_res(
                request, src_w=probe["width"], src_h=probe["height"])
            stereo_kwargs["work_height"] = wh
            stereo_kwargs["work_width"] = ww
            # ProPainter VRAM scales with work res × source res: above the
            # default ~720p working res (or 4K sources), L40S 48GB OOMs
            big_work = wh * ww > 1280 * 720
            # >720p ProPainter needs ~80+ GB (project A ran 1080p on H200)
            stereo_cls = (
                VideoStereoWorker.with_options(gpu="H200") if big_work else VideoStereoWorker
            )
            jlog.info(f"🖥  stereo GPU: {'H200' if big_work else 'L40S'}")
            if parallel:
                stereo = _parallel_stereo(
                    job_id, jlog, pre, stereo_kwargs, stereo_cls,
                    max_workers=max_gpu_workers,
                    stall_timeout_s=stall_timeout_s, chunk_cap=stereo_chunk_cap,
                )
            else:
                # single worker: coverage relies on Modal's stereo function
                # timeout, not the heartbeat watchdog
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

        # if the clip was trimmed, audio must be cut to the same window
        # (the work file is video-only; audio is muxed from the full
        # source_path). trim is in frames → seconds via the source fps.
        audio_trim = None
        if pre.get("trim"):
            # trim indices are in SOURCE frames; convert to seconds via the
            # SOURCE fps (pre.["probe"] may be decimated by target_fps). The
            # video duration is unchanged by decimation (fewer frames at a
            # lower rate = same seconds), so audio still aligns.
            src_fps = pre.get("source_fps") or probe["fps"]
            audio_trim = (pre["trim"][0] / src_fps, pre["trim"][1] / src_fps)

        formats = request.get("formats", ["sbs", "half_sbs", "anaglyph"])
        encoded = encode_outputs.remote(
            job_id,
            sbs_path=stereo["sbs_path"],
            original_path=pre["source_path"],  # pristine input carries the audio
            formats=[f for f in formats if f != "mvhevc"],
            include_audio=request.get("include_audio", True),
            audio_trim=audio_trim,
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
                audio_trim=audio_trim,
            )
            check_worker_result(mv, "encode_mvhevc")
            outputs["mvhevc"] = mv["mvhevc"]
        if request.get("output_depth", True):
            outputs["depth"] = publish_file.remote(job_id, depth["depth_path"], "depth.mp4")
            # register this depth for content-addressed auto-reuse (only
            # when freshly computed — reusing then re-registering the same
            # key is a harmless no-op, but skip it to keep the pointer at the
            # original producer). depth published at outputs/<job>/depth.mp4.
            if not reuse_from:
                try:
                    reuse.register(d_key, job_id, f"outputs/{job_id}/depth.mp4",
                                   meta={"depth_shape": depth.get("depth_shape")})
                    jlog.info(f"📌 registered depth for reuse ({d_key})")
                except Exception:
                    logger.warning("depth register failed (non-fatal)", exc_info=True)

        jobs.update_job(
            job_id,
            status=jobs.COMPLETED,
            stage=None,
            progress=1.0,
            outputs=outputs,
            metadata={
                "probe": pre["probe"],
                "crop": pre["crop"],
                "fps_decimation": pre.get("fps_decimation"),  # v7: None if not decimated
                "scene_cuts": depth["scene_cuts"],
                "depth_shape": depth["depth_shape"],
                "av_sync_ms": encoded.get("av_sync_ms"),
                **({"depth_script": depth_script} if depth_script is not None else {}),
                # auto_comfort: the effective per-job displacement scale the
                # profiler chose (worker stored it top-level on the job;
                # surface it in metadata too). None when not adaptive.
                **(
                    {"comfort_scale": (jobs.get_job(job_id) or {}).get("comfort_scale")}
                    if adaptive else {}
                ),
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


def _reuse_or_preprocess(job_id, jlog, request, pp_key, trim_spec, target_fps,
                         output_res, remove_bars):
    """Auto-reuse a published preprocess work file if one matches pp_key,
    else run preprocess and publish+register the result.

    A reused work file already encodes crop/scale/fps/trim, but the
    pipeline still needs source-derived fields (source_path for the audio
    mux, source_fps for audio_trim, the resolved trim window, the
    fps_decimation record). We reconstruct them from a cheap probe of the
    ORIGINAL source (always on GCS) so the reuse path returns the same dict
    shape as a fresh preprocess.

    skip_reuse_preprocess forces a recompute (and still publishes, so the
    fresh result is registered for the next run)."""
    from app.stages.media import (fetch_preprocess_reuse, preprocess_video,
                                   publish_file)
    from app.common.storage import bucket_path

    skip = bool(request.get("skip_reuse_preprocess"))
    entry = None if skip else reuse.lookup(pp_key)
    if entry:
        from app.common.notify import notify_slack

        jlog.info(f"♻️  preprocess auto-reuse HIT ({pp_key}) ← job {entry['job_id']}")
        notify_slack(
            f"♻️ *preprocess reuse* job `{job_id}` reused work file from "
            f"`{entry['job_id']}` (key `{pp_key}`)"
        )
        pre = fetch_preprocess_reuse.remote(job_id, entry["gcs_relpath"])
        # reconstruct source-derived fields the downstream stages need from
        # the registry meta (recorded when the work file was published)
        meta = entry.get("meta") or {}
        src_fps = meta.get("source_fps")
        trim = meta.get("trim")
        return {
            **pre,
            "source_path": str(bucket_path(request["input_path"])),
            "crop": meta.get("crop"),
            "trim": tuple(trim) if trim else None,
            "fps_decimation": meta.get("fps_decimation"),
            "source_fps": src_fps,
            "_pp_key": pp_key,
        }

    if skip:
        jlog.info(f"⏭  preprocess reuse skipped (skip_reuse_preprocess); recomputing")
    pre = preprocess_video.remote(
        job_id, request["input_path"], remove_black_bars=remove_bars,
        target_height=request.get("target_height"), trim_spec=trim_spec,
        target_fps=float(target_fps) if target_fps is not None else None,
        target_short_side=int(output_res) if output_res is not None else None,
    )
    # publish the work file + register so the NEXT identical run reuses it
    try:
        url = publish_file.remote(job_id, pre["work_path"], "preprocess.mp4")
        relpath = f"outputs/{job_id}/preprocess.mp4"
        reuse.register(pp_key, job_id, relpath, meta={
            "source_fps": pre.get("source_fps"),
            "trim": list(pre["trim"]) if pre.get("trim") else None,
            "crop": pre.get("crop"),
            "fps_decimation": pre.get("fps_decimation"),
        })
        jlog.info(f"📌 registered preprocess for reuse ({pp_key}) → {relpath}")
    except Exception:
        logger.warning("preprocess publish/register failed (non-fatal)", exc_info=True)
    pre["_pp_key"] = pp_key
    return pre


def _propainter_work_res(request: dict, src_w: int, src_h: int) -> tuple[int, int]:
    """ProPainter (height, width) working resolution, ORIENTATION-AGNOSTIC.

    Precedence:
    1. explicit work_height AND work_width in the request → used verbatim
       (back-compat / expert override).
    2. otherwise a SHORT-SIDE value (``inpaint_res``, else ``work_height``,
       default 720): the short side = that value, the long side derived
       from the source aspect, both rounded to even (encoder-friendly). So
       a 16:9 source → 1280×720, a 9:16 portrait → 720×1280, 1:1 → 720×720
       — never the fixed 1280×720 rectangle that distorts non-landscape.
    """
    if request.get("work_height") and request.get("work_width"):
        return int(request["work_height"]), int(request["work_width"])
    short = int(request.get("inpaint_res") or request.get("work_height") or 720)
    src_long = max(src_w, src_h)
    src_short = max(min(src_w, src_h), 1)
    long_side = int(round(short * src_long / src_short / 2)) * 2  # even
    short = (short // 2) * 2
    if src_h >= src_w:  # portrait or square: height is the long side
        return long_side, short
    return short, long_side  # landscape: width is the long side


def _trim_spec(request: dict) -> dict | None:
    """Pull trim fields out of the request into a spec dict (or None).
    Accepts from_frame/to_frame (canonical) or from_sec/to_sec
    (convenience). preprocess_video resolves these to exact frames using
    the source fps."""
    keys = ("from_frame", "to_frame", "from_sec", "to_sec")
    spec = {k: request[k] for k in keys if k in request and request[k] is not None}
    return spec or None


def _align_up(n: int, multiple: int) -> int:
    """Round n up to the nearest multiple of ``multiple`` (segment len),
    so chunk boundaries land on segment boundaries and fan-out output is
    byte-identical to sequential."""
    return max(multiple, -(-n // multiple) * multiple)

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


def _parallel_depth(job_id, jlog, worker_cls, encoder, pre, input_size, fps_rational,
                    max_workers, stall_timeout_s=STALL_TIMEOUT_S, chunk_cap=DEPTH_CHUNK_FRAMES):
    from app.common.errors import check_worker_result
    from app.stages.media import concat_cache_segments, detect_scenes

    scenes = detect_scenes.remote(pre["work_path"])["scenes"]
    boundaries = [(s["start"], s["end"]) for s in scenes] or [(0, pre["probe"]["num_frames"])]
    total = pre["probe"]["num_frames"]
    # capped chunk size: bounded worker wall time, more chunks for long
    # videos (same principle as the stereo fan-out). A smaller chunk_cap
    # with many GPUs ⇒ more, shorter chunks ⇒ lower wall-clock.
    chunks = _chunk_ranges(
        boundaries, total,
        target=min(chunk_cap, max(600, -(-total // max_workers))),
    )
    jlog.info(
        f"🧩 depth fan-out: {len(boundaries)} scene(s) → {len(chunks)} chunk(s) "
        f"(≤{max_workers} concurrent)"
    )

    # spawn (not starmap) so each chunk yields a FunctionCall handle the
    # heartbeat watchdog can poll/cancel. generate_scenes heartbeats per
    # batch (every ~5s via report_progress chunk=ranges[0][0]), so a
    # multi-minute gap = a silent hang. Same watchdog protection as the
    # stereo fan-out.
    capped = worker_cls.with_options(max_containers=max_workers)

    def _spawn(i):
        return capped(encoder=encoder).generate_scenes.spawn(
            job_id, pre["work_path"], chunks[i], input_size, fps_rational
        )

    handles = [_spawn(i) for i in range(len(chunks))]
    # per-chunk heartbeat key = the chunk's first frame (generate_scenes
    # passes chunk=ranges[0][0] to report_progress). A hung depth chunk is
    # resubmitted on a fresh container instead of failing the whole job.
    chunk_keys = [c[0][0] for c in chunks]
    jobs.register_child_calls(job_id, [h.object_id for h in handles])
    results = gather_with_heartbeat(
        job_id, handles, jlog, stall_timeout_s=stall_timeout_s,
        label="video_depth", chunk_keys=chunk_keys, respawn_fn=_spawn,
        register_handles_fn=lambda hs: jobs.register_child_calls(
            job_id, [h.object_id for h in hs]),
    )
    jobs.clear_child_calls(job_id)
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


def _parallel_stereo(job_id, jlog, pre, stereo_kwargs, stereo_cls, max_workers,
                     stall_timeout_s=STALL_TIMEOUT_S, chunk_cap=STEREO_CHUNK_FRAMES):
    from app.common.errors import check_worker_result
    from app.common.storage import job_cache_dir
    from app.stages.media import concat_cache_segments
    from app.stages.video_stereo import SEGMENT_FRAMES, _pick_batch_size

    total = pre["probe"]["num_frames"]
    batch_size = _pick_batch_size(total)
    seg_len = batch_size * max(1, round(SEGMENT_FRAMES / batch_size))
    # chunk size is CAPPED (chunk_cap, default STEREO_CHUNK_FRAMES) so a
    # worker's wall time never grows with total length — long videos spawn
    # MORE chunks, not bigger ones. A SMALLER cap (e.g. when many GPUs are
    # available) makes more, shorter chunks → lower wall-clock per chunk.
    chunk_len = _align_up(
        min(chunk_cap, -(-total // max_workers)), seg_len
    )
    ranges = [(s, min(s + chunk_len, total)) for s in range(0, total, chunk_len)]
    jlog.info(
        f"🧩 stereo fan-out: {total}f → {len(ranges)} chunk(s) of ≤{chunk_len}f "
        f"(≤{max_workers} concurrent)"
    )

    # cap concurrent containers so chunk count > max_workers queues
    # instead of all firing at once (workspace has a 10-GPU ceiling)
    cls = stereo_cls.with_options(max_containers=max_workers)

    def _spawn(i):
        return cls().generate.spawn(
            job_id, frame_range=ranges[i], batch_size=batch_size, concat=False,
            band=(0.5, 0.85), **stereo_kwargs,
        )

    handles = [_spawn(i) for i in range(len(ranges))]
    # per-chunk heartbeat key = the chunk's start frame (workers pass
    # chunk=range_start to report_progress); respawn_fn re-rolls a hung
    # chunk on a fresh container instead of failing the whole job.
    chunk_keys = [r[0] for r in ranges]
    jobs.register_child_calls(job_id, [h.object_id for h in handles])
    results = gather_with_heartbeat(
        job_id, handles, jlog, stall_timeout_s=stall_timeout_s,
        label="video_stereo", chunk_keys=chunk_keys, respawn_fn=_spawn,
        register_handles_fn=lambda hs: jobs.register_child_calls(
            job_id, [h.object_id for h in hs]),
    )
    jobs.clear_child_calls(job_id)
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


def _parallel_stereo_m2svid(job_id, jlog, pre, m2svid_kwargs, max_workers,
                            stall_timeout_s=STALL_TIMEOUT_S):
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
    # capped chunk size (see _parallel_stereo): bounded worker wall time,
    # long videos spawn more chunks. Aligned to the 25-frame window.
    chunk_len = _align_up(
        min(STEREO_CHUNK_FRAMES, -(-total // max_workers)), seg_len
    )
    ranges = [(s, min(s + chunk_len, total)) for s in range(0, total, chunk_len)]
    jlog.info(
        f"🧩 stereo[m2svid] fan-out: {total}f → {len(ranges)} chunk(s) of "
        f"≤{chunk_len}f (≤{max_workers} concurrent)"
    )

    cls = M2SVidStereoWorker.with_options(max_containers=max_workers)

    def _spawn(i):
        return cls().generate.spawn(
            job_id, frame_range=ranges[i], batch_size=batch_size, concat=False,
            band=(0.5, 0.85), **m2svid_kwargs,
        )

    handles = [_spawn(i) for i in range(len(ranges))]
    chunk_keys = [r[0] for r in ranges]
    jobs.register_child_calls(job_id, [h.object_id for h in handles])
    results = gather_with_heartbeat(
        job_id, handles, jlog,
        stall_timeout_s=stall_timeout_s, label="video_stereo[m2svid]",
        chunk_keys=chunk_keys, respawn_fn=_spawn,
        register_handles_fn=lambda hs: jobs.register_child_calls(
            job_id, [h.object_id for h in hs]),
    )
    jobs.clear_child_calls(job_id)
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
