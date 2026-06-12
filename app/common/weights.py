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
