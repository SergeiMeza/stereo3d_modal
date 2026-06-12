"""Modal image for the per-frame depth backends (DA2-metric, DA3).

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
  and 3DGS export respectively. The ``da3-giant`` backend (ViT-Giant)
  runs on the fallback ``SwiGLUFFN`` — verified state-dict compatible
  with the checkpoint (same packed ``w12``/``w3`` layout as xformers'
  default) — so the Giant model needs no image change either. The
  0.1.1 wheel's registry already ships the ``da3-giant`` architecture
  yaml, and the DA3-GIANT-1.1 checkpoint's config.json matches it
  exactly (verified against the HF repo), so no version bump is
  needed for the Giant checkpoints.
"""

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
    )
    # --no-deps: dodge the numpy<2 metadata pin (see module docstring)
    .run_commands("pip install --no-deps depth-anything-3==0.1.1")
    .add_local_python_source("app")
)
