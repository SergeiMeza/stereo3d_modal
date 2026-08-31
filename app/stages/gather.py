"""Backward-warp (gather) stereo synthesis.

The second of the pipeline's two stereo-pair methods, selected by the
``warp`` job parameter:

- ``"forward"``  — ``DepthSplatter`` in splat.py: scatter every SOURCE
  pixel to its destination, leave disocclusion holes + masks for an
  inpainting stage (LAMA / ProPainter). Higher quality, needs the CUDA
  Forward_Warp extension and a second model.
- ``"backward"`` — this module: for every OUTPUT pixel compute where its
  colour comes FROM in the source and sample there. One
  ``grid_sample`` pass, no scatter, no atomics, no masks, no
  inpainting. Runs on CPU or GPU, so it is usable on the coordinator
  container too. Cannot fail (every output pixel is filled by
  construction) — instead of holes it *stretches* the neighbouring
  pixel across a depth discontinuity.

Reference: ``depthWarpFilterV5`` in the app's
``SpatialVideoStudio/Metal/CIKernels.metal``::

    max_disp   = disp * width                       # per-eye sign in disp
    disp_map   = depth * (near - far) + far          # depth [0,1] -> signed
    disp_map   = max_disp * disp_map
    x_src      = x_out - disp_map                    # SUBTRACT: "where from"
    return image.sample(x_src, y)

The forward warp ADDS the disparity (pixel at x lands at x + d); the
backward warp SUBTRACTS it (pixel at x came from x - d). Both move
content the same way on screen: for the left eye (positive sign) a
pop-out object (d > 0) shifts RIGHT, behind-screen content (d < 0)
shifts LEFT — verified in tests/test_backward_warp.py rather than
assumed, because an inverted-depth pair looks plausible and is
genuinely uncomfortable to view.

``disp`` / ``placement`` semantics are byte-for-byte the DepthSplatter
ones (max_disp halved in "both" mode, placement fractions of max_disp),
so every tuned value in video_depth_models.SHOT_PARAMS applies
unchanged and the two methods are directly comparable on the same input.
"""

import torch
import torch.nn as nn
import torch.nn.functional as F

from app.stages.video_depth_models import DEFAULT_PLACEMENT
# the ``warp`` parameter names + validator are torch-free (warp_modes.py)
# so the API/coordinator can import them; re-exported here for callers
# that already have torch
from app.stages.warp_modes import (  # noqa: F401
    WARP_BACKWARD,
    WARP_FORWARD,
    WARP_METHODS,
    validate_warp,
)

LEFT = "left"
RIGHT = "right"
BOTH = "both"


def backward_warp(image: torch.Tensor, disp_map: torch.Tensor) -> torch.Tensor:
    """Gather-warp ``image`` (B, C, H, W) float by a signed horizontal
    disparity map ``disp_map`` (B, 1, H, W) in PIXELS, indexed by OUTPUT
    pixel: ``out[x] = image[x - disp_map[x]]`` (bilinear).

    Padding is ``zeros``, deliberately: the region the warp shifts in
    from at the frame edge (up to max_disp × max|placement| px) comes out
    as a black band. That matches (a) the app's Core Image kernel, whose
    sampler returns transparent black outside the image extent, and
    (b) the forward warp's ``inpaint="none"`` path, whose edge holes are
    also left black — so switching warp method never changes what the
    frame edge looks like. ``border`` would instead smear the edge column
    across that band, which reads as a vertical streak in stereo (the
    two eyes get different streaks) and would hide a mis-sized
    disparity from the no-holes test.
    """
    B, _, H, W = image.shape
    device, dtype = image.device, image.dtype
    disp = disp_map.to(device=device, dtype=dtype)[:, 0]  # (B, H, W)

    # pixel-centre indices -> source coordinate -> normalised [-1, 1]
    # with align_corners=False: x_n = (2 * x + 1) / W - 1
    xs = torch.arange(W, device=device, dtype=dtype).view(1, 1, W)
    ys = torch.arange(H, device=device, dtype=dtype).view(1, H, 1)
    x_src = xs - disp  # (B, H, W)  — backward: SUBTRACT the disparity
    grid_x = (2.0 * x_src + 1.0) / W - 1.0
    grid_y = ((2.0 * ys + 1.0) / H - 1.0).expand(B, H, W)
    grid = torch.stack((grid_x, grid_y), dim=-1)  # (B, H, W, 2)

    return F.grid_sample(
        image, grid, mode="bilinear", padding_mode="zeros", align_corners=False
    )


class BackwardWarpStereo(nn.Module):
    """depthmap [0, 1] -> left/right gathered views. Drop-in for
    ``DepthSplatter``: same signature, same ``disp``/``placement``
    semantics, same return shape — but the occlusion masks are always
    ``None`` (not zero-filled): a gather has no disocclusion holes, and
    callers must treat ``None`` as "no inpainting applicable"."""

    def forward(
        self,
        image: torch.Tensor,  # (B, C, H, W) uint8 or float [0,1]
        depthmap: torch.Tensor,  # (B, 1, H, W) float [0,1]
        disp: float,  # max displacement as a fraction of width
        stereo_mode: str = BOTH,
        placement: tuple[float, float] = DEFAULT_PLACEMENT,
    ) -> tuple[
        torch.Tensor | None,  # left_image  float [0,1]
        torch.Tensor | None,  # right_image float [0,1]
        None,  # left occlusion map  — never produced
        None,  # right occlusion map — never produced
    ]:
        if stereo_mode not in (LEFT, RIGHT, BOTH):
            raise ValueError(f"unknown stereo_mode: {stereo_mode!r}")
        _, _, H, W = image.shape

        if image.dtype == torch.uint8:
            image = image / 255.0
        if depthmap.dtype == torch.uint8:
            depthmap = depthmap / 255.0
        image = image.float()
        depthmap = depthmap.float().clamp(0.0, 1.0)
        if depthmap.shape[-2:] != (H, W):
            raise ValueError(
                f"depthmap {tuple(depthmap.shape[-2:])} must match image {(H, W)}"
            )

        # identical to DepthSplatter: full eye-to-eye separation, halved
        # per eye when both are synthesised
        max_disp = disp * W
        if stereo_mode == BOTH:
            max_disp *= 0.5

        # depth [0,1] -> signed disparity in [placement[0], placement[1]]
        # (fractions of max_disp): negative behind the screen, positive
        # pop-out. Same mapping as DepthSplatter so SHOT_PARAMS transfer.
        disp_map = depthmap * (placement[1] - placement[0]) + placement[0]
        disp_map = max_disp * disp_map

        left_image = right_image = None
        # left eye: +disp (content came from x - d); right eye: -disp
        if stereo_mode in (BOTH, LEFT):
            left_image = backward_warp(image, disp_map)
        if stereo_mode in (BOTH, RIGHT):
            right_image = backward_warp(image, -disp_map)

        return left_image, right_image, None, None
