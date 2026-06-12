"""Video depth worker (GPU).

Wraps DepthProcessor in a Modal class. Depth videos are written to the
cache volume at the model's working resolution (gray16le); downstream
stages upsample to the source resolution.
"""

import time
from pathlib import Path

import modal

from app.common import jobs
from app.common.errors import fail_fast
from app.common.debug import get_logger
from app.common.storage import GPU_VOLUMES, cache_volume, hf_secret, slack_secret, job_cache_dir, safe_reload
from app.env import SCALEDOWN_WINDOW
from app.images import video_depth_image
from app.modal_app import app

logger = get_logger(__name__)

VIDEO_DEPTH_GPU = "L40S"

with video_depth_image.imports():
    import torch

    from app.common.weights import ensure_video_depth_anything
    from app.stages.depth_processor import DepthProcessor, load_video_depth_model


@app.cls(
    gpu=VIDEO_DEPTH_GPU,
    image=video_depth_image,
    volumes=GPU_VOLUMES,
    secrets=[hf_secret, slack_secret],
    cpu=4,
    memory=(4 * 1024, 128 * 1024),
    timeout=3600,
    scaledown_window=SCALEDOWN_WINDOW,
    retries=modal.Retries(max_retries=2, initial_delay=10.0, backoff_coefficient=2.0),
)
class VideoDepthWorker:
    encoder: str = modal.parameter(default="vitl")

    @modal.enter()
    def load(self) -> None:
        start = time.perf_counter()
        checkpoint = ensure_video_depth_anything(self.encoder)
        self.model = load_video_depth_model(checkpoint, self.encoder)
        logger.info(f"🚀 VideoDepthAnything-{self.encoder} loaded in {time.perf_counter() - start:.1f}s")

    @modal.exit()
    def flush(self) -> None:
        # also runs on preemption (30s grace): persist finished scene
        # segments so the retried call can resume instead of restarting
        cache_volume.commit()

    @modal.method()
    @fail_fast
    def generate(
        self,
        job_id: str,
        input_path: str,
        input_size: int = 980,
        fp32: bool = False,
        fps_rational: str | None = None,
    ) -> dict:
        """Compute a depth video for ``input_path`` (a path inside the
        cache volume or bucket mount). Returns metadata including the
        cache-volume path of the gray16le depth video.

        Resumable: scene segments completed before a preemption are
        skipped on the retried call."""
        safe_reload(cache_volume)  # pick up files written by upstream stages
        src = Path(input_path)
        if not src.exists():
            raise FileNotFoundError(f"input video not found: {src}")

        out = job_cache_dir(job_id) / "depth.mp4"

        with jobs.stage_timer(job_id, "video_depth", gpu=VIDEO_DEPTH_GPU, input_size=input_size):
            processor = DepthProcessor(src, self.model, input_size=input_size, fp32=fp32)
            result = processor.write_depth_video(
                out,
                fps_rational=fps_rational,
                on_scene_done=lambda first, last: cache_volume.commit(),
            )

        cache_volume.commit()
        del processor  # drop decoder file handles before the next input
        torch.cuda.empty_cache()

        return {
            "depth_path": str(out),
            "num_frames": result.num_frames,
            "fps": result.fps,
            "source_shape": list(result.source_shape),
            "depth_shape": list(result.depth_shape),
            "scene_cuts": result.scene_cuts,
        }
