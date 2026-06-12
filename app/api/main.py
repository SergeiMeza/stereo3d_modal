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
    input_size = int(body.get("input_size", 980))
    if input_size % 14 != 0 or not (140 <= input_size <= 2100):
        raise HTTPException(status_code=400, detail="input_size must be a multiple of 14 in [140, 2100]")
    displacement = float(body.get("displacement", 0.0125))
    if not (0.0 < displacement <= 0.1):
        raise HTTPException(status_code=400, detail="displacement must be in (0, 0.1]")
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
    if adaptive:
        if inpaint == "m2svid":
            raise HTTPException(
                status_code=400,
                detail="adaptive=true is not supported with inpaint='m2svid' yet",
            )
        if body.get("parallel"):
            raise HTTPException(
                status_code=400,
                detail="adaptive=true is not supported with parallel=true yet",
            )

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


@web_app.delete("/v1/jobs/{job_id}")
async def cancel_job(job_id: str) -> dict:
    import modal

    job = jobs.get_job(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail=f"unknown job: {job_id}")
    call_id = job.get("call_id")
    if call_id and job["status"] in (jobs.PENDING, jobs.IN_PROGRESS):
        modal.FunctionCall.from_id(call_id).cancel()
        jobs.update_job(job_id, status=jobs.FAILED, error="cancelled by user")
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
