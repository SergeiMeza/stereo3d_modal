"""Model checkpoint management.

Checkpoints live in the ``stereo3d-weights`` Volume mounted at
/weights, downloaded on first use. Rebuilding an image never
re-downloads weights, and adding a model never rebuilds an image.

Each ``ensure_*`` function is idempotent: returns the local path if
present, downloads atomically (temp + rename) if not.
"""

import os
import shutil
import tempfile
import urllib.request
from pathlib import Path

from app.common.debug import get_logger
from app.common.storage import WEIGHTS_DIR

logger = get_logger(__name__)

PROPAINTER_RELEASE = "https://github.com/sczhou/ProPainter/releases/download/v0.1.0"

# Public GCS bucket of the official M2SVid release (no auth required)
M2SVID_RELEASE = "https://storage.googleapis.com/gresearch/m2svid"


def _download_url(url: str, dest: Path) -> Path:
    if dest.exists():
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    logger.info(f"⬇️  downloading {url} -> {dest}")
    with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as tmp:
        with urllib.request.urlopen(url) as r:
            shutil.copyfileobj(r, tmp)
    os.replace(tmp.name, dest)
    return dest


def _hf_download(repo_id: str, filename: str, subdir: str) -> Path:
    """Download a single file from HF into the weights volume."""
    dest = WEIGHTS_DIR / subdir / filename
    if dest.exists():
        return dest
    from huggingface_hub import hf_hub_download

    logger.info(f"⬇️  downloading hf://{repo_id}/{filename} -> {dest}")
    dest.parent.mkdir(parents=True, exist_ok=True)
    path = hf_hub_download(repo_id=repo_id, filename=filename, local_dir=dest.parent)
    return Path(path)


def ensure_video_depth_anything(encoder: str = "vitl") -> Path:
    """VideoDepthAnything checkpoint (vits|vitl), Depth-Anything-V2 based."""
    name = {"vits": "Small", "vitl": "Large"}[encoder]
    return _hf_download(
        repo_id=f"depth-anything/Video-Depth-Anything-{name}",
        filename=f"video_depth_anything_{encoder}.pth",
        subdir="video_depth_anything",
    )


def ensure_depth_anything_v2() -> Path:
    """TorchScript-traced Depth-Anything-V2-Large (fp16) for still images."""
    return _hf_download(
        repo_id="sarmientoF/spatial-video-studio",
        filename="Depth-Anything-V2-Large-hf-f16.pt",
        subdir="spatial_video_studio",
    )


def _hf_snapshot(repo_id: str, subdir: str, allow_patterns: list[str] | None = None) -> Path:
    """Download a full HF repo snapshot into the weights volume.

    Used for transformers-style checkpoints (config.json +
    model.safetensors + ...) that are loaded with ``from_pretrained``
    on a local directory, so a container never hits the Hub after the
    first download."""
    dest = WEIGHTS_DIR / subdir
    done = dest / ".complete"  # snapshot is multi-file: mark atomicity ourselves
    if done.exists():
        return dest
    from huggingface_hub import snapshot_download

    logger.info(f"⬇️  downloading hf snapshot {repo_id} -> {dest}")
    dest.mkdir(parents=True, exist_ok=True)
    snapshot_download(repo_id=repo_id, local_dir=dest, allow_patterns=allow_patterns)
    done.touch()
    return dest


def ensure_da2_metric(variant: str = "indoor") -> Path:
    """Depth-Anything-V2 metric checkpoint (transformers format).

    ``variant``: "indoor" (Hypersim fine-tune, max_depth=20 m) or
    "outdoor" (VKITTI fine-tune, max_depth=80 m). Unlike the
    TorchScript-traced relative DA2 used for stills, these output
    absolute depth in meters (sigmoid * max_depth head), which is what
    makes job-wide consistent disparity mapping possible.

    License note: upstream GitHub marks the Large weights
    CC-BY-NC-4.0 even though the HF repos are tagged apache-2.0 —
    verify before commercial use. Returns the local snapshot dir for
    ``DepthAnythingForDepthEstimation.from_pretrained``.
    """
    name = {"indoor": "Indoor", "outdoor": "Outdoor"}[variant]
    return _hf_snapshot(
        repo_id=f"depth-anything/Depth-Anything-V2-Metric-{name}-Large-hf",
        subdir=f"da2_metric/{variant}",
        allow_patterns=["*.json", "*.safetensors"],
    )


def ensure_da3(variant: str = "mono-large", metric: bool = False) -> Path:
    """Depth Anything 3 monocular checkpoint (Apache-2.0, ~1.34 GB).

    ``metric`` selects the checkpoint family — they share one
    architecture (ViT-L + DPT) but differ in output semantics:
    - DA3MONO-LARGE (metric=False): scale-free relative DEPTH (not
      disparity like DA2-relative);
    - DA3METRIC-LARGE (metric=True): focal-normalized metric depth,
      ``meters = focal_px * output / 300`` per the upstream FAQ. The
      focal factor is constant per video, so it cancels under the
      job-wide disparity normalization in video_depth_models.

    Returns the local snapshot dir for
    ``DepthAnything3.from_pretrained`` (config.json + safetensors; the
    architecture yaml ships inside the pip package's registry).
    """
    size = {"mono-large": "LARGE"}[variant]
    family = "DA3METRIC" if metric else "DA3MONO"
    return _hf_snapshot(
        repo_id=f"depth-anything/{family}-{size}",
        subdir=f"da3/{family.lower()}-{size.lower()}",
        allow_patterns=["*.json", "*.safetensors"],
    )


def ensure_depth_pro() -> Path:
    """Apple Depth Pro checkpoint (single fp16 ``.pt`` state dict, ~1.8 GB).

    Metric monocular depth PLUS a per-image focal-length / field-of-view
    estimate (ViT-L multi-scale patch encoder + FOV head, fixed
    1536x1536 network input) — the FOV output is what the pipeline
    wants for shot-type classification.

    License note: code AND weights ship under the Apple ML Research
    license (apple-amlr) — research/R&D use only, redistribution and
    commercial use are NOT permitted. Keep this backend out of
    production until the license is cleared.
    """
    return _hf_download(
        repo_id="apple/DepthPro",
        filename="depth_pro.pt",
        subdir="depth_pro",
    )


def ensure_lama() -> Path:
    """TorchScript-traced LAMA inpainting model (still images)."""
    return _hf_download(
        repo_id="sarmientoF/spatial-video-studio",
        filename="lama_cuda.pt",
        subdir="spatial_video_studio",
    )


def ensure_migan() -> Path:
    """TorchScript-traced MiGAN inpainting model (fast video fallback)."""
    return _hf_download(
        repo_id="SpatialVideoStudio/spatial-video-studio",
        filename="migan_traced.pt",
        subdir="spatial_video_studio",
    )


def ensure_m2svid(variant: str = "full_attention") -> dict[str, Path]:
    """M2SVid mono-to-stereo video inpainting weights (3DV 2026).

    Two files:
    - the VideoLDM checkpoint (~4.6 GiB, deepspeed-format ``.pt`` with
      the full 13-channel SVD-XT-derived UNet + VAE + conditioners),
      from Google's public GCS release bucket;
    - the OpenCLIP ViT-H image-encoder bin (~3.9 GiB) the conditioner
      config instantiates from. Upstream ships it inside Hi3D's Google
      Drive ``ckpts.zip``; this is the identical standard laion
      checkpoint from HF (the encoder is frozen, and its weights are
      restored from the M2SVid state dict again afterwards).

    ``variant``: "full_attention" (released default; full attention
    over disoccluded tokens) or "no_full_attention" (cheaper fallback).
    """
    name = {
        "full_attention": "m2svid_weights.pt",
        "no_full_attention": "m2svid_no_full_atten_weights.pt",
    }[variant]
    return {
        "checkpoint": _download_url(f"{M2SVID_RELEASE}/{name}", WEIGHTS_DIR / "m2svid" / name),
        "open_clip": _hf_download(
            repo_id="laion/CLIP-ViT-H-14-laion2B-s32B-b79K",
            filename="open_clip_pytorch_model.bin",
            subdir="m2svid",
        ),
    }


def ensure_propainter() -> dict[str, Path]:
    """ProPainter video inpainting weights (generator, RAFT, flow completion)."""
    base = WEIGHTS_DIR / "propainter"
    return {
        "propainter": _download_url(f"{PROPAINTER_RELEASE}/ProPainter.pth", base / "ProPainter.pth"),
        "raft": _download_url(f"{PROPAINTER_RELEASE}/raft-things.pth", base / "raft-things.pth"),
        "flow_completion": _download_url(
            f"{PROPAINTER_RELEASE}/recurrent_flow_completion.pth",
            base / "recurrent_flow_completion.pth",
        ),
    }
