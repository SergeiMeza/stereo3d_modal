"""HTTP API.

Production endpoints
    POST /v1/videos         — full 2D→3D video pipeline
    POST /v1/images         — full 2D→3D image pipeline (batch or single)
    GET  /v1/jobs/{job_id}  — poll job status / outputs / stage timings
    DELETE /v1/jobs/{job_id}— cancel a running job
    GET  /health

Experimental stage endpoints (test pipeline segments in isolation)
    POST /v1/stages/video-depth   — depth video only
    POST /v1/stages/video-stereo  — splat+inpaint from an existing depth video
    POST /v1/stages/scene-detect  — scene cut list
    POST /v1/stages/crop-detect   — black-bar geometry

All request/response bodies are plain JSON; shapes in app/api/schemas.py.
"""

import uuid
from pathlib import PurePosixPath

from fastapi import FastAPI, HTTPException

from app.common import jobs
from app.env import APP_ENV

web_app = FastAPI(title=f"stereo3d ({APP_ENV})", version="1.0")


def _require(body: dict, key: str) -> object:
    value = body.get(key)
    if value in (None, ""):
        raise HTTPException(status_code=400, detail=f"{key} is required")
    return value


# scene_overrides entry contract (POST /v1/videos). Frame doctrine
# (web/DESIGN.md): "first" is a SOURCE-frame scene start — the user's exact
# number, validated hard at submit time and never coerced downstream.
_OVERRIDE_KEYS = ("first", "displacement", "shot_type", "placement", "passthrough")


def _validate_scene_overrides(overrides: object, scene_cuts: list | None) -> None:
    """Validate the ``scene_overrides`` request field (422 on any problem —
    a malformed per-scene decision must never reach the pipeline, where the
    frame doctrine forces a loud job failure instead of a quick reject).

    Shape: a list of {"first": int, "displacement"?: float,
    "shot_type"?: str, "placement"?: [float, float]} — ``first`` ≥ 0,
    strictly increasing across entries, and (when ``scene_cuts`` is also
    in the request) 0 or one of the scene_cuts values, since those ARE the
    job's scene starts. Each entry must carry at least one override field;
    unknown keys are rejected so a typo can't silently no-op."""
    from app.stages.video_depth_models import SHOT_PARAMS

    def bad(msg: str):
        return HTTPException(status_code=422, detail=msg)

    if not isinstance(overrides, list) or not all(isinstance(o, dict) for o in overrides):
        raise bad("scene_overrides must be a list of objects")
    prev_first = -1
    for i, ov in enumerate(overrides):
        unknown = sorted(set(ov) - set(_OVERRIDE_KEYS))
        if unknown:
            raise bad(
                f"scene_overrides[{i}]: unknown key(s) {unknown} "
                f"(allowed: {', '.join(_OVERRIDE_KEYS)})"
            )
        first = ov.get("first")
        if not isinstance(first, int) or isinstance(first, bool) or first < 0:
            raise bad(f"scene_overrides[{i}].first must be a non-negative int (source-frame scene start)")
        if first <= prev_first:
            raise bad(f"scene_overrides[{i}].first must be strictly increasing (got {first} after {prev_first})")
        prev_first = first
        if scene_cuts is not None and first != 0 and first not in scene_cuts:
            raise bad(
                f"scene_overrides[{i}].first={first} is not a scene start "
                f"(must be 0 or one of scene_cuts)"
            )
        if not any(k in ov for k in ("displacement", "shot_type", "placement", "passthrough")):
            raise bad(
                f"scene_overrides[{i}] must set at least one of "
                f"displacement/shot_type/placement/passthrough"
            )
        if "passthrough" in ov:
            if not isinstance(ov["passthrough"], bool):
                raise bad(f"scene_overrides[{i}].passthrough must be a boolean")
            # passthrough ships the scene as 2D — depth knobs on the same
            # entry would silently do nothing, so reject the combination
            if ov["passthrough"] and any(k in ov for k in ("displacement", "shot_type", "placement")):
                raise bad(
                    f"scene_overrides[{i}]: passthrough cannot be combined "
                    f"with displacement/shot_type/placement"
                )
        if "displacement" in ov:
            d = ov["displacement"]
            if isinstance(d, bool) or not isinstance(d, (int, float)) or not (0.0 < float(d) <= 0.1):
                raise bad(f"scene_overrides[{i}].displacement must be a number in (0, 0.1]")
        if "shot_type" in ov and ov["shot_type"] not in SHOT_PARAMS:
            raise bad(
                f"scene_overrides[{i}].shot_type must be one of {tuple(SHOT_PARAMS)}"
            )
        if "placement" in ov:
            p = ov["placement"]
            if (
                not isinstance(p, (list, tuple)) or len(p) != 2
                or any(isinstance(v, bool) or not isinstance(v, (int, float)) for v in p)
                or not all(-1.5 <= float(v) <= 1.5 for v in p)
                or not float(p[0]) < float(p[1])
            ):
                raise bad(
                    f"scene_overrides[{i}].placement must be [far, near] floats "
                    f"in [-1.5, 1.5] with far < near"
                )


def _submit(kind: str, body: dict, spawner) -> dict:
    job_id = uuid.uuid4().hex[:12]
    jobs.create_job(job_id, kind, body)
    call = spawner(job_id)
    jobs.update_job(job_id, call_id=call.object_id)
    return {"job_id": job_id, "status": jobs.PENDING, "status_url": f"/v1/jobs/{job_id}"}


# ------------------------------------------------------------- health

@web_app.get("/health")
async def health() -> dict:
    return {"status": "ok", "env": APP_ENV}


# ---------------------------------------------------------- pipelines

@web_app.post("/v1/analyze")
async def submit_analyze(body: dict) -> dict:
    """Pro step-pipeline entry (web/DESIGN.md): probe + crop detect + scene
    detect + filmstrip thumbnails on the SOURCE file. CPU-only, cheap. All
    frame indices in the result metadata are source-frame space, directly
    usable as ``scene_cuts`` on POST /v1/videos."""
    from app.pipelines.analyze import MAX_STRIP_COUNT, process_analyze_job

    _require(body, "input_path")
    strip_count = body.get("strip_count")
    if strip_count is not None:
        if not isinstance(strip_count, int) or isinstance(strip_count, bool) \
                or not (10 <= strip_count <= MAX_STRIP_COUNT):
            raise HTTPException(
                status_code=400,
                detail=f"strip_count must be an int in [10, {MAX_STRIP_COUNT}]",
            )
    return _submit("analyze", body, lambda job_id: process_analyze_job.spawn(job_id, body))


@web_app.post("/v1/profile")
async def submit_profile(body: dict) -> dict:
    """Standalone shot-profiling job: run the adaptive ShotProfiler over a
    frame-exact 1:1 proxy (the analyze job's preview) + the CURRENT scene
    cuts, without a paid conversion. Result metadata carries a depth_script
    whose first_src/last_src are identities (proxy is 1:1 with the source).
    GPU-light: statistics at input_size=518 from a few keyframes per scene."""
    from app.pipelines.analyze import process_profile_job

    _require(body, "input_path")
    cuts = body.get("scene_cuts")
    if cuts is not None:
        if (
            not isinstance(cuts, list)
            or any(isinstance(c, bool) or not isinstance(c, int) or c <= 0 for c in cuts)
            or cuts != sorted(set(cuts))
        ):
            raise HTTPException(
                status_code=422,
                detail="scene_cuts must be strictly increasing positive ints",
            )
    profiler = body.get("profiler")
    if profiler is not None and profiler not in ("da3-metric", "depth-pro"):
        raise HTTPException(
            status_code=422, detail="profiler must be da3-metric or depth-pro"
        )
    return _submit("profile", body, lambda job_id: process_profile_job.spawn(job_id, body))


@web_app.post("/v1/videos")
async def submit_video(body: dict) -> dict:
    from app.pipelines.video import process_video_job

    _require(body, "input_path")
    inpaint = body.get("inpaint", "propainter")
    if inpaint not in ("propainter", "none", "m2svid"):
        raise HTTPException(status_code=400, detail=f"invalid inpaint mode: {inpaint}")
    if body.get("stereo_mode", "both") not in ("both", "left", "right"):
        raise HTTPException(status_code=400, detail="stereo_mode must be both|left|right")
    from app.stages.video_depth_models import DEPTH_MODELS, PROFILER_MODELS

    depth_model = body.get("depth_model", "vda")
    if depth_model not in ("vda", *DEPTH_MODELS):
        raise HTTPException(
            status_code=400,
            detail=f"depth_model must be one of {('vda', *DEPTH_MODELS)}",
        )
    # input_size must be a multiple of 14 (the depth model's patch size). The
    # UPPER bound here is just a sanity rail — the REAL VRAM limit is enforced
    # downstream by _route_depth_gpu (working-MP, aspect-aware: rejects >B200's
    # 8.5 MP). 2520 lets a SQUARER aspect (e.g. 4:3) reach B200, which a flat
    # 2100 cap blocked (4:3 @ 2100 = only 5.88 MP → H200; needs ~2212+ for B200).
    input_size = int(body.get("input_size", 980))
    if input_size % 14 != 0 or not (140 <= input_size <= 2520):
        raise HTTPException(status_code=400, detail="input_size must be a multiple of 14 in [140, 2520]")
    displacement = float(body.get("displacement", 0.0125))
    if not (0.0 < displacement <= 0.1):
        raise HTTPException(status_code=400, detail="displacement must be in (0, 0.1]")
    # target_fps (v7): decimate to fewer fps (cap at source applied in
    # preprocess once the source fps is probed; here just sanity-bound it).
    target_fps = body.get("target_fps")
    if target_fps is not None and not (0.0 < float(target_fps) <= 240.0):
        raise HTTPException(status_code=400, detail="target_fps must be in (0, 240]")
    # v7 resolution knobs. depth_res aliases input_size (same ×14/[140,2520]
    # rule; the working-MP router is the real VRAM guard). output_res/
    # inpaint_res are SHORT-SIDE values in pixels; min ~540 (below that
    # depth/disparity quantization degrades), max bounded here, and
    # preprocess never upscales past the source.
    depth_res = body.get("depth_res")
    if depth_res is not None and (int(depth_res) % 14 != 0 or not (140 <= int(depth_res) <= 2520)):
        raise HTTPException(status_code=400, detail="depth_res must be a multiple of 14 in [140, 2520]")
    output_res = body.get("output_res")
    if output_res is not None and not (540 <= int(output_res) <= 4320):
        raise HTTPException(status_code=400, detail="output_res (short side) must be in [540, 4320]")
    inpaint_res = body.get("inpaint_res")
    if inpaint_res is not None:
        if not (360 <= int(inpaint_res) <= 2160):
            raise HTTPException(status_code=400, detail="inpaint_res (short side) must be in [360, 2160]")
        # never inpaint above the frame it composites into
        if output_res is not None and int(inpaint_res) > int(output_res):
            raise HTTPException(
                status_code=400,
                detail="inpaint_res must not exceed output_res (filling above the output frame is wasted)",
            )
    # content-addressed auto-reuse skip flags (v7): default OFF (auto-reuse
    # ON); set true to force a recompute of that stage. Must be bools.
    for flag in ("skip_reuse_preprocess", "skip_reuse_depth", "skip_reuse_scenes"):
        if flag in body and not isinstance(body[flag], bool):
            raise HTTPException(status_code=400, detail=f"{flag} must be a bool")
    # explicit cross-env reuse by job id (from POST /v1/reuse/lookup).
    # reuse_depth_from needs only the file; reuse_preprocess_from also needs
    # preprocess_meta (source_fps/trim/crop/fps_decimation/splat_relpath).
    for arg in ("reuse_depth_from", "reuse_preprocess_from"):
        if arg in body and body[arg] is not None and not isinstance(body[arg], str):
            raise HTTPException(status_code=400, detail=f"{arg} must be a job-id string")
    # depth_only (pro Depth step): stop after the depth stage — publish
    # depth.mp4 + depth_vis.mp4 and complete, never running stereo or the
    # output encodes. formats are ignored. The depth artifact still
    # registers in the reuse cache, so a later stereo/production run on
    # the same knobs reuses it.
    if "depth_only" in body and not isinstance(body["depth_only"], bool):
        raise HTTPException(status_code=400, detail="depth_only must be a bool")
    # user-provided depth video (pro step pipeline): a bucket key under the
    # app prefix (the gateway uploads + validates it). Replaces the depth
    # stage entirely, so it conflicts with an explicit depth reuse pointer.
    depth_source = body.get("depth_source")
    if body.get("depth_only") and depth_source is not None:
        raise HTTPException(
            status_code=400,
            detail="depth_only and depth_source are mutually exclusive "
                   "(depth_only computes the depth map; depth_source supplies one)",
        )
    if depth_source is not None:
        if not isinstance(depth_source, str) or not depth_source.strip():
            raise HTTPException(status_code=400, detail="depth_source must be a bucket key string")
        if body.get("reuse_depth_from"):
            raise HTTPException(
                status_code=400,
                detail="depth_source and reuse_depth_from are mutually exclusive "
                       "(both replace the depth stage)",
            )
    if body.get("preprocess_meta") is not None and not isinstance(body["preprocess_meta"], dict):
        raise HTTPException(status_code=400, detail="preprocess_meta must be an object")
    # explicit crop override "W:H:X:Y" (ffmpeg crop geometry) — forces a crop,
    # bypassing auto black-bar detection (for letterboxes detect_crop's
    # multi-sample conservatism misses). Requires remove_black_bars (default on).
    crop = body.get("crop")
    if crop is not None:
        parts = str(crop).removeprefix("crop=").split(":")
        if len(parts) != 4 or not all(p.lstrip("-").isdigit() for p in parts):
            raise HTTPException(status_code=400, detail="crop must be 'W:H:X:Y' (four integers)")
    if body.get("reuse_preprocess_from") and body.get("preprocess_meta") is None:
        raise HTTPException(
            status_code=400,
            detail="reuse_preprocess_from requires preprocess_meta (get both from "
                   "POST /v1/reuse/lookup)",
        )
    # user-edited scene cuts (pro step pipeline): SOURCE-frame indices, each
    # the first frame of a new scene, strictly increasing, > 0 (frame 0 opens
    # the first scene implicitly). Bypasses scene detection AND the scenes
    # reuse cache; the pipeline maps them through trim + fps decimation to
    # work-file boundaries (one mapping implementation, server-side).
    scene_cuts = body.get("scene_cuts")
    if scene_cuts is not None:
        if (
            not isinstance(scene_cuts, list)
            or not all(isinstance(c, int) and not isinstance(c, bool) for c in scene_cuts)
            or any(c <= 0 for c in scene_cuts)
            or any(b <= a for a, b in zip(scene_cuts, scene_cuts[1:]))
        ):
            raise HTTPException(
                status_code=400,
                detail="scene_cuts must be a strictly increasing list of source-frame "
                       "indices > 0 (each the first frame of a new scene)",
            )
    # user per-scene stereo overrides (pro step pipeline): keyed by
    # SOURCE-frame scene start, same space as scene_cuts. Works with or
    # without adaptive (both stereo backends thread scene_params through
    # their sequential AND parallel paths, so no inpaint/parallel
    # restriction applies). Validated hard here — see the helper.
    if body.get("scene_overrides") is not None:
        _validate_scene_overrides(body["scene_overrides"], scene_cuts)
    # adaptive per-shot depth script (R&D prototype): sequential
    # ProPainter/none path only — reject unsupported combinations at
    # submit time so the job doesn't fail minutes in
    adaptive = bool(body.get("adaptive", False))
    profiler = body.get("profiler")
    if profiler is not None and not adaptive:
        raise HTTPException(
            status_code=400,
            detail="profiler is only meaningful with adaptive=true",
        )
    if profiler is not None and profiler not in PROFILER_MODELS:
        raise HTTPException(
            status_code=400,
            detail=f"profiler must be one of {PROFILER_MODELS}",
        )
    depth_scale = body.get("depth_scale")
    if depth_scale is not None:
        if not adaptive:
            raise HTTPException(
                status_code=400,
                detail="depth_scale is only meaningful with adaptive=true",
            )
        if not (0.3 <= float(depth_scale) <= 1.5):
            raise HTTPException(
                status_code=400, detail="depth_scale must be in [0.3, 1.5]"
            )
    # auto_comfort (default True): the profiler picks the scale that lands
    # salient disparities within comfort_budget. An explicit depth_scale
    # overrides it (enforced in the worker). Both adaptive-only.
    if "auto_comfort" in body:
        if not adaptive:
            raise HTTPException(
                status_code=400,
                detail="auto_comfort is only meaningful with adaptive=true",
            )
        if not isinstance(body["auto_comfort"], bool):
            raise HTTPException(status_code=400, detail="auto_comfort must be a bool")
    comfort_budget = body.get("comfort_budget")
    if comfort_budget is not None:
        if not adaptive:
            raise HTTPException(
                status_code=400,
                detail="comfort_budget is only meaningful with adaptive=true",
            )
        if not (0.0 < float(comfort_budget) <= 0.05):
            raise HTTPException(
                status_code=400, detail="comfort_budget must be in (0, 0.05]"
            )
    # adaptive composes with the stereo fan-out for both backends:
    # the depth script keys on absolute frame index and is passed whole
    # to every chunk worker, so parallel output matches sequential.

    return _submit("video", body, lambda job_id: process_video_job.spawn(job_id, body))


@web_app.post("/v1/images")
async def submit_images(body: dict) -> dict:
    from app.pipelines.image import process_image_job

    items = body.get("items")
    if not items:
        # single-image shorthand
        input_path = _require(body, "input_path")
        items = [{"input_path": input_path}]
        body = {**body, "items": items}
    for i, item in enumerate(items):
        if not item.get("input_path"):
            raise HTTPException(status_code=400, detail=f"items[{i}].input_path is required")
        item.setdefault("item_id", PurePosixPath(item["input_path"]).stem)
    ids = [item["item_id"] for item in items]
    if len(set(ids)) != len(ids):
        raise HTTPException(status_code=400, detail="duplicate item_id in items")

    return _submit("image", body, lambda job_id: process_image_job.spawn(job_id, body))


# --------------------------------------------------------------- jobs

@web_app.get("/v1/jobs/{job_id}")
async def job_status(job_id: str) -> dict:
    job = jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job: {job_id}")
    if job["status"] in (jobs.PENDING, jobs.IN_PROGRESS) and job.get("call_id"):
        job = _reconcile_with_call(job) or job
    return job


def _reconcile_with_call(job: dict) -> dict | None:
    """Stage jobs spawn a worker directly; pull its result into the job
    record once the FunctionCall finishes (no-op while still running).

    Custom job_ids in modal.Dict are the source of truth (7-day
    retention); FunctionCall ids only add granularity and expire after
    ~1 day, so an unreachable call must not poison the job record.
    """
    import modal

    try:
        fc = modal.FunctionCall.from_id(job["call_id"])
        result = fc.get(timeout=0)
    except TimeoutError:
        return None  # still running
    except modal.exception.NotFoundError:
        # call history expired (1-day plan limit) before the job
        # finished updating itself — keep the dict record as-is but
        # stop reconciling so stale jobs eventually surface as such
        return jobs.update_job(
            job["job_id"], call_id=None,
            error="worker call history expired before completion was recorded",
        )
    except Exception as exc:
        return jobs.update_job(job["job_id"], status=jobs.FAILED, error=str(exc))
    from app.common.errors import FAILED_KEY

    if isinstance(result, dict) and result.get(FAILED_KEY):
        return jobs.update_job(job["job_id"], status=jobs.FAILED, error=result.get("error"))
    fields = {"status": jobs.COMPLETED, "progress": 1.0}
    if isinstance(result, dict):
        fields["result"] = result
    return jobs.update_job(job["job_id"], **fields)


def _cancel_call(call_id: str) -> bool:
    """Best-effort cancel of one FunctionCall. A child may have already
    finished or aged out of call history (~1-day retention) — that's not
    an error, just nothing left to cancel."""
    import modal

    try:
        modal.FunctionCall.from_id(call_id).cancel()
        return True
    except Exception:
        return False


@web_app.delete("/v1/jobs/{job_id}")
async def cancel_job(job_id: str) -> dict:
    job = jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job: {job_id}")
    if job["status"] not in (jobs.PENDING, jobs.IN_PROGRESS):
        return job  # already terminal — nothing to cancel

    # Cancel the coordinator AND every GPU worker it spawned. Cancelling
    # the coordinator alone leaves the fan-out's spawned calls running
    # (independent FunctionCalls) — the bug this addresses. Cancel the
    # children FIRST so they can't outlive the coordinator if the
    # coordinator cancel lands a beat sooner.
    cancelled = 0
    for cid in (job.get("child_call_ids") or []):
        cancelled += _cancel_call(cid)
    if job.get("call_id"):
        _cancel_call(job["call_id"])
    jobs.update_job(
        job_id,
        status=jobs.FAILED,
        error=f"cancelled by user (cancelled {cancelled} GPU worker(s))",
        child_call_ids=[],
    )
    return jobs.get_job(job_id)


# --------------------------------------------- experimental endpoints

@web_app.post("/v1/stages/video-depth")
async def stage_video_depth(body: dict) -> dict:
    from app.stages.video_depth import VideoDepthWorker
    from app.stages.video_depth_models import DEPTH_MODELS, FrameDepthWorker

    input_path = _require(body, "input_path")
    input_size = int(body.get("input_size", 980))
    encoder = body.get("encoder", "vitl")
    depth_model = body.get("depth_model", "vda")
    if depth_model not in ("vda", *DEPTH_MODELS):
        raise HTTPException(
            status_code=400,
            detail=f"depth_model must be one of {('vda', *DEPTH_MODELS)}",
        )

    def spawn(job_id: str):
        from app.common.storage import bucket_path

        if depth_model != "vda":
            return FrameDepthWorker(model_name=depth_model).generate.spawn(
                job_id, str(bucket_path(input_path)), input_size=input_size
            )
        return VideoDepthWorker(encoder=encoder).generate.spawn(
            job_id, str(bucket_path(input_path)), input_size=input_size
        )

    return _submit("stage:video-depth", body, spawn)


@web_app.post("/v1/stages/video-stereo")
async def stage_video_stereo(body: dict) -> dict:
    from app.stages.video_stereo import VideoStereoWorker
    from app.stages.video_stereo_m2svid import M2SVidStereoWorker

    video_path = _require(body, "video_path")
    depth_path = _require(body, "depth_path")
    inpaint = body.get("inpaint", "propainter")
    if inpaint not in ("propainter", "none", "m2svid"):
        raise HTTPException(status_code=400, detail=f"invalid inpaint mode: {inpaint}")

    def spawn(job_id: str):
        if inpaint == "m2svid":
            return M2SVidStereoWorker().generate.spawn(
                job_id,
                video_path=video_path,
                depth_path=depth_path,
                displacement=float(body.get("displacement", 0.0125)),
            )
        return VideoStereoWorker().generate.spawn(
            job_id,
            video_path=video_path,
            depth_path=depth_path,
            displacement=float(body.get("displacement", 0.0125)),
            inpaint=inpaint,
        )

    return _submit("stage:video-stereo", body, spawn)


@web_app.post("/v1/stages/encode-mvhevc")
async def stage_encode_mvhevc(body: dict) -> dict:
    from app.stages.mvhevc import encode_mvhevc, encode_mvhevc_x265

    sbs_path = _require(body, "sbs_path")
    if body.get("encoder") == "nvenc":
        spawner = lambda job_id: encode_mvhevc.spawn(
            job_id, sbs_path=sbs_path,
            quality=int(body.get("quality", 28)), spatial=body.get("spatial"),
        )
    else:  # x265 default: the only path Apple recognizes as spatial
        spawner = lambda job_id: encode_mvhevc_x265.spawn(
            job_id, sbs_path=sbs_path,
            crf=int(body.get("crf", 23)), preset=body.get("preset", "medium"),
            spatial=body.get("spatial"),
        )
    return _submit("stage:encode-mvhevc", body, spawner)


@web_app.post("/v1/reuse/lookup")
async def reuse_lookup(body: dict) -> dict:
    """Check the content-addressed reuse cache for a given video request,
    WITHOUT submitting a job. Computes the same preprocess/depth/scenes keys
    the pipeline would, reads the per-env reuse Dict, and reports any cached
    artifacts. Use the returned depth ``job_id`` as ``reuse_depth_from`` to
    skip the depth pass — that path reads the published GCS artifact under
    the shared R&D prefix, so it works ACROSS environments (the reuse Dict
    is per-env, but reuse_depth_from is not). No GCS existence check here;
    the entry reflects what was registered.

    Body: the SAME fields as POST /v1/videos that affect the keys
    (input_path required; preset, remove_black_bars, output_res,
    target_height, target_fps, trim, depth_res/input_size, depth_model,
    encoder, scene_cuts, crop optional). The keys come from the pipeline's
    OWN derivation (reuse_request_keys: preset merge + aliases included),
    so passing the exact submit body here yields the keys the job will
    use — a raw-body derivation could never match a preset run."""
    from app.common import reuse
    from app.pipelines.video import depth_lookup_keys, reuse_request_keys

    _require(body, "input_path")
    # (the depth key from this triple is depth_lookup_keys(body)[0])
    pp_key, _d_key, s_key = reuse_request_keys(body)

    def _entry(key):
        e = reuse.peek(key)
        if not e:
            return {"key": key, "cached": False}
        return {
            "key": key, "cached": True, "job_id": e.get("job_id"),
            "gcs_relpath": e.get("gcs_relpath"), "created_at": e.get("created_at"),
            "meta": e.get("meta", {}),
        }

    # depth: same candidate order the pipeline uses — the exact key, then
    # (with passthrough scenes) the no-passthrough BASE key, so this
    # endpoint predicts exactly what the job will reuse and the gateway's
    # quote discount matches the actual compute.
    depth = None
    for candidate in depth_lookup_keys(body):
        depth = _entry(candidate)
        if depth["cached"]:
            break
    pp, scenes = _entry(pp_key), _entry(s_key)
    return {
        "env": APP_ENV,
        "preprocess": pp,
        "depth": depth,
        "scenes": scenes,
        # the convenient cross-env skip: pass this as reuse_depth_from
        "reuse_depth_from": depth.get("job_id") if depth["cached"] else None,
    }


@web_app.post("/v1/stages/scene-detect")
async def stage_scene_detect(body: dict) -> dict:
    from app.stages.media import detect_scenes

    input_path = _require(body, "input_path")
    return _submit("stage:scene-detect", body, lambda job_id: detect_scenes.spawn(input_path))


@web_app.post("/v1/stages/crop-detect")
async def stage_crop_detect(body: dict) -> dict:
    from app.stages.media import preprocess_video

    input_path = _require(body, "input_path")
    return _submit(
        "stage:crop-detect",
        body,
        lambda job_id: preprocess_video.spawn(job_id, input_path, remove_black_bars=True),
    )
