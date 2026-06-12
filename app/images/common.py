"""Shared image-building blocks.

Layer ordering matters for Modal's build cache: the most stable layers
(base OS, apt, pinned torch stack) come first; anything likely to
change during development comes last. App source is attached at
container start via ``add_local_python_source`` and never triggers a
rebuild.

Model weights are NOT baked into images — they live in the
``stereo3d-weights`` Volume (see app/common/weights.py), so a rebuilt
image never re-downloads checkpoints.
"""

import modal

PYTHON_VERSION = "3.12"
CUDA_BASE = "nvidia/cuda:12.6.3-cudnn-devel-ubuntu24.04"

# Pinned ML stack (cu126). ML projects are extremely sensitive to
# version drift — bump these deliberately, never implicitly.
TORCH_PIN = [
    "torch==2.7.1",
    "torchvision==0.22.1",
    "torchcodec==0.4",
]
TORCH_INDEX = "https://download.pytorch.org/whl/cu126"

# Covers A100 (8.0), A10G (8.6), L4/L40S (8.9), H100/H200 (9.0); PTX
# fallback lets newer architectures JIT-compile.
CUDA_ARCH_LIST = "8.0;8.6;8.9;9.0+PTX"


def cuda_torch_base() -> modal.Image:
    """CUDA + pinned torch stack. Identical first layers across all GPU
    images so they share build cache."""
    return (
        modal.Image.from_registry(CUDA_BASE, add_python=PYTHON_VERSION)
        .apt_install(
            "libglib2.0-0",
            "libsm6",
            "libxrender1",
            "libxext6",
            "libgl1",
            "ffmpeg",
            "clang",
            "git",
        )
        .uv_pip_install(*TORCH_PIN, extra_index_url=TORCH_INDEX)
        .uv_pip_install(
            "numpy==2.2.6",
            "pillow==11.2.1",
            "einops==0.8.1",
            "scipy==1.15.3",
            "tqdm==4.67.1",
            "opencv-python-headless==4.11.0.86",
            "imageio==2.37.0",
            "imageio-ffmpeg==0.6.0",
            "ffmpeg-python==0.2.0",
            "huggingface_hub==0.33.0",
            "hf-transfer==0.1.9",
        )
        .env({"HF_HUB_ENABLE_HF_TRANSFER": "1"})
    )


def with_forward_warp(image: modal.Image) -> modal.Image:
    """Compile the Forward_Warp CUDA extension into an image.

    Built CPU-only with an explicit arch list (cheaper and more
    reproducible than compiling on an attached GPU).
    """
    return (
        image.add_local_dir(
            "app/vendor/forward_warp",
            "/build/forward_warp",
            copy=True,
        )
        .run_commands(
            "cd /build/forward_warp/Forward_Warp/cuda"
            f" && TORCH_CUDA_ARCH_LIST='{CUDA_ARCH_LIST}' pip install --no-build-isolation .",
            "cd /build/forward_warp && pip install .",
        )
    )
