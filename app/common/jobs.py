"""Job state tracking backed by modal.Dict.

All job metadata is plain JSON-serializable dicts (no Pydantic — schema
drift in libraries silently broke class-validated payloads in the old
project). Shape documented in app/api/schemas.py via TypedDicts, which
are type hints only and never validate at runtime.

Every stage appends to ``timings`` so each completed job doubles as a
benchmark sample: ``{"stage": ..., "seconds": ..., "gpu": ...,
"detail": {...}}``.
"""

import time

import modal

from app.env import APP_ENV

job_dict = modal.Dict.from_name(f"stereo3d-jobs-{APP_ENV}", create_if_missing=True)

# Job statuses
PENDING = "pending"
IN_PROGRESS = "in_progress"
COMPLETED = "completed"
FAILED = "failed"


def create_job(job_id: str, kind: str, request: dict) -> dict:
    job = {
        "job_id": job_id,
        "kind": kind,  # "image" | "video" | a stage name
        "notify": bool(request.get("notify", True)),  # Slack lifecycle messages
        "status": PENDING,
        "created_at": time.time(),
        "updated_at": time.time(),
        "request": request,
        "stage": None,  # current pipeline stage name
        "progress": 0.0,
        "timings": [],  # per-stage benchmark records
        "outputs": {},  # name -> public URL
        "error": None,
    }
    job_dict[job_id] = job
    return job


def get_job(job_id: str) -> dict | None:
    return job_dict.get(job_id)


def update_job(job_id: str, **fields) -> dict | None:
    job = job_dict.get(job_id)
    if job is None:
        return None
    old = dict(job)
    job.update(fields)
    job["updated_at"] = time.time()
    job_dict[job_id] = job

    from app.common.notify import job_event

    job_event(old, job)  # Slack lifecycle messages (no-op without webhook)
    return job


def add_timing(job_id: str, stage: str, seconds: float, gpu: str | None = None, **detail):
    job = job_dict.get(job_id)
    if job is None:
        return
    job["timings"].append(
        {"stage": stage, "seconds": round(seconds, 3), "gpu": gpu, "detail": detail}
    )
    job["updated_at"] = time.time()
    job_dict[job_id] = job


def report_progress(
    job_id: str,
    stage: str,
    done: int,
    total: int,
    rate_per_s: float | None = None,
    band: tuple[float, float] = (0.0, 1.0),
    chunk: str | int | None = None,
) -> None:
    """Structured progress for client apps polling GET /v1/jobs/{id}.

    ``band`` maps stage-local progress into the job's overall progress
    range (e.g. the e2e video pipeline gives depth (0.15, 0.5) and
    stereo (0.5, 0.85)); standalone stage jobs use the full (0, 1).

    ``chunk``: long-video fan-out workers pass their chunk key and
    chunk-local ``done`` (with job-wide ``total``); progress is then
    aggregated across chunks so it stays monotonic instead of
    interleaving the parallel workers' positions.
    """
    if total <= 0:
        return
    extra: dict = {}
    if chunk is not None:
        job = job_dict.get(job_id)
        if job is None:
            return
        prefix = stage.split("[")[0]
        if job.get("agg_stage") != prefix:  # new fan-out stage: reset
            extra["agg_stage"] = prefix
            extra["agg_started_at"] = time.time()
            chunk_progress = {}
        else:
            chunk_progress = dict(job.get("chunk_progress") or {})
        chunk_progress[str(chunk)] = done
        extra["chunk_progress"] = chunk_progress
        done = sum(chunk_progress.values())
        started = extra.get("agg_started_at") or job.get("agg_started_at") or time.time()
        rate_per_s = done / max(time.time() - started, 1e-6)
        stage = prefix
    frac = min(1.0, done / total)
    detail = {"stage": stage, "done": done, "total": total, "unit": "frames"}
    if rate_per_s and rate_per_s > 0:
        detail["rate_per_s"] = round(rate_per_s, 2)
        detail["eta_seconds"] = round((total - done) / rate_per_s)
    update_job(
        job_id,
        progress=round(band[0] + (band[1] - band[0]) * frac, 3),
        progress_detail=detail,
        **extra,
    )


class stage_timer:
    """Context manager: times a stage, records it on the job, sets the
    job's current stage marker, and logs start/finish so the container
    log stream alone tells the pipeline story.

    with stage_timer(job_id, "video_depth", gpu="L40S", frames=240):
        ...
    """

    def __init__(self, job_id: str, stage: str, gpu: str | None = None, **detail):
        from app.common.debug import job_logger

        self.job_id = job_id
        self.stage = stage
        self.gpu = gpu
        self.detail = detail
        self.log = job_logger(job_id)

    def __enter__(self):
        self.start = time.perf_counter()
        update_job(self.job_id, stage=self.stage, status=IN_PROGRESS)
        self.log.info(f"▶ {self.stage} started ({self.detail or ''})")
        return self

    def __exit__(self, exc_type, exc, tb):
        seconds = time.perf_counter() - self.start
        self.detail["failed"] = exc is not None
        add_timing(self.job_id, self.stage, seconds, gpu=self.gpu, **self.detail)
        if exc is None:
            self.log.info(f"✔ {self.stage} finished in {seconds:.1f}s")
        else:
            self.log.error(f"✖ {self.stage} failed after {seconds:.1f}s: {exc}")
        return False
