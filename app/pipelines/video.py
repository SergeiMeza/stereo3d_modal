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


def normalize_video_request(request: dict) -> dict:
    """Resolve the preset merge + client-facing aliases into the EFFECTIVE
    request (a new dict; the input is never mutated).

    v7 resolution knobs (client-facing aliases over the internal fields):
      depth_res   → input_size        (depth inference resolution)
      output_res  → target_short_side (output short side, orientation-agnostic)
      inpaint_res → ProPainter short side (consumed in _propainter_work_res)

    Precedence: explicit request fields beat the preset. The depth_res
    alias is applied BEFORE the preset merge — every preset defines
    input_size, so an after-merge alias could never fire and an explicit
    depth_res was silently discarded (billed at the preset's resolution).
    An explicit input_size still beats depth_res (the alias only fills the
    internal field when absent).

    Shared by process_video_job and the reuse-key derivation
    (reuse_request_keys), so cache keys are computed from the same
    effective params the pipeline runs with — by construction."""
    if request.get("depth_res") and "input_size" not in request:
        request = {**request, "input_size": int(request["depth_res"])}
    preset = PRESETS.get(request.get("preset", ""))
    if preset:
        request = {**preset, **request}  # explicit fields win over the preset
    return request


def reuse_request_keys(request: dict) -> tuple[str, str, str]:
    """Compute the (preprocess, depth, scenes) reuse keys for a video
    request. The ONE key derivation, shared by process_video_job and
    POST /v1/reuse/lookup: both normalize the request the same way
    (normalize_video_request) and hash the same effective fields, so the
    endpoint's keys match the pipeline's by construction. (A raw-body
    derivation in the endpoint previously hashed the pre-preset fields —
    target_height=None, input_size from depth_res — so its keys never
    matched a preset run's.) Idempotent over an already-normalized
    request, so the pipeline can normalize first and still call this."""
    req = normalize_video_request(request)
    pp_key = reuse.preprocess_key(
        req["input_path"],
        req.get("remove_black_bars", True),
        req.get("output_res"),
        req.get("target_height"),
        req.get("target_fps"),
        _trim_spec(req),
        crop_override=req.get("crop"),
    )
    # passthrough scenes get BLACK depth (no AI pass), so the passthrough
    # set is part of the depth artifact's identity
    passthrough = sorted(
        int(ov["first"]) for ov in (req.get("scene_overrides") or [])
        if ov.get("passthrough")
    )
    d_key = reuse.depth_key(
        _depth_source_key(req),
        req.get("depth_model", "vda"),
        int(req.get("input_size", 980)),
        req.get("encoder", "vitl"),
        scene_cuts=req.get("scene_cuts"),
        passthrough=passthrough or None,
    )
    return pp_key, d_key, reuse.scenes_key(pp_key)


def _depth_source_key(req: dict) -> str:
    """The depth stage's source identity — OUTPUT-RESOLUTION-INDEPENDENT
    (see reuse.depth_source_key): a Depth-page draft artifact is the same
    depth a 4k production run needs. ``req`` must already be normalized."""
    return reuse.depth_source_key(
        req["input_path"],
        req.get("remove_black_bars", True),
        req.get("target_fps"),
        _trim_spec(req),
        crop_override=req.get("crop"),
    )


def depth_lookup_keys(request: dict) -> list[str]:
    """Depth-cache candidates in LOOKUP order: the exact key first, then —
    when the request has passthrough scenes — the BASE (no-passthrough)
    key. A FULL depth artifact is output-equivalent for ANY passthrough
    set: the stereo stage ships passthrough scenes as untouched source
    both eyes and never reads their depth, so the black segments were only
    ever a compute-skip. The reverse does NOT hold (a black-segmented
    artifact is wrong for a run that wants those scenes in 3D), so
    registration stays under the exact key and only the lookup widens."""
    req = normalize_video_request(request)
    passthrough = sorted(
        int(ov["first"]) for ov in (req.get("scene_overrides") or [])
        if ov.get("passthrough")
    )
    src_key = _depth_source_key(req)
    args = (
        req.get("depth_model", "vda"),
        int(req.get("input_size", 980)),
        req.get("encoder", "vitl"),
    )
    keys = [reuse.depth_key(*((src_key,) + args),
                            scene_cuts=req.get("scene_cuts"),
                            passthrough=passthrough or None)]
    if passthrough:
        keys.append(reuse.depth_key(*((src_key,) + args),
                                    scene_cuts=req.get("scene_cuts"),
                                    passthrough=None))
    return keys


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
      "placement": [-1.0, 0.5],  # optional job-wide (far, near) planes as
                     # fractions of displacement; mobile one-shot parity
                     # with the app's on-device kernel. Non-adaptive
                     # renders and scene_overrides synthesis use it;
                     # adaptive keeps the profiler's per-shot planes
      "inpaint": "propainter" | "migan" | "none" | "m2svid",
                     # migan: per-frame MI-GAN hole fill on the L4 lite
                     # tier — filled edges at near raw-warp cost, no
                     # temporal stabilization (see migan_runner.py)
      "warp": "forward" | "backward",
                     # stereo synthesis method (default forward = splat).
                     # backward = gather warp (app-parity kernel), no
                     # occlusion masks → only valid with inpaint "none"
      "input_size": 980,            # depth model resolution
      "depth_model": "vda" | "da2-metric-indoor" | "da2-metric-outdoor"
                     | "da3" | "da3-metric" | "depth-pro",
                     # depth-pro (R&D only, apple-amlr weights) also
                     # reports per-scene mean "fov_deg" in metadata
      "encoder": "vitl" | "vits",   # vda only
      "remove_black_bars": true,
      "formats": ["sbs", "half_sbs", "anaglyph", "tb", "half_tb"],
                     # default ["sbs", "half_sbs"]; anaglyph only when
                     # explicitly requested (VR-first product)
      "include_audio": true,
      "output_depth": true,
      "depth_only": false,       # stop after the depth stage: publish
                     # depth + depth_vis and complete (no stereo, no
                     # encodes). formats ignored. Pro Depth step.
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
      "comfort_budget": 0.025    # adaptive only (0, 0.05]: target peak
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
    from app.stages.media import (
        encode_outputs, preprocess_video, publish_depth_vis, publish_file,
        publish_text,
    )

    # preset merge + v7 aliases (depth_res/output_res/inpaint_res) — the
    # ONE normalization, shared with the reuse-key derivation; see
    # normalize_video_request for the precedence rules
    request = normalize_video_request(request)
    from app.stages.video_depth import VideoDepthWorker
    from app.stages.video_stereo import BACKWARD_WARP_GPU, VideoStereoLiteWorker, VideoStereoWorker

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
        # DUAL-RES (v7): the inpaint/depth work file is downscaled to this
        # short side; the splat surface stays at output_res. Only engages
        # when an inpaint_res is given AND it's smaller than the output —
        # i.e. the client explicitly opted into low-res inpaint / high-res
        # splat. Without inpaint_res, single-res (work == splat), unchanged.
        inpaint_short_side = request.get("inpaint_res")

        # ---- content-addressed reuse keys (v7) -------------------------
        # Each stage's artifact is a pure function of its key inputs; if an
        # identical run already published one, reuse it (no job id needed).
        # The trim is resolved inside preprocess (needs source fps), so the
        # key uses the raw spec — identical raw spec ⇒ identical resolved
        # trim for the same source. All three keys come from the shared
        # derivation so POST /v1/reuse/lookup matches by construction.
        # skip_reuse_<stage> forces a recompute of that stage.
        pp_key, d_key, s_key = reuse_request_keys(request)
        pre = _reuse_or_preprocess(
            job_id, jlog, request, pp_key, trim_spec, target_fps, output_res,
            remove_bars, inpaint_short_side,
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
        # user-edited scene cuts (pro step pipeline): mapped once from
        # source-frame space to work-file boundaries, then used by BOTH the
        # adaptive profiler and the depth stage below (detection and the
        # scenes reuse cache are bypassed — user cuts are not auto scenes).
        user_boundaries = _user_scene_boundaries(request, pre)
        if user_boundaries is not None:
            jlog.info(f"✂️  user scene_cuts: {len(user_boundaries)} scene(s) "
                      f"(mapped to work space, detection skipped)")
        # user per-scene stereo overrides (pro step pipeline): SOURCE-frame
        # keyed, resolved through the same mapping as scene_cuts. Applied to
        # the profiler's script when adaptive; otherwise they synthesize the
        # scene_params directly (no profiler, no extra GPU) — see below.
        scene_overrides = request.get("scene_overrides")

        eff_fps = (pre.get("fps_decimation") or {}).get("fps") or probe["fps"]
        if adaptive and eff_fps <= 3.0:
            jlog.info(f"🎚  draft fps ({eff_fps:.1f}) → skipping adaptive profiler "
                      "(flat displacement)")
            adaptive = False
        depth_script: list[dict] | None = None
        # Work-space scene starts flagged passthrough (2D) by the user's
        # scene_overrides. Those scenes ship both eyes as the untouched
        # source, so BOTH the profiler and the AI depth pass skip them —
        # their depth is written black. Resolved in the adaptive /
        # overrides branches below; empty = no skips.
        passthrough_firsts: list[int] = []
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
            if user_boundaries is not None:
                scene_ranges = user_boundaries
            else:
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
            if "depth_scale" not in request and "displacement" in request:
                # Mobile one-shot (2026-09-05): the app has one global
                # strength slider, sent as ``displacement``. Under the
                # profiler that number is the STANDARD-class anchor the
                # whole per-shot script scales from — slider at the
                # standard value ⇒ scale 1.0 (auto-comfort stays on);
                # any other position is a manual scale (comfort skipped,
                # like the web's explicit depth_scale). Clamped to the
                # depth_scale rail. Pro steps never send displacement.
                from app.stages.video_depth_models import SHOT_PARAMS

                anchor = float(SHOT_PARAMS["standard"]["displacement"])
                derived = float(request["displacement"]) / anchor
                depth_scale = round(min(max(derived, 0.3), 1.5), 4)
                if abs(depth_scale - 1.0) < 0.02:
                    depth_scale = 1.0  # slider at the anchor: keep auto-comfort
                jlog.info(
                    f"🎚  displacement {float(request['displacement']):.4f} → "
                    f"depth_scale {depth_scale} (standard anchor {anchor})"
                )
            # auto_comfort (default ON): let the profiler pick the scale
            # that lands the clip's salient disparities inside the comfort
            # budget. An explicit depth_scale overrides it (the worker
            # enforces this precedence).
            auto_comfort = bool(request.get("auto_comfort", True))
            comfort_budget = float(request.get("comfort_budget", 0.025))
            # Resolve user scene_overrides BEFORE profiling: passthrough
            # shots are excluded from the profiler entirely — no keyframe
            # inference, no vote in the auto-comfort budget — exactly like
            # they are excluded from the AI depth pass below.
            resolved: dict[int, dict] = (
                _resolve_scene_overrides(request, pre, scene_ranges, jlog)
                if scene_overrides else {}
            )
            passthrough_firsts = sorted(
                w for w, ov in resolved.items() if ov.get("passthrough")
            )
            pt_set = set(passthrough_firsts)
            profile_ranges = [r for r in scene_ranges if int(r[0]) not in pt_set]
            jlog.info(
                f"🎛  adaptive: profiling {len(profile_ranges)} shot(s) with "
                f"{profiler} (depth_scale={depth_scale}, "
                f"auto_comfort={auto_comfort}, comfort_budget={comfort_budget})"
                + (f" — {len(pt_set)} passthrough shot(s) skipped" if pt_set else "")
            )
            if profile_ranges:
                # single worker: coverage relies on Modal's profiler function
                # timeout (~10min), not the heartbeat watchdog
                depth_script = ShotProfiler(model_name=profiler).profile_scenes.remote(
                    job_id, pre["work_path"], profile_ranges, input_size=518,
                    auto_comfort=auto_comfort, comfort_budget=comfort_budget,
                    depth_scale=depth_scale,
                )
                check_worker_result(depth_script, "profile_scenes")
            else:
                jlog.info("⏩ every scene is passthrough — profiler skipped")
                depth_script = []
            if pt_set:
                # Neutral placeholder entries keep the script tiling ALL of
                # scene_ranges — the stereo lookup and the override applier
                # (which flags them passthrough just below) expect full
                # coverage. Values are inert: the stereo stage ships these
                # frames untouched.
                from app.stages.video_depth_models import DEFAULT_PLACEMENT

                depth_script.extend(
                    {
                        "first": int(a), "last": int(b),
                        "shot_type": "standard", "displacement": 0.0,
                        "placement": list(DEFAULT_PLACEMENT),
                        "median": 0.0, "near_fraction": 0.0,
                    }
                    for a, b in scene_ranges if int(a) in pt_set
                )
                depth_script.sort(key=lambda e: int(e["first"]))
            if scene_overrides:
                # user overrides are the FINAL word: applied AFTER the
                # profiler's smoothing/cut-matching/comfort passes, scaled
                # like the profiler scales (the comfort_scale it chose, or
                # the explicit depth_scale). Comfort clamps are NOT re-run
                # over overridden shots.
                applied_scale = (
                    (jobs.get_job(job_id) or {}).get("comfort_scale")
                    or depth_scale
                )
                _apply_scene_overrides(depth_script, resolved, applied_scale, jlog)
            # source-frame spans for the web client (frame doctrine): the
            # work-space first/last stay for the stereo stages
            _annotate_source_spans(depth_script, request, pre)
            # persist the per-shot decisions immediately so they are
            # inspectable while the job is still running (and survive a
            # later-stage failure); also folded into final metadata below
            jobs.update_job(job_id, depth_script=depth_script)
            # also write a DURABLE, human-readable sidecar to the bucket so
            # the per-shot decisions survive the jobs-Dict rotating (the
            # Dict is volatile; outputs/<job>/ persists). Best-effort — a
            # sidecar failure must not fail the job.
            try:
                from app.stages.video_depth_models import (
                    FAR_PULL_IN, depth_script_to_yaml,
                )
                yaml_text = depth_script_to_yaml(
                    depth_script, eff_fps,
                    meta={
                        "job_id": job_id,
                        "input_path": request["input_path"],
                        "depth_res": input_size,
                        "profiler": profiler,
                        "far_pull_in": FAR_PULL_IN,
                    },
                )
                publish_text.remote(job_id, yaml_text, "depth_script.yaml")
            except Exception as e:  # noqa: BLE001
                jlog.warning(f"depth_script.yaml sidecar skipped: {e}")
            for shot in depth_script:
                jlog.info(
                    f"🎛  shot [{shot['first']}, {shot['last']}): {shot['shot_type']} "
                    f"disp={shot['displacement']} placement={shot['placement']} "
                    f"(median={shot['median']}, near_fraction={shot['near_fraction']})"
                )
        elif scene_overrides:
            # scene_overrides WITHOUT adaptive: synthesize flat per-scene
            # params directly (no profiler, no extra GPU) — every scene at
            # the job-wide displacement default + the splatter's default
            # placement (identical to a plain non-adaptive render), then
            # the user's overrides edit their scenes. The result threads
            # into the stereo stage exactly like an adaptive depth script
            # (scene_params keys on absolute frame index, so it composes
            # with both backends' sequential and parallel paths alike).
            ranges = user_boundaries or [(0, pre["probe"]["num_frames"])]
            resolved = _resolve_scene_overrides(request, pre, ranges, jlog)
            passthrough_firsts = sorted(
                w for w, ov in resolved.items() if ov.get("passthrough")
            )
            depth_script = _synthesize_scene_params(
                ranges, float(request.get("displacement", 0.0125)),
                request.get("placement"),
            )
            _apply_scene_overrides(depth_script, resolved, 1.0, jlog)
            _annotate_source_spans(depth_script, request, pre)
            jlog.info(
                f"🎚  scene_overrides (non-adaptive): synthesized "
                f"{len(depth_script)} scene(s), {len(resolved)} overridden"
            )
            jobs.update_job(job_id, depth_script=depth_script)
        # depth reuse: experiments that vary only the stereo/inpaint
        # stage (e.g. propainter vs m2svid, displacement sweeps,
        # adaptive on/off) can skip the depth pass entirely by pointing
        # at a prior job's depth map on the shared cache volume. The
        # source/crop/resolution MUST match — we verify frame count and
        # depth dimensions against this run's preprocess before using it.
        # Explicit reuse_depth_from (job id) WINS; otherwise content-
        # addressed auto-reuse looks up the depth key (preprocess + model +
        # input_size + encoder + scene-boundary identity, computed above)
        # and reuses the matching published depth.
        # User-provided depth (depth_source: a gateway-validated bucket key)
        # WINS over everything — no reuse lookup, no depth compute, and the
        # file is never registered under the AI-depth content key below.
        depth_source = request.get("depth_source")
        reuse_from = None if depth_source else request.get("reuse_depth_from")
        explicit_reuse = bool(reuse_from)
        if not depth_source and not reuse_from and not request.get("skip_reuse_depth"):
            # exact key first, then the no-passthrough BASE key (a full
            # depth artifact serves any passthrough set — see
            # depth_lookup_keys)
            for candidate in depth_lookup_keys(request):
                hit = reuse.lookup(candidate)
                if not hit:
                    continue
                from app.common.notify import notify_slack

                reuse_from = hit["job_id"]
                jlog.info(f"♻️  depth auto-reuse HIT ({candidate}) ← job {reuse_from}")
                notify_slack(
                    f"♻️ *depth reuse* job `{job_id}` reused depth from "
                    f"`{reuse_from}` (key `{candidate}`)"
                )
                break
        depth = None
        if depth_source:
            from app.stages.media import probe_depth_upload

            depth = probe_depth_upload.remote(
                job_id, depth_source, pre["probe"]["num_frames"]
            )
            check_worker_result(depth, "video_depth(upload)")
            jlog.info(
                f"🎞  user-provided depth {depth_source}: "
                f"{depth['num_frames']}f at {depth['depth_shape']}"
            )
        elif reuse_from:
            from app.stages.media import probe_depth_reuse

            try:
                depth = probe_depth_reuse.remote(job_id, reuse_from, pre["probe"]["num_frames"])
                check_worker_result(depth, "video_depth(reuse)")
                jlog.info(
                    f"♻️  reusing depth from job {reuse_from}: "
                    f"{depth['num_frames']}f at {depth['depth_shape']}"
                )
            except Exception:
                # An EXPLICIT pointer must fail loudly — the caller asked
                # for THIS depth. An AUTO hit that fails validation (stale
                # file, frame-count edge like the dual-res phantom-tail
                # pin) degrades to a recompute instead of killing the job.
                if explicit_reuse:
                    raise
                jlog.warning(
                    f"♻️  depth auto-reuse from job {reuse_from} failed "
                    f"validation — recomputing depth", exc_info=True,
                )
                depth = None
                reuse_from = None
        if depth is not None:
            pass  # reused or user-provided — skip the compute branches
        elif depth_model == "vda":
            depth_gpu, work_mp, elongation = _route_depth_gpu(input_size, probe)
            worker_cls = (
                VideoDepthWorker if depth_gpu == "L40S"
                else VideoDepthWorker.with_options(gpu=depth_gpu)
            )
            jlog.info(
                f"🖥  depth GPU: {depth_gpu} (input_size={input_size}, "
                f"working={work_mp:.2f}MP at {elongation:.2f}:1, parallel={parallel})"
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
                    boundaries=user_boundaries,
                    passthrough_firsts=passthrough_firsts or None,
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
                    scene_ranges=user_boundaries,
                    passthrough_firsts=passthrough_firsts or None,
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

        if request.get("depth_only"):
            # Depth page: the product is the depth map itself — publish it
            # (+ the browser-playable depth_vis) and stop. No stereo warp,
            # no output encodes. Registration below mirrors the full-run
            # path so a later stereo/production run reuses this artifact.
            jobs.update_job(job_id, progress=0.9, stage="publish_depth")
            outputs = {
                "depth": publish_file.remote(job_id, depth["depth_path"], "depth.mp4"),
                "depth_vis": publish_depth_vis.remote(job_id, depth["depth_path"]),
            }
            if not reuse_from:  # freshly computed (depth_source is rejected at submit)
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
                    "fps_decimation": pre.get("fps_decimation"),
                    "scene_cuts": depth["scene_cuts"],
                    "depth_shape": depth["depth_shape"],
                    **({"depth_script": depth_script} if depth_script is not None else {}),
                    **(
                        {"scene_overrides": request["scene_overrides"]}
                        if request.get("scene_overrides") is not None else {}
                    ),
                    **(
                        {"comfort_scale": (jobs.get_job(job_id) or {}).get("comfort_scale")}
                        if adaptive else {}
                    ),
                    **({"fov_deg": depth["fov_deg"]} if "fov_deg" in depth else {}),
                },
            )
            jlog.info(f"🏁 depth-only job completed: {len(outputs)} output(s) published")
            return {"job_id": job_id, "status": jobs.COMPLETED, "outputs": outputs}

        jobs.update_job(job_id, progress=0.5, stage="video_stereo")

        inpaint = request.get("inpaint", "propainter")
        warp = request.get("warp", "forward")
        # fail here (not deep inside a GPU worker) on backward + any
        # fill model: a gather warp has no holes to inpaint
        from app.stages.warp_modes import validate_warp
        validate_warp(warp, inpaint)
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
                placement=request.get("placement"),  # None = DEFAULT_PLACEMENT
                fps_rational=fps_rational,
                scene_params=depth_script,  # None unless adaptive
            )
            # DUAL-RES (v7): splat at output-res; M2SVid fill stays at its
            # 512 model tier (resolution-independent of the splat).
            if pre.get("splat_path"):
                m2svid_kwargs["splat_video_path"] = pre["splat_path"]
                sp = pre.get("splat_probe") or probe
                jlog.info(f"🪟 dual-res (m2svid): splat@{sp['width']}x{sp['height']}")
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
                placement=request.get("placement"),  # None = DEFAULT_PLACEMENT
                inpaint=inpaint,
                warp=warp,
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
            # DUAL-RES (v7): when preprocess produced a separate output-res
            # splat surface, the worker splats+composites there while still
            # filling at (wh, ww). The frame count is invariant (splat is a
            # scale of work), so chunking/concat are unchanged.
            splat_probe = pre.get("splat_probe")
            if pre.get("splat_path"):
                stereo_kwargs["splat_video_path"] = pre["splat_path"]
                splat_px = (splat_probe or probe)["width"] * (splat_probe or probe)["height"]
                jlog.info(
                    f"🪟 dual-res: splat@{(splat_probe or probe)['width']}x"
                    f"{(splat_probe or probe)['height']}, inpaint@{ww}x{wh}"
                )
            else:
                splat_px = probe["width"] * probe["height"]
            # GPU routing by the SPLAT pixel count (the new VRAM driver): 4K
            # splat/composite buffers need H200; the inpaint stays at (wh,ww).
            # Also escalate on a big inpaint work res (legacy behavior).
            big_work = (wh * ww > 1280 * 720) or (splat_px > 2560 * 1440)
            if warp == "backward" or inpaint == "migan":
                # Lite tier (L4 + NVENC): the gather warp needs no models at
                # all, and MI-GAN is a 30 MB per-frame fill — neither needs
                # ProPainter VRAM, so both skip the L40S/H200 tiers.
                stereo_cls = VideoStereoLiteWorker
                big_work = False
                jlog.info(f"🖥  stereo GPU: {BACKWARD_WARP_GPU} (lite tier; warp={warp}, "
                          f"inpaint={inpaint}, splat_px={splat_px})")
            else:
                # >720p ProPainter / 4K splat needs ~80+ GB
                stereo_cls = (
                    VideoStereoWorker.with_options(gpu="H200") if big_work else VideoStereoWorker
                )
                jlog.info(f"🖥  stereo GPU: {'H200' if big_work else 'L40S'} "
                          f"(splat_px={splat_px}, work={ww}x{wh})")
            if parallel:
                stereo = _parallel_stereo(
                    job_id, jlog, pre, stereo_kwargs, stereo_cls,
                    max_workers=max_gpu_workers,
                    stall_timeout_s=stall_timeout_s, chunk_cap=stereo_chunk_cap,
                    vram_gb=140.0 if big_work else 45.0,
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

        # VR-first default: no anaglyph unless explicitly requested
        formats = request.get("formats", ["sbs", "half_sbs"])
        # SBS-family formats handled by encode_outputs; mvhevc is a separate
        # stage that reads the raw stereo (stereo["sbs_path"]) directly. If
        # the request asks for ONLY mvhevc, the sbs-family list is empty —
        # SKIP encode_outputs entirely. (Previously an empty list fell through
        # to encode_outputs' own ``formats or [defaults]`` and wrongly encoded
        # sbs+half_sbs+anaglyph that nobody requested — ~12min of waste on a
        # full-fps 4K mvhevc-only job.)
        sbs_formats = [f for f in formats if f != "mvhevc"]
        if sbs_formats:
            encoded = encode_outputs.remote(
                job_id,
                sbs_path=stereo["sbs_path"],
                original_path=pre["source_path"],  # pristine input carries the audio
                formats=sbs_formats,
                include_audio=request.get("include_audio", True),
                audio_trim=audio_trim,
            )
            outputs = dict(encoded["outputs"])
        else:
            jlog.info("⏭  no SBS-family formats requested — skipping encode_outputs")
            encoded = {"outputs": {}, "av_sync_ms": {}}  # so downstream av_sync ref is safe
            outputs = {}
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
            # browsers can't decode gray16le H.264, so ALSO publish an 8-bit
            # yuv420p preview (short side ≤720, no upscale). Derived from
            # THIS job's cache copy of the depth, so it exists on the reuse
            # path too; the reuse registry below still points ONLY at
            # depth.mp4 (the preview never enters the content-addressed key).
            outputs["depth_vis"] = publish_depth_vis.remote(job_id, depth["depth_path"])
            # register this depth for content-addressed auto-reuse (only
            # when freshly computed — reusing then re-registering the same
            # key is a harmless no-op, but skip it to keep the pointer at the
            # original producer; a USER-PROVIDED depth must never be
            # registered under the AI-depth key or unrelated runs would be
            # served the user's file). depth published at outputs/<job>/depth.mp4.
            if not reuse_from and not depth_source:
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
                # echo the raw request overrides for support/debugging (the
                # applied form lives on each depth_script entry's "override")
                **(
                    {"scene_overrides": request["scene_overrides"]}
                    if request.get("scene_overrides") is not None else {}
                ),
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
                         output_res, remove_bars, inpaint_short_side=None):
    """Auto-reuse a published preprocess work file if one matches pp_key,
    else run preprocess and publish+register the result.

    A reused work file already encodes crop/scale/fps/trim, but the
    pipeline still needs source-derived fields (source_path for the audio
    mux, source_fps for audio_trim, the resolved trim window, the
    fps_decimation record). We reconstruct them from a cheap probe of the
    ORIGINAL source (always on GCS) so the reuse path returns the same dict
    shape as a fresh preprocess.

    skip_reuse_preprocess forces a recompute (and still publishes, so the
    fresh result is registered for the next run).

    EXPLICIT reuse_preprocess_from (job id) WINS over auto-reuse and works
    CROSS-ENV: it fetches outputs/<job>/preprocess.mp4 (+ _splat) from the
    shared GCS prefix by path, and takes the source-derived metadata from
    the ``preprocess_meta`` payload (the per-env Dict isn't readable across
    envs). Get both from POST /v1/reuse/lookup, which returns the job id
    AND the meta. Mirrors reuse_depth_from for the cheap-to-skip preprocess
    stage."""
    from app.stages.media import (fetch_preprocess_reuse, preprocess_video,
                                   publish_file)
    from app.common.storage import bucket_path

    # explicit cross-env reuse by job id + provided metadata (no Dict lookup)
    pp_from = request.get("reuse_preprocess_from")
    if pp_from:
        meta = request.get("preprocess_meta") or {}
        relpath = f"outputs/{pp_from}/preprocess.mp4"
        splat_relpath = meta.get("splat_relpath")
        jlog.info(
            f"♻️  preprocess EXPLICIT reuse ← job {pp_from} "
            f"({relpath}{', +splat' if splat_relpath else ''})")
        pre = fetch_preprocess_reuse.remote(job_id, relpath, splat_relpath)
        trim = meta.get("trim")
        return {
            **pre,
            "source_path": str(bucket_path(request["input_path"])),
            "crop": meta.get("crop"),
            "trim": tuple(trim) if trim else None,
            "fps_decimation": meta.get("fps_decimation"),
            "source_fps": meta.get("source_fps"),
            # may be absent from older lookup payloads; the source-span
            # annotation falls back to the trim end / inverse mapping
            "source_num_frames": meta.get("source_num_frames"),
            "_pp_key": pp_key,
        }

    skip = bool(request.get("skip_reuse_preprocess"))
    entry = None if skip else reuse.lookup(pp_key)
    if entry:
        from app.common.notify import notify_slack

        jlog.info(f"♻️  preprocess auto-reuse HIT ({pp_key}) ← job {entry['job_id']}")
        notify_slack(
            f"♻️ *preprocess reuse* job `{job_id}` reused work file from "
            f"`{entry['job_id']}` (key `{pp_key}`)"
        )
        meta = entry.get("meta") or {}
        pre = fetch_preprocess_reuse.remote(
            job_id, entry["gcs_relpath"], meta.get("splat_relpath"))
        # reconstruct source-derived fields the downstream stages need from
        # the registry meta (recorded when the work file was published)
        src_fps = meta.get("source_fps")
        trim = meta.get("trim")
        return {
            **pre,
            "source_path": str(bucket_path(request["input_path"])),
            "crop": meta.get("crop"),
            "trim": tuple(trim) if trim else None,
            "fps_decimation": meta.get("fps_decimation"),
            "source_fps": src_fps,
            # may be absent from entries registered before this field
            # existed; the source-span annotation degrades gracefully
            "source_num_frames": meta.get("source_num_frames"),
            "_pp_key": pp_key,
        }

    if skip:
        jlog.info(f"⏭  preprocess reuse skipped (skip_reuse_preprocess); recomputing")
    pre = preprocess_video.remote(
        job_id, request["input_path"], remove_black_bars=remove_bars,
        target_height=request.get("target_height"), trim_spec=trim_spec,
        target_fps=float(target_fps) if target_fps is not None else None,
        target_short_side=int(output_res) if output_res is not None else None,
        inpaint_short_side=int(inpaint_short_side) if inpaint_short_side else None,
        crop_override=request.get("crop"),
    )
    # publish the work file (+ the dual-res splat file if any) and register
    # so the NEXT identical run reuses BOTH. The splat surface is reusable
    # too (concern #1: save it), keyed under the same preprocess key.
    try:
        publish_file.remote(job_id, pre["work_path"], "preprocess.mp4")
        relpath = f"outputs/{job_id}/preprocess.mp4"
        splat_relpath = None
        if pre.get("splat_path"):
            publish_file.remote(job_id, pre["splat_path"], "preprocess_splat.mp4")
            splat_relpath = f"outputs/{job_id}/preprocess_splat.mp4"
        reuse.register(pp_key, job_id, relpath, meta={
            "source_fps": pre.get("source_fps"),
            "source_num_frames": pre.get("source_num_frames"),
            "trim": list(pre["trim"]) if pre.get("trim") else None,
            "crop": pre.get("crop"),
            "fps_decimation": pre.get("fps_decimation"),
            "splat_relpath": splat_relpath,
            "splat_probe": pre.get("splat_probe"),
        })
        jlog.info(f"📌 registered preprocess for reuse ({pp_key}) → {relpath}"
                  + (f" (+splat {splat_relpath})" if splat_relpath else ""))
    except Exception:
        logger.warning("preprocess publish/register failed (non-fatal)", exc_info=True)
    pre["_pp_key"] = pp_key
    return pre


# ---------------------------------------------------------- depth GPU routing
#
# VDA depth's VRAM is driven by the WORKING PIXEL COUNT, not by depth_res
# (input_size) alone. The depth model resizes the SHORT side to input_size
# and the long side follows the source aspect, so:
#
#     working_pixels = short × long = input_size × (input_size × elongation)
#                    = input_size² × elongation      (elongation = long/short ≥ 1)
#
# We therefore route on WORKING MEGAPIXELS (work_mp) — a single, physical,
# orientation-AND-aspect-agnostic axis. The same work_mp uses the same VRAM
# whether the frame is 16:9, 9:16, 1:1, or 2.39:1, so one set of thresholds
# is correct for every aspect (the old `eff_size` proxy was calibrated on
# 16:9 and mis-handled non-16:9 — it over-capped square content and could
# mis-route ultra-wide).
#
# THRESHOLDS are calibrated from MEASURED runs on a 16:9 4K source
# (3840×2160, elongation 1.78). work_mp = input_size² × 1.78 / 1e6:
#
#   depth_res 1078 → 2.07 MP → ran on L40S          (worked)
#   depth_res 1148 → 2.34 MP → old L40S boundary
#   depth_res 1442 → 3.70 MP → ran (was A100)       (worked)
#   depth_res 1806 → 5.80 MP → ran on H200          (worked — proven H200 max)
#   depth_res 2100 → 7.84 MP → OOM on H200          (FAILED: needed >141 GB)
#
# So:
#   L40S_MAX_MP = 2.5  → ~depth_res 1184 on 16:9 (matches the old ≤1148 tier;
#                        d1078 @ 2.07 MP comfortably inside)
#   H200_MAX_MP = 6.5  → ~depth_res 1912 on 16:9; CONSERVATIVE within the
#                        measured band [5.80 works … 7.84 OOMs] (OOM is a
#                        hard failure, so we leave margin below 7.84)
#
# Worked examples at these thresholds (shows the aspect-proofing):
#   16:9 4K, depth_res 1806 → 5.80 MP → H200            (the proven case)
#   9:16   , depth_res 1806 → 5.80 MP → H200            (identical to 16:9)
#   1:1    , depth_res 1806 → 3.26 MP → H200            (less VRAM; safe)
#   1:1    , depth_res 2100 → 4.41 MP → H200            (the old proxy WRONGLY
#                                                         errored here; 1:1
#                                                         genuinely fits H200)
#   9:16   , depth_res 2100 → 7.84 MP → ERROR           (same as 16:9; OOM risk)
#   2.39:1 , depth_res 1806 → 7.80 MP → ERROR           (ultra-wide hits the
#                                                         cap earlier — correct)
#
# Above H200_MAX_MP we route to B200 (Blackwell/sm_100), the next VRAM tier:
#   2.39:1 4K, depth_res 2100 → 7.84 MP → ran on B200 in 415.9s (no OOM —
#                                         proven; H200 OOMs the same workload)
# B200's ~180 GB clears what H200's 141 GB cannot. It runs the depth image's
# Blackwell torch 2.9.1 + xformers 0.0.33.post2 stack (sm_100 cutlass fmha
# kernels); the old cu126 torch 2.7.1 / xformers 0.0.31 gave "no kernel image
# available" on B200. B200 is 58% pricier/s than H200 and ~0.74× its
# throughput at equal work, so it is NOT cost-competitive at resolutions H200
# can already handle — it exists purely as the VRAM-ceiling tier for the work
# H200 physically cannot fit. Above B200_MAX_MP we FAIL FAST.
L40S_MAX_MP = 2.5
H200_MAX_MP = 6.5
B200_MAX_MP = 8.5  # 7.84 MP (depth_res 2100, 2.39:1 4K) proven to fit, with
#                    margin to ~180 GB. Above this, no current tier — reject.


def _route_depth_gpu(input_size: int, probe: dict) -> tuple[str, float, float]:
    """Pick the depth GPU by WORKING MEGAPIXELS (input_size² × elongation),
    aspect- and orientation-agnostic. Returns (gpu, work_mp, elongation).
    Routes L40S → H200 → B200 by VRAM need; raises ValueError above the B200
    ceiling. See the module comment above for the threshold derivation."""
    long_side = max(probe["width"], probe["height"])
    short_side = max(min(probe["width"], probe["height"]), 1)
    elongation = long_side / short_side  # ≥ 1
    work_mp = (input_size ** 2) * elongation / 1e6
    if work_mp <= L40S_MAX_MP:
        return "L40S", work_mp, elongation
    if work_mp <= H200_MAX_MP:
        return "H200", work_mp, elongation
    if work_mp <= B200_MAX_MP:
        return "B200", work_mp, elongation
    raise ValueError(
        f"depth working resolution too high: {work_mp:.2f} MP/frame "
        f"(input_size={input_size}, {elongation:.2f}:1 aspect) exceeds the B200 "
        f"VRAM ceiling (~{B200_MAX_MP} MP) — the largest tier available. Lower "
        f"depth_res, or the source/output aspect's long side."
    )


def _propainter_work_res(request: dict, src_w: int, src_h: int) -> tuple[int, int]:
    """ProPainter (height, width) working resolution, ORIENTATION-AGNOSTIC.

    Precedence:
    1. explicit work_height AND work_width in the request → used verbatim
       (back-compat / expert override).
    2. otherwise a SHORT-SIDE value (``inpaint_res``, else ``work_height``,
       default 720): the short side = that value, the long side derived
       from the source aspect. BOTH dims are rounded to a MULTIPLE OF 8 —
       ProPainter's RAFT flow downsamples by 8, and if a dim isn't /8-clean
       the image grid and the flow grid round to different widths (e.g. a
       2.31:1 source → 1662 even → 207.75 vs 208 after /8), which crashes
       grid_sampler with a 1-pixel batch/size mismatch. /8 keeps both grids
       identical. So a 16:9 source → 1280×720, a 9:16 portrait → 720×1280,
       1:1 → 720×720, an ultra-wide 2.31:1 → 1664×720 — never the fixed
       1280×720 rectangle that distorts non-landscape.
    """
    if request.get("work_height") and request.get("work_width"):
        return int(request["work_height"]), int(request["work_width"])
    short = int(request.get("inpaint_res") or request.get("work_height") or 720)
    src_long = max(src_w, src_h)
    src_short = max(min(src_w, src_h), 1)
    # /8 (not just even): RAFT flow grid must tile identically to the image
    long_side = max(8, int(round(short * src_long / src_short / 8)) * 8)
    short = max(8, (short // 8) * 8)
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


def _resample_source_fps(pre: dict) -> float:
    """SOURCE fps for the non-divisor resample mapping — NO fallback to
    pre["probe"]["fps"]: that probe is the WORK file, whose fps is the
    TARGET rate, so falling back degenerates the resample mapping to
    identity (silently wrong frames). A resampled preprocess whose reuse
    meta predates source_fps fails the job loudly instead. (Divisor
    decimation never calls this — it needs no fps.)"""
    src_fps = pre.get("source_fps")
    if not src_fps:
        raise ValueError(
            "preprocess meta is missing 'source_fps' for an fps-resampled "
            "work file — the source↔work frame mapping cannot be computed "
            "(the work probe's fps is the TARGET rate). Re-run with "
            "skip_reuse_preprocess=true to recompute the preprocess and "
            "re-register it with full meta."
        )
    return float(src_fps)


def _map_source_to_work(c_src: int, pre: dict) -> int:
    """SOURCE-frame index → WORK-frame index under trim + fps decimation.

    This is the ONE source→work frame mapping (frame doctrine: the web
    client and gateway never re-derive it; ``scene_cuts`` boundaries AND
    ``scene_overrides`` targeting both resolve through here):
      1. trim: work frames count from the trim start (indices at/before
         the kept window's first frame clamp to 0);
      2. exact fps decimation (divisor N keeps every Nth frame): the scene
         starting at trimmed frame c begins at the first KEPT frame ≥ c,
         i.e. ceil(c / N) — frame-exact;
      3. non-divisor fps resample (nearest-frame): nearest work frame by
         time, round(c · f_target / f_source) — best possible under
         resampling, ±1 frame by construction.
    """
    trim = pre.get("trim")
    c = int(c_src) - (trim[0] if trim else 0)
    if c <= 0:
        return 0
    dec = pre.get("fps_decimation")
    if dec is None:
        return c
    if dec.get("divisor"):
        n = int(dec["divisor"])
        return -(-c // n)  # ceil: first kept frame ≥ the cut
    return round(c * float(dec["fps"]) / _resample_source_fps(pre))


def _work_to_source_frame(w: int, pre: dict) -> int:
    """Inverse of _map_source_to_work for KEPT work frames: the source
    frame that work frame ``w`` decodes from. Exact under trim and divisor
    decimation (kept frames are trim_start + w·N by construction);
    nearest-frame under resample (±1, same tolerance as the forward map).
    Used only to express auto-detected work-space scenes in SOURCE-frame
    space for metadata (first_src/last_src) — user-provided cuts are
    echoed verbatim instead, never round-tripped through this."""
    trim = pre.get("trim")
    t0 = trim[0] if trim else 0
    dec = pre.get("fps_decimation")
    if dec is None:
        return t0 + int(w)
    if dec.get("divisor"):
        return t0 + int(w) * int(dec["divisor"])
    return t0 + round(int(w) * _resample_source_fps(pre) / float(dec["fps"]))


def _user_scene_boundaries(request: dict, pre: dict) -> list | None:
    """Map user-edited ``scene_cuts`` (SOURCE-frame indices, each the first
    frame of a new scene) to work-file scene boundaries [(first, last), …].

    Returns None when the request carries no scene_cuts (auto-detect path).
    Cuts outside the kept trim window (mapped to 0 or past the work span)
    are dropped; colliding cuts (two source cuts landing on one work frame
    under decimation) collapse to one."""
    cuts_src = request.get("scene_cuts")
    if cuts_src is None:
        return None
    num_work = pre["probe"]["num_frames"]
    work_cuts: list[int] = []
    for c in cuts_src:
        w = _map_source_to_work(c, pre)
        if 0 < w < num_work and (not work_cuts or w > work_cuts[-1]):
            work_cuts.append(w)
    edges = [0, *work_cuts, num_work]
    return [(a, b) for a, b in zip(edges, edges[1:])]


def _resolve_scene_overrides(request: dict, pre: dict, boundaries: list, jlog) -> dict:
    """Map ``scene_overrides`` (keyed by SOURCE-frame scene start ``first``)
    onto WORK-space scene starts: {work_first: {override fields}}.

    Frame doctrine: an override whose ``first`` does not land on a resolved
    scene start FAILS the job loudly (a user's frame decision is never
    silently snapped or dropped). The ONE exception mirrors trimmed-out
    scene_cuts handling: a scene that doesn't exist in this job — entirely
    outside the trim window, OR keeping zero work frames because decimation
    collapsed it onto the next scene's start — is dropped WITH a job-log
    warning; there is nothing to override (applying it anyway would land
    the user's numbers on the NEXT scene's content).

    A scene whose START was trimmed away but whose tail survives IS the
    first work scene, so its override resolves to work start 0 (same
    collapse the boundary mapping applies to its cut)."""
    overrides = request.get("scene_overrides") or []
    if not overrides:
        return {}
    trim = pre.get("trim")
    t0 = trim[0] if trim else 0
    t1 = trim[1] if trim else None
    cuts_src = request.get("scene_cuts") or []
    num_work = pre["probe"]["num_frames"]
    starts = {int(first) for first, _ in boundaries}
    resolved: dict[int, dict] = {}
    for ov in overrides:
        f = int(ov["first"])
        # this scene's SOURCE end = the next user cut (None = clip end)
        nxt = next((c for c in cuts_src if c > f), None)
        if (nxt is not None and nxt <= t0) or (t1 is not None and f >= t1):
            jlog.warning(
                f"⚠️  scene_overrides: scene starting at source frame {f} is "
                f"entirely outside the trim window — override dropped"
            )
            continue
        w = _map_source_to_work(f, pre)
        if w >= num_work:
            # same handling as a cut past the kept span (dropped there too)
            jlog.warning(
                f"⚠️  scene_overrides: source frame {f} maps past the work "
                f"clip ({w} ≥ {num_work}) — override dropped"
            )
            continue
        if nxt is not None and _map_source_to_work(nxt, pre) == w:
            # the scene keeps NO work frames — decimation collapsed it onto
            # the next scene's start (e.g. a 1-frame scene under divisor 2),
            # so work frame w shows the NEXT scene's content. Same policy as
            # a trimmed-out scene: the scene doesn't exist in this job, drop
            # the override loudly rather than restyle the wrong scene.
            jlog.warning(
                f"⚠️  scene_overrides: scene starting at source frame {f} "
                f"keeps no work frames under fps decimation (collapsed onto "
                f"work frame {w}, the next scene's start) — override dropped"
            )
            continue
        if w not in starts:
            raise ValueError(
                f"scene_overrides: first={f} maps to work frame {w}, which is "
                f"not a resolved scene start (starts: {sorted(starts)}). "
                f"Overrides must target frame 0 or an exact scene start "
                f"(a scene_cuts value)."
            )
        if w in resolved:
            # two source scenes collapsed onto one work scene (decimation
            # collision / trim) — the later override wins, loudly
            jlog.warning(
                f"⚠️  scene_overrides: first={f} collapses onto work scene "
                f"{w} already overridden — later entry wins"
            )
        resolved[w] = {k: v for k, v in ov.items() if k != "first"}
    return resolved


def _apply_scene_overrides(script: list, resolved: dict, depth_scale: float, jlog) -> None:
    """Apply resolved scene_overrides onto the final depth script IN PLACE.

    User override = FINAL word: applied AFTER the profiler's smoothing /
    cut-matching / comfort passes, and comfort clamps are NOT re-run over
    an overridden shot (a clamp silently editing the user's number would
    violate the doctrine).
    - ``displacement``: set flat.
    - ``shot_type`` (without displacement): re-derive displacement from
      SHOT_PARAMS[shot_type] × depth_scale — the same scaling the profiler
      applies at SHOT_PARAMS lookup — and placement from SHOT_PARAMS.
    - explicit ``placement`` wins over derived.
    ANY override drops the shot's "keyframes" ramp: _scene_param_lookup
    lets keyframes win over the entry-level values, so a leftover ramp
    would silently render the profiler's numbers instead of the user's.
    Each touched entry records ``"override": {...}`` for support/debug."""
    from app.stages.video_depth_models import SHOT_PARAMS

    for entry in script:
        ov = resolved.get(int(entry["first"]))
        if ov is None:
            continue
        if "passthrough" in ov and not ov["passthrough"]:
            # explicit false = no override; don't let it reach the generic
            # tail below (which would drop the shot's keyframes ramp)
            ov = {k: v for k, v in ov.items() if k != "passthrough"}
            if not ov:
                continue
        if ov.get("passthrough"):
            # ship this shot as 2D (both eyes = source): the stereo stage
            # skips warp/inpaint for it. Depth knobs are meaningless here;
            # validation upstream already rejects the combination.
            entry["passthrough"] = True
            entry.pop("keyframes", None)
            entry["override"] = dict(ov)
            jlog.info(
                f"⏩ passthrough override on shot [{entry['first']}, {entry['last']})"
            )
            continue
        if "shot_type" in ov:
            params = SHOT_PARAMS[ov["shot_type"]]
            entry["shot_type"] = ov["shot_type"]
            entry["displacement"] = round(params["displacement"] * depth_scale, 6)
            entry["placement"] = list(params["placement"])
        if "displacement" in ov:  # wins over a shot_type re-derivation
            entry["displacement"] = float(ov["displacement"])
        if "placement" in ov:  # explicit placement wins over derived
            entry["placement"] = [float(v) for v in ov["placement"]]
        entry.pop("keyframes", None)  # a manual value must actually render
        entry["override"] = dict(ov)
        jlog.info(
            f"🎚  override applied to shot [{entry['first']}, {entry['last']}): "
            f"{ov} → disp={entry['displacement']} placement={entry['placement']}"
        )
    # defensive: every resolved override must have found its shot — the
    # script tiles the same ranges we resolved against, so a miss here is
    # a programming error, not a user error
    matched = {int(e["first"]) for e in script}
    missing = sorted(w for w in resolved if w not in matched)
    if missing:
        raise RuntimeError(
            f"scene_overrides resolved to work starts {missing} absent from "
            f"the depth script (script starts: {sorted(matched)})"
        )


def _synthesize_scene_params(
    ranges: list, displacement: float, placement=None,
) -> list:
    """scene_overrides WITHOUT adaptive: build flat per-scene params
    directly — no profiler, no extra GPU. Every scene starts from EXACTLY
    what a plain non-adaptive render uses — the request's displacement and
    the splatter's DEFAULT_PLACEMENT — so overriding ONE scene never
    changes any other scene's look (the 'standard' SHOT_PARAMS placement
    used before is an adaptive-profiler bucket, NOT the non-adaptive
    default), and the overrides then edit their scenes. Same entry
    contract the stereo stage's scene_params lookup consumes."""
    from app.stages.video_depth_models import DEFAULT_PLACEMENT

    base = [float(v) for v in placement] if placement else list(DEFAULT_PLACEMENT)
    return [
        {
            "first": int(a),
            "last": int(b),
            "displacement": float(displacement),
            "placement": list(base),
        }
        for a, b in ranges
    ]


def _annotate_source_spans(script: list, request: dict, pre: dict) -> None:
    """Attach ``first_src``/``last_src`` (SOURCE-frame scene span,
    half-open) to every depth-script entry IN PLACE. The web client works
    in source-frame space (frame doctrine) — the work-space
    ``first``/``last`` stay untouched for the stereo stages.

    Two derivations, both riding the ONE trim+decimation mapping:
    - user ``scene_cuts``: spans are echoed from the USER'S source starts
      (0 + the cuts), never round-tripped through the mapping — a work
      scene's first_src is the LAST source start whose mapped work
      position is at/before the work start (so a scene whose cut was
      trimmed away / collapsed still names its true source scene), and
      last_src is the next source start, or the source clip end.
    - auto-detected scenes (no scene_cuts): spans are inverse-mapped via
      _work_to_source_frame — exact under divisor decimation, ±1 under
      resample.
    The final scene's last_src is the SOURCE clip length when known
    (preprocess records source_num_frames; older reuse-cache entries may
    predate it, in which case the trim end / inverse-mapped work end is
    the best available)."""
    num_work = pre["probe"]["num_frames"]
    trim = pre.get("trim")
    src_end = (
        pre.get("source_num_frames")
        or (trim[1] if trim else None)
        or _work_to_source_frame(num_work, pre)
    )
    cuts_src = request.get("scene_cuts")
    if cuts_src is None:
        for entry in script:
            entry["first_src"] = _work_to_source_frame(int(entry["first"]), pre)
            last = int(entry["last"])
            entry["last_src"] = (
                int(src_end) if last >= num_work else _work_to_source_frame(last, pre)
            )
        return
    starts = [0, *cuts_src]
    pos = [_map_source_to_work(s, pre) for s in starts]
    for entry in script:
        a = int(entry["first"])
        i = max(j for j, p in enumerate(pos) if p <= a)
        entry["first_src"] = int(starts[i])
        entry["last_src"] = int(starts[i + 1]) if i + 1 < len(starts) else int(src_end)


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
                    max_workers, stall_timeout_s=STALL_TIMEOUT_S, chunk_cap=DEPTH_CHUNK_FRAMES,
                    boundaries=None, passthrough_firsts=None):
    from app.common.errors import check_worker_result
    from app.stages.media import concat_cache_segments, detect_scenes

    # boundaries: precomputed work-space scene ranges (user-edited
    # scene_cuts); None → auto-detect.
    if boundaries is None:
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
        # every chunk gets the FULL passthrough list — starts outside its
        # ranges simply never match (fail-soft, no per-chunk filtering)
        return capped(encoder=encoder).generate_scenes.spawn(
            job_id, pre["work_path"], chunks[i], input_size, fps_rational,
            passthrough_firsts=passthrough_firsts,
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
                     stall_timeout_s=STALL_TIMEOUT_S, chunk_cap=STEREO_CHUNK_FRAMES,
                     vram_gb=45.0):
    from app.common.errors import check_worker_result
    from app.common.storage import job_cache_dir
    from app.stages.media import concat_cache_segments
    from app.stages.video_stereo import SEGMENT_FRAMES, _pick_batch_size

    total = pre["probe"]["num_frames"]
    # Window sized by the INPAINT working resolution (VRAM scales with
    # window × work MP — see _pick_batch_size). This call site passes
    # batch_size explicitly to every chunk, so it must apply the same
    # sizing the single-worker path gets from generate()'s default —
    # the resolution-blind call here is exactly what re-OOMed the 4k runs.
    # The coordinator has no GPU, so the caller passes the VRAM of the
    # tier it routed stereo_cls to.
    work_mp = (
        stereo_kwargs.get("work_height", 720)
        * stereo_kwargs.get("work_width", 1280) / 1e6
    )
    batch_size = _pick_batch_size(total, work_mp, vram_gb=vram_gb)
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
