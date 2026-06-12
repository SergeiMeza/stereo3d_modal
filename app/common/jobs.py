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
    job.update(fields)
    job["updated_at"] = time.time()
    job_dict[job_id] = job
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
