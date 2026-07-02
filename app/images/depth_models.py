"""Modal image for the per-frame depth backends (DA2-metric, DA3,
Depth Pro).

Separate from ``video_depth_image`` so the DA3 dependency stack never
invalidates the proven VideoDepthAnything image. Notes on the pins:

- DA2-metric loads through transformers (``DepthAnythingForDepth-
  Estimation``); same transformers pin as ``m2svid_image``.
- ``depth-anything-3`` (0.1.1) declares ``numpy<2`` in its metadata
  while this stack is pinned to numpy 2.x. The constraint is
  metadata-only for the code paths we use (verified against the wheel:
  monocular inference imports), so the package is installed with
  ``--no-deps`` and its actual import-time dependencies are pinned
  explicitly below. ``depth_anything_3.api`` imports its export/pose
  helpers at module import, which is why addict/evo/moviepy/pycolmap/
  trimesh/plyfile/matplotlib are required even though we only run
  depth inference.
- xformers and gsplat are NOT installed: DA3 guards both imports with
  pure-torch fallbacks and only needs them for ViT-Giant (SwiGLU FFN)
  and 3DGS export respectively — we run ViT-L, which uses torch SDPA.
- ``depth_pro`` (Apple Depth Pro) is not on PyPI; it installs from the
  pinned GitHub commit. Like DA3 it declares ``numpy<2`` while only
  ``utils.load_rgb`` (which we never call) touches numpy, so it is
  installed with ``--no-deps`` and its real import-time deps are
  pinned here: timm (architecture construction only — weights come
  from our checkpoint, never a timm download) and pillow-heif
  (imported unconditionally by ``depth_pro.utils`` at package
  import). torch/torchvision/matplotlib are already in the image.
  License: the GitHub code is Apple's permissive sample-code license,
  but the WEIGHTS are apple-amlr (research-only) — see
  app/common/weights.py:ensure_depth_pro.
"""

from app.env import APP_ENV
from app.images.common import cuda_torch_base

depth_models_image = (
    cuda_torch_base()
    .uv_pip_install(
        # DA2-metric via transformers (same pins as m2svid_image)
        "transformers==4.47.1",
        "safetensors==0.5.3",
        # scene detection for per-scene normalization resets
        "scenedetect==0.6.6",
        # DA3 import-time dependencies (see module docstring)
        "omegaconf==2.3.0",
        "matplotlib==3.10.3",
        "addict==2.4.0",
        "evo==1.36.5",
        "moviepy==1.0.3",
        "pycolmap==4.0.4",
        "trimesh==4.12.2",
        "plyfile==1.1.4",
        # Depth Pro import-time dependencies (see module docstring)
        "timm==1.0.15",
        "pillow-heif==0.22.0",
    )
    # --no-deps: dodge the numpy<2 metadata pins (see module docstring)
    .run_commands(
        "pip install --no-deps depth-anything-3==0.1.1",
        "pip install --no-deps"
        " git+https://github.com/apple/ml-depth-pro.git@9efe5c1def37a26c5367a71df664b18e1306c708",
    )
    .add_local_python_source("app")
    # APP_ENV must be baked into the image — containers don't inherit the
    # deploy-time environment (see app/images/__init__.py).
    .env({"APP_ENV": APP_ENV})
)
