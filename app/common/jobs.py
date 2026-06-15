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

# Resources reserved per stage, for cost estimation. Keyed by stage-name
# PREFIX (the part before "[" — stages fan out as "video_depth[0:240]",
# "image[item3]", so we match the prefix, mirroring report_progress's
# stage.split("[")[0]). Each value is (cpu_cores, mem_gib) where mem_gib
# is the CEILING — the limit half of each @app.function's
# memory=(request, limit). These MUST track the decorators; if you change
# a function's cpu=/memory=, update the matching row here.
#
# GPU is NOT in this table — stage_timer already receives the live GPU
# name (torch.cuda.get_device_name), which is more accurate than a static
# map (H200/H100 routing varies per run).
STAGE_RESOURCES: dict[str, tuple[int, int]] = {
    "video_depth": (4, 128),         # video_depth.py, video_depth_models.py
    "profile_scenes": (4, 128),      # video_depth_models.py (scene profiling)
    "video_stereo": (4, 128),        # video_stereo.py + m2svid (both 4/128)
    "encode_mvhevc": (4, 16),        # mvhevc.py NVENC path
    "encode_mvhevc_x265": (32, 32),  # mvhevc.py x265 (cpu=32, mem ceil 32G)
    "image": (2, 32),                # image_stereo.py
    "preprocess": (4, 16),           # media.py preprocess
    "encode_outputs": (4, 16),       # media.py encode_outputs
}


def stage_resources(stage: str) -> tuple[int | None, int | None]:
    """(cpu_cores, mem_gib) reserved for a stage, by name prefix. Returns
    (None, None) for stages absent from STAGE_RESOURCES so cost still
    captures GPU+seconds without inventing CPU/mem numbers."""
    prefix = stage.split("[")[0]
    return STAGE_RESOURCES.get(prefix, (None, None))

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

    # On the first transition into COMPLETED, roll up per-stage costs into
    # a final cost.yaml in GCS and stash the summary on the job so Slack
    # (and API consumers) can read it without recomputing. Best-effort: a
    # storage hiccup must not fail the job. Done here (not in notify) so the
    # yaml is written even when Slack notify is off.
    if job.get("status") == COMPLETED and old.get("status") != COMPLETED:
        try:
            from app.common.cost_report import write_final_cost

            job["cost_summary"] = write_final_cost(job_id, job.get("timings") or [])
        except Exception as exc:  # pragma: no cover - best effort
            from app.common.debug import get_logger

            get_logger(__name__).warning(f"final cost yaml skipped: {exc}")

    job_dict[job_id] = job

    from app.common.notify import job_event

    job_event(old, job)  # Slack lifecycle messages (no-op without webhook)
    return job


def register_child_calls(job_id: str, call_ids: list[str]) -> None:
    """Record the FunctionCall ids of GPU workers a coordinator spawned.

    Cancelling the coordinator's own call_id does NOT propagate to calls
    it spawned via .spawn() — they are independent FunctionCalls. So the
    fan-out stages register their per-chunk worker ids here, and
    cancel_job (DELETE /v1/jobs/{id}) cancels every one of them, not just
    the coordinator. Appends (a job may run depth then stereo fan-outs);
    clear_child_calls resets between stages so we never try to cancel an
    already-finished call."""
    job = job_dict.get(job_id)
    if job is None:
        return
    existing = list(job.get("child_call_ids") or [])
    existing.extend(cid for cid in call_ids if cid and cid not in existing)
    job["child_call_ids"] = existing
    job["updated_at"] = time.time()
    job_dict[job_id] = job


def clear_child_calls(job_id: str) -> None:
    """Drop the recorded child-call ids (e.g. after a fan-out stage's
    gather returns and those workers are no longer running)."""
    job = job_dict.get(job_id)
    if job is None:
        return
    if job.get("child_call_ids"):
        job["child_call_ids"] = []
        job["updated_at"] = time.time()
        job_dict[job_id] = job


def add_timing(job_id: str, stage: str, seconds: float, gpu: str | None = None, **detail):
    from app.common.pricing import estimate_cost

    job = job_dict.get(job_id)
    if job is None:
        return
    cpu, mem_gib = stage_resources(stage)
    cost = estimate_cost(seconds, gpu=gpu, cpu=cpu, mem_gib=mem_gib)
    job["timings"].append(
        {
            "stage": stage,
            "seconds": round(seconds, 3),
            "gpu": gpu,
            "cost": cost,
            "detail": detail,
        }
    )
    job["updated_at"] = time.time()
    job_dict[job_id] = job

    # Drop a per-stage cost YAML next to this job's outputs (depth/sbs/...).
    # Best-effort: a storage hiccup must never fail the pipeline.
    try:
        from app.common.cost_report import write_stage_cost

        write_stage_cost(job_id, stage, cost, detail)
    except Exception as exc:  # pragma: no cover - best effort
        from app.common.debug import get_logger

        get_logger(__name__).warning(f"stage cost yaml skipped ({stage}): {exc}")


def clear_chunk_progress_key(job_id: str, chunk_key) -> None:
    """Drop a single chunk's entry from the job's ``chunk_progress`` map.

    The watchdog calls this when it RESUBMITS a hung chunk: the old
    (cancelled) worker may have left a stale ``chunk_progress[key]`` value
    behind, and the resubmitted worker reuses the SAME key (frame_range).
    Without clearing it, the watchdog would see the key already present,
    flip the chunk to 'started', and run its stall clock against the stale
    value WHILE the resubmitted container is still queued — a resubmit
    death-spiral. Clearing makes 'key not in chunk_progress' true again
    until the fresh worker emits its first real heartbeat."""
    job = job_dict.get(job_id)
    if job is None:
        return
    cp = job.get("chunk_progress")
    if cp and str(chunk_key) in cp:
        cp = dict(cp)
        del cp[str(chunk_key)]
        job["chunk_progress"] = cp
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
