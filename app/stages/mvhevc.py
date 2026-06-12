"""MV-HEVC encoding for Apple Vision Pro (experimental).

Converts a full-width SBS master into a two-view MV-HEVC .mov using
NVENC on an L4 (verified: ffmpeg 8.1 `hevc_nvenc -profile:v mv` works
on Modal's driver 580 hosts; B200/H100/H200/A100 have no NVENC).

Current output is a playable MV-HEVC (Multiview Main) file. The extra
`vexu` spatial metadata that makes Photos treat it as "spatial video"
is a planned follow-up (Linux-side atom injection); third-party AVP
players handle plain MV-HEVC already.
"""

import json
import subprocess
import tempfile
from pathlib import Path

import modal

from app.common import jobs
from app.common.debug import get_logger
from app.common.storage import PIPELINE_VOLUMES, cache_volume, job_output_dir, public_url
from app.images import nvenc_image
from app.modal_app import app

logger = get_logger(__name__)

MVHEVC_GPU = "L4"


@app.function(
    image=nvenc_image,
    gpu=MVHEVC_GPU,
    volumes=PIPELINE_VOLUMES,
    cpu=4,
    memory=(2 * 1024, 16 * 1024),
    timeout=3600,
)
def encode_mvhevc(
    job_id: str,
    sbs_path: str,
    quality: int = 28,
    original_path: str | None = None,
) -> dict:
    """Encode a full-width SBS video into MV-HEVC. Returns the public
    URL of the .mov plus stream info for verification."""
    cache_volume.reload()
    sbs = Path(sbs_path)
    if not sbs.exists():
        raise FileNotFoundError(sbs)

    out_dir = job_output_dir(job_id)

    with jobs.stage_timer(job_id, "encode_mvhevc", gpu=MVHEVC_GPU, quality=quality):
        with tempfile.TemporaryDirectory() as tmp:
            local = Path(tmp) / "mvhevc.mov"
            # split SBS into left/right eyes, interleave as frame-sequence
            # stereo, encode two views with NVENC's multiview profile
            cmd = [
                "ffmpeg8", "-y", "-hide_banner", "-loglevel", "warning",
                "-i", str(sbs),
            ]
            audio_args = []
            if original_path and Path(original_path).exists():
                cmd += ["-i", str(original_path)]
                audio_args = ["-map", "1:a?", "-c:a", "aac", "-shortest"]
            cmd += [
                "-filter_complex",
                "[0:v]crop=iw/2:ih:0:0[left];[0:v]crop=iw/2:ih:iw/2:0[right];"
                "[left][right]framepack=frameseq[v]",
                "-map", "[v]", *audio_args,
                "-c:v", "hevc_nvenc", "-profile:v", "mv", "-tune", "hq",
                "-rc", "vbr", "-cq", str(quality), "-b_ref_mode", "0",
                "-tag:v", "hvc1", "-movflags", "+faststart",
                str(local),
            ]
            result = subprocess.run(cmd, capture_output=True, text=True)
            if result.returncode != 0:
                raise RuntimeError(f"MV-HEVC encode failed: {result.stderr[-2000:]}")

            info = subprocess.run(
                ["ffprobe8", "-v", "error", "-show_entries",
                 "stream=codec_name,profile,width,height", "-of", "json", str(local)],
                capture_output=True, text=True,
            ).stdout
            dst = out_dir / "mvhevc.mov"
            dst.write_bytes(local.read_bytes())

    return {
        "mvhevc": public_url(dst),
        "streams": json.loads(info).get("streams", []),
    }
