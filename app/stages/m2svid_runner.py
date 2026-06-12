"""M2SVid one-step right-view inpainting runner.

Wraps the vendored M2SVid ``VideoLDM`` (app/vendor/m2svid) behind two
calls: :func:`load_m2svid` (container start) and :func:`inpaint_chunk`
(one ≤25-frame window). The preprocessing here mirrors upstream
``inpaint_and_refine.py`` exactly:

    occlusion mask  → morphological closing (k=11), binarize > 0.5
    warped right    → holes zeroed to black
    mask            → dilation (k=3), then bilinear-downsampled to the
                      latent grid (H/8, W/8), values mapped to {-1,+1}
    videos          → (B, C, T, H, W) float32 in [-1, 1]

Mask polarity: 1/+1 = disoccluded hole to inpaint, 0/-1 = valid warped
pixel — which matches ``DepthSplatter``'s occlusion maps directly.

Model constraints (from the upstream release):
- at most ``CHUNK`` = 25 frames per call (SVD temporal window; the
  model raises above it). Shorter windows are padded by repeating the
  last frame because the LinearPredictionGuider is built for exactly
  25 frames; padding is trimmed from the output.
- H and W must be divisible by 64 (trained at 512x512).
- sampling is a single deterministic forward pass (EulerEDM
  ``num_steps=1`` from a zeroed latent at sigma=700) — no seed, no CFG
  (scales pinned to 1.0, though the cond/uncond batch doubling still
  runs, so the UNet sees 2x25 frames per call).

GPU-only module; import inside m2svid_image containers.
"""

from __future__ import annotations

import cv2
import torch
import torch.nn.functional as F

from app.common.debug import get_logger
from app.common.weights import ensure_m2svid
from app.vendor.m2svid import bootstrap
from app.vendor.m2svid.inference_config import M2SVID_CONFIG_YAML

logger = get_logger(__name__)

# SVD temporal window: hard upper bound on frames per generate() call.
CHUNK = 25
# VAE spatial downscale factor: the inpainting mask is fed at latent res.
LATENT_DOWNSCALE = 8
# Fixed SVD conditioning value used by the upstream demo.
MOTION_BUCKET_ID = 127
# Upstream mask morphology (tuned at 512px): close small splat gaps
# into contiguous holes, then dilate the hole border slightly.
CLOSING_KERNEL = 11
DILATION_KERNEL = 3


def load_m2svid(variant: str = "full_attention", device: str = "cuda"):
    """Instantiate VideoLDM from the vendored config and load the
    release checkpoint (fp16, eval). ~9 GiB of weights stream from the
    weights volume on first container start."""
    bootstrap()
    from omegaconf import OmegaConf
    from sgm.util import instantiate_from_config

    paths = ensure_m2svid(variant)
    config = OmegaConf.create(M2SVID_CONFIG_YAML)
    # the conditioner builds OpenCLIP ViT-H from this file before the
    # checkpoint's own (identical, frozen) weights are restored over it
    config.model.params.conditioner_config.params.emb_models[
        0
    ].params.open_clip_embedding_config.params.version = str(paths["open_clip"])

    model = instantiate_from_config(config.model).cpu()
    model.init_from_ckpt(str(paths["checkpoint"]))
    return model.to(device).half().eval()


def _morph(mask: torch.Tensor, op: int, kernel_size: int) -> torch.Tensor:
    """cv2 morphology per frame on a (T, 1, H, W) float tensor, then
    binarize > 0.5 — byte-for-byte the upstream apply_closing /
    apply_dilation behaviour."""
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_size, kernel_size))
    out = mask.detach().cpu().float().clone()
    for t in range(out.shape[0]):
        frame = out[t, 0].numpy()
        frame = cv2.morphologyEx(frame, op, kernel)
        out[t, 0] = torch.from_numpy(frame)
    return (out > 0.5).float()


def hole_mask(occlusion: torch.Tensor) -> torch.Tensor:
    """Closing(11) + dilation(3) of a (T, 1, H, W) [0, 1] occlusion map
    — the exact region M2SVid is asked to fill. Returns bool on the
    input device."""
    closed = _morph(occlusion, cv2.MORPH_CLOSE, CLOSING_KERNEL)
    dilated = _morph(closed, cv2.MORPH_DILATE, DILATION_KERNEL)
    return (dilated > 0.5).to(occlusion.device)


@torch.no_grad()
def inpaint_chunk(
    model,
    left_u8: torch.Tensor,  # (T, 3, H, W) uint8 on GPU — original left frames
    warped: torch.Tensor,  # (T, 3, H, W) float [0, 1] on GPU — forward-warped right
    occlusion: torch.Tensor,  # (T, 1, H, W) float [0, 1] on GPU — 1 = hole
    fps: float,
) -> torch.Tensor:
    """Inpaint + refine one ≤25-frame window. Returns the generated
    right view as (T, 3, H, W) uint8 on GPU."""
    t_in, _, h, w = left_u8.shape
    if t_in > CHUNK:
        raise ValueError(f"M2SVid window is {CHUNK} frames, got {t_in}")
    if h % 64 or w % 64:
        raise ValueError(f"M2SVid needs dims divisible by 64, got {w}x{h}")

    # --- upstream preprocessing -------------------------------------
    mask = _morph(occlusion, cv2.MORPH_CLOSE, CLOSING_KERNEL).to(left_u8.device)
    warped = warped.clone()
    warped[(mask > 0.5).expand(-1, 3, -1, -1)] = 0.0
    mask = _morph(mask, cv2.MORPH_DILATE, DILATION_KERNEL).to(left_u8.device)

    left = left_u8.float() / 255.0 * 2.0 - 1.0
    warped = warped * 2.0 - 1.0
    mask = mask * 2.0 - 1.0
    # latent-resolution single-channel mask (upstream: bilinear, no antialias)
    mask = F.interpolate(mask, size=(h // LATENT_DOWNSCALE, w // LATENT_DOWNSCALE), mode="bilinear", align_corners=False)

    # pad to exactly CHUNK frames (guider is built for 25) by repeating
    # the last frame; trimmed from the output below
    if t_in < CHUNK:
        pad = CHUNK - t_in
        left = torch.cat([left, left[-1:].expand(pad, -1, -1, -1)], dim=0)
        warped = torch.cat([warped, warped[-1:].expand(pad, -1, -1, -1)], dim=0)
        mask = torch.cat([mask, mask[-1:].expand(pad, -1, -1, -1)], dim=0)

    # (T, C, H, W) -> (1, C, T, H, W)
    batch = {
        "video": left.permute(1, 0, 2, 3)[None],
        "video_2nd_view": left.permute(1, 0, 2, 3)[None],
        "reprojected_video": warped.permute(1, 0, 2, 3)[None],
        "reprojected_mask": mask.permute(1, 0, 2, 3)[None],
        "fps_id": torch.tensor([float(fps)], device=left.device),
        "caption": [""],
        "motion_bucket_id": torch.tensor([MOTION_BUCKET_ID], device=left.device),
    }

    with torch.inference_mode():
        generated = model.generate(batch)["generated-video"]  # (1, 3, T, H, W) [-1, 1]

    right = generated[0].permute(1, 0, 2, 3)[:t_in]  # (T, 3, H, W)
    right = ((right.float() + 1.0) / 2.0).clamp(0.0, 1.0)
    return (right * 255.0).round().to(torch.uint8)
