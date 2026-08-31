"""End-to-end still-image pipeline orchestrator (thin: the GPU worker
does everything; this wraps job bookkeeping)."""

from app.common import jobs
from app.common.debug import get_logger
from app.common.storage import PIPELINE_VOLUMES, slack_secret
from app.images import media_image
from app.modal_app import app

logger = get_logger(__name__)


@app.function(
    image=media_image,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    cpu=1,
    memory=(512, 4 * 1024),
    timeout=2 * 3600,
    nonpreemptible=True,
)
def process_image_job(job_id: str, request: dict) -> dict:
    """request:
    {
      "items": [{"item_id": "img1", "input_path": "inputs/samples/x.jpg", ...}],
      # per-item options (also accepted top-level as defaults):
      "displacement": 0.01,
      "stereo_mode": "both" | "left" | "right",
      "warp": "forward" | "backward",   # forward = splat + fill
                                        # (default); backward = gather,
                                        # no inpainting
      "inpaint": "lama" | "migan" | "none",   # forward-warp fill model
                                        # (default lama); migan = the
                                        # mobile app's on-device model
      "formats": ["lr", "tb", "half_lr", "half_tb", "anaglyph"],
      "output_depthmap": true,
      "remove_black_bars": true
    }
    """
    from app.common.debug import job_logger
    from app.common.errors import check_worker_result
    from app.stages.image_stereo import ImageStereoWorker

    jlog = job_logger(job_id)

    defaults = {
        k: request[k]
        for k in ("displacement", "stereo_mode", "warp", "inpaint", "formats", "output_depthmap", "remove_black_bars")
        if k in request
    }
    items = [{**defaults, **item} for item in request["items"]]

    try:
        jlog.info(
            f"🎯 image job started: {len(items)} item(s), "
            f"formats={defaults.get('formats', ['lr'])}"
        )
        jobs.update_job(job_id, status=jobs.IN_PROGRESS, stage="image_stereo")
        result = ImageStereoWorker().process_batch.remote(job_id, items)
        check_worker_result(result, "image_stereo")
        jlog.info(f"📋 batch done: {result['completed']} ok, {result['failed']} failed")

        status = jobs.COMPLETED if result["failed"] == 0 else (
            jobs.COMPLETED if result["completed"] > 0 else jobs.FAILED
        )
        jobs.update_job(
            job_id,
            status=status,
            stage=None,
            progress=1.0,
            outputs={k: v.get("outputs", {}) for k, v in result["results"].items()},
            error=None if result["failed"] == 0 else f"{result['failed']} item(s) failed",
        )
        jlog.info(f"🏁 job {status}")
        return {"job_id": job_id, "status": status, **result}

    except Exception as exc:
        logger.exception(f"❌ image job {job_id} failed")
        jobs.update_job(job_id, status=jobs.FAILED, error=str(exc))
        raise
