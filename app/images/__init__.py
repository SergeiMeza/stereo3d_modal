"""Per-stage Modal images.

One image per pipeline segment instead of a monolith:

- ``web_image``          — FastAPI gateway, no ML deps
- ``media_image``        — CPU media work: probing, black-bar detection,
                           scene detection, ffmpeg encodes/muxing
- ``video_depth_image``  — VideoDepthAnything (no warp, no inpainting)
- ``stereo_image``       — Forward-Warp splatting + ProPainter video
                           inpainting
- ``image_stereo_image`` — DepthAnything v2 + Forward-Warp + LAMA for
                           still images (one A10G container runs the
                           whole still-image pipeline)
"""

import modal

from app.images.common import PYTHON_VERSION, cuda_torch_base, with_forward_warp

# ---------------------------------------------------------------- web
web_image = (
    modal.Image.debian_slim(python_version=PYTHON_VERSION)
    .uv_pip_install("fastapi[standard]==0.115.12")
    .add_local_python_source("app")
)

# -------------------------------------------------------------- media
media_image = (
    modal.Image.debian_slim(python_version=PYTHON_VERSION)
    .apt_install("ffmpeg")
    .uv_pip_install(
        "numpy==2.2.6",
        "opencv-python-headless==4.11.0.86",
        "scenedetect==0.6.6",
        "ffmpeg-python==0.2.0",
        "tqdm==4.67.1",
    )
    .add_local_python_source("app")
)

# -------------------------------------------------------- video depth
video_depth_image = (
    cuda_torch_base()
    .uv_pip_install(
        "easydict==1.13",
        "matplotlib==3.10.3",
        "scenedetect==0.6.6",
    )
    .add_local_python_source("app")
)

# ------------------------------------------- stereo (splat + inpaint)
stereo_image = (
    with_forward_warp(cuda_torch_base().uv_pip_install("matplotlib==3.10.3"))
    .add_local_python_source("app")
)

# ------------------------------------------------ nvenc (MV-HEVC etc.)
# ffmpeg 8.1 static build: hevc_nvenc gained MV-HEVC (`-profile:v mv`).
# Pinned to the n8.1 line — the master builds target NVENC API 13.1
# which needs driver ≥610; Modal hosts run 580.x (API 13.0).
FFMPEG8_URL = (
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/"
    "ffmpeg-n8.1-latest-linux64-gpl-8.1.tar.xz"
)

nvenc_image = (
    modal.Image.debian_slim(python_version=PYTHON_VERSION)
    .apt_install("curl", "xz-utils")
    .run_commands(
        f"curl -L --retry 5 --retry-all-errors --retry-delay 3 {FFMPEG8_URL} -o /tmp/ff.tar.xz",
        "mkdir -p /opt/ffmpeg && tar -xJf /tmp/ff.tar.xz -C /opt/ffmpeg --strip-components=1",
        "ln -sf /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg8",
        "ln -sf /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe8",
        "rm /tmp/ff.tar.xz",
    )
    .add_local_python_source("app")
)

# ---------------------------------------------- image stereo (stills)
image_stereo_image = (
    with_forward_warp(
        cuda_torch_base().uv_pip_install(
            "pillow-heif==0.22.0",
            "matplotlib==3.10.3",
        )
    )
    .add_local_python_source("app")
)
