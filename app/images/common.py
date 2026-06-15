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

# Blackwell (sm_100 / B200) torch stack — MUST be the cu128 build.
# Two separate gates have to be cleared for B200:
#  1. xformers Blackwell kernels ("cutlass fmha Op for Blackwell GPUs")
#     first ship in xformers 0.0.33, which is built against torch 2.9.x.
#     There is NO xformers build pairing torch 2.7 with sm_100 kernels.
#  2. PyTorch's *own* sm_100 binary kernels are only in the cu128 (and
#     cu130) wheels — the cu126 torch wheel compiles for sm_50..sm_90
#     +PTX only, so a cu126 torch on B200 still throws "no kernel image
#     is available" / "sm_100 not compatible with this PyTorch install"
#     (verified on a real B200: job 1eeba89429e9 with the cu126 2.9.1
#     build failed identically to the old xformers error). The CUDA
#     *toolkit* version (12.6 base) is irrelevant — torch wheels bundle
#     their own CUDA runtime; what matters is which arches torch baked
#     into the wheel, and only cu128+ bakes sm_100.
# So the Blackwell stack pins torch 2.9.1+cu128. Modal's B200 hosts run
# a driver new enough for the cu128 runtime. This stack is opt-in (depth
# image only) — every other GPU image keeps the cu126 2.7.1 TORCH_PIN
# above, so their build cache and behavior are unchanged.
TORCH_INDEX_BLACKWELL = "https://download.pytorch.org/whl/cu128"
TORCH_PIN_BLACKWELL = [
    "torch==2.9.1",
    "torchvision==0.24.1",
    "torchcodec==0.9",
]

# Covers A100 (8.0), A10G (8.6), L4/L40S (8.9), H100/H200 (9.0); PTX
# fallback lets newer architectures JIT-compile.
CUDA_ARCH_LIST = "8.0;8.6;8.9;9.0+PTX"


def cuda_torch_base(
    torch_pin: list[str] | None = None,
    torch_index: str | None = None,
) -> modal.Image:
    """CUDA + pinned torch stack. Identical first layers across all GPU
    images so they share build cache.

    ``torch_pin``/``torch_index`` default to the cu126 torch 2.7.1 stack
    (TORCH_PIN / TORCH_INDEX); pass TORCH_PIN_BLACKWELL +
    TORCH_INDEX_BLACKWELL for the cu128 torch 2.9.1 stack needed for
    B200/sm_100 (depth image). The non-torch base layers (apt,
    numpy/pillow/etc.) are identical in both cases.
    """
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
        .uv_pip_install(
            *(torch_pin or TORCH_PIN),
            extra_index_url=(torch_index or TORCH_INDEX),
        )
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
        image.uv_pip_install("setuptools==80.9.0", "wheel==0.45.1", "ninja==1.11.1.4")
        .add_local_dir(
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
