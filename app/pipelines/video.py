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
      "inpaint": "propainter" | "none",
      "input_size": 980,            # depth model resolution
      "encoder": "vitl" | "vits",
      "remove_black_bars": true,
      "formats": ["sbs", "half_sbs", "anaglyph", "tb", "half_tb"],
      "include_audio": true,
      "output_depth": true
    }
    """
    from app.stages.media import encode_outputs, preprocess_video, publish_file
    from app.stages.video_depth import VideoDepthWorker
    from app.stages.video_stereo import VideoStereoWorker

    try:
        jobs.update_job(job_id, status=jobs.IN_PROGRESS, stage="preprocess", progress=0.05)

        pre = preprocess_video.remote(
            job_id,
            request["input_path"],
            remove_black_bars=request.get("remove_black_bars", True),
        )
        jobs.update_job(job_id, progress=0.15, stage="video_depth")

        fps_rational = pre["probe"].get("fps_rational")
        depth = VideoDepthWorker(encoder=request.get("encoder", "vitl")).generate.remote(
            job_id,
            pre["work_path"],
            input_size=int(request.get("input_size", 980)),
            fps_rational=fps_rational,
        )
        # frame-count invariant: any silent drop would desync audio
        if depth["num_frames"] != pre["probe"]["num_frames"]:
            raise RuntimeError(
                f"depth produced {depth['num_frames']} frames for a "
                f"{pre['probe']['num_frames']}-frame source"
            )
        jobs.update_job(job_id, progress=0.5, stage="video_stereo")

        stereo = VideoStereoWorker().generate.remote(
            job_id,
            video_path=pre["work_path"],
            depth_path=depth["depth_path"],
            displacement=float(request.get("displacement", 0.0125)),
            inpaint=request.get("inpaint", "propainter"),
            fps_rational=fps_rational,
        )
        if stereo["num_frames"] != pre["probe"]["num_frames"]:
            raise RuntimeError(
                f"stereo produced {stereo['num_frames']} frames for a "
                f"{pre['probe']['num_frames']}-frame source"
            )
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
            from app.stages.mvhevc import encode_mvhevc

            jobs.update_job(job_id, stage="encode_mvhevc", progress=0.92)
            mv = encode_mvhevc.remote(
                job_id,
                sbs_path=stereo["sbs_path"],
                original_path=pre["source_path"] if request.get("include_audio", True) else None,
                spatial=request.get("spatial"),
            )
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
            },
        )
        return {"job_id": job_id, "status": jobs.COMPLETED, "outputs": outputs}

    except Exception as exc:
        logger.exception(f"❌ video job {job_id} failed")
        jobs.update_job(job_id, status=jobs.FAILED, error=str(exc))
        raise
