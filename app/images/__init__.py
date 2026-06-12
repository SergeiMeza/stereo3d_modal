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
    # memory-efficient attention — without it DINOv2 falls back to
    # naive O(N²) attention and OOMs above ~518px input (122 GiB alloc).
    # 0.0.31.post1 is the torch 2.7.1-matched build.
    .uv_pip_install("xformers==0.0.31.post1", extra_index_url="https://download.pytorch.org/whl/cu126")
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

# Bento4 mp4edit splices the Apple vexu/hfov spatial-metadata blobs
# (and patches stco chunk offsets automatically).
BENTO4_URL = "https://www.bok.net/Bento4/binaries/Bento4-SDK-1-6-0-641.x86_64-unknown-linux.zip"

nvenc_image = (
    modal.Image.debian_slim(python_version=PYTHON_VERSION)
    .apt_install(
        "curl", "xz-utils", "unzip",
        # GPAC build deps — distro gpac (1.0.1) writes no lhvC box, which
        # visionOS requires for MV-HEVC; build modern MP4Box from source.
        "build-essential", "pkg-config", "zlib1g-dev", "git", "cmake", "nasm",
    )
    .run_commands(
        f"curl -L --retry 5 --retry-all-errors --retry-delay 3 {FFMPEG8_URL} -o /tmp/ff.tar.xz",
        "mkdir -p /opt/ffmpeg && tar -xJf /tmp/ff.tar.xz -C /opt/ffmpeg --strip-components=1",
        "ln -sf /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg8",
        "ln -sf /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe8",
        # standard names too — shared helpers (e.g. probe_video) call plain ffprobe
        "ln -sf /opt/ffmpeg/bin/ffmpeg /usr/local/bin/ffmpeg",
        "ln -sf /opt/ffmpeg/bin/ffprobe /usr/local/bin/ffprobe",
        "rm /tmp/ff.tar.xz",
    )
    .run_commands(
        f"curl -L --retry 5 --retry-all-errors --retry-delay 3 {BENTO4_URL} -o /tmp/bento4.zip",
        "unzip -q /tmp/bento4.zip -d /opt && mv /opt/Bento4-SDK-* /opt/bento4",
        "ln -sf /opt/bento4/bin/mp4edit /usr/local/bin/mp4edit",
        "ln -sf /opt/bento4/bin/mp4dump /usr/local/bin/mp4dump",
        "ln -sf /opt/bento4/bin/mp4extract /usr/local/bin/mp4extract",
        "rm /tmp/bento4.zip",
    )
    .run_commands(
        "git clone --depth 1 https://github.com/gpac/gpac.git /tmp/gpac"
        " && cd /tmp/gpac && ./configure --static-mp4box && make -j$(nproc)"
        " && cp bin/gcc/MP4Box /usr/local/bin/MP4Box && rm -rf /tmp/gpac",
    )
    .run_commands(
        # x265 4.2 with MV-HEVC multiview: the only Linux encoder whose
        # VPS multiview signaling Apple's spatial classifier accepts
        # (NVENC output plays but never gets the Photos/Files badge).
        # 8-bit only; multilib not wired for ENABLE_MULTIVIEW.
        "git clone --depth 1 --branch 4.2 https://bitbucket.org/multicoreware/x265_git.git /tmp/x265"
        " && cmake -S /tmp/x265/source -B /tmp/x265/build -DCMAKE_BUILD_TYPE=Release -DENABLE_MULTIVIEW=ON"
        " && cmake --build /tmp/x265/build -j$(nproc)"
        " && cp /tmp/x265/build/x265 /usr/local/bin/x265 && rm -rf /tmp/x265",
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
