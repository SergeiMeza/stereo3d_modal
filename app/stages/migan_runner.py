"""MI-GAN occlusion fill — the fast, per-frame inpainter.

The ``inpaint="migan"`` middle ground between ProPainter (temporal,
H200-class VRAM, ~$0.0008/frame) and ``"none"`` (no fill at all): the
official MI-GAN 512 Places2 generator (vendored OSS code + checkpoint,
see app/vendor/migan) fills each eye's disocclusion holes frame by
frame with no temporal model, so it runs on the L4 lite tier next to
the NVENC encoder. Trade-off, stated plainly: fills are decided per
frame, so a hole that persists across frames can shimmer slightly where
ProPainter would keep it steady — acceptable for thin warp slivers,
which is all the forward warp produces.

Recipe (the one the iOS app shipped, ported to batched torch):
- resize frame + hole mask to a 1024×1024 working square (nearest — the
  mask must stay crisp),
- split into 2×2 tiles of 512 (the generator has FIXED-resolution
  buffers; 512 is its trained size),
- run ``cat([known_mask - 0.5, image * known_mask])`` through the
  generator under autocast, in bounded sub-batches,
- reassemble, keep the model's output ONLY inside the holes, upscale
  the filled square back to frame resolution (bicubic), and paste into
  the slightly dilated holes of the full-resolution warp — everything
  outside a hole keeps source detail, exactly like the ProPainter
  compositing path.
"""

import torch
import torch.nn.functional as F

from app.common.weights import ensure_migan_512

WORK = 1024  # working square; 2×2 tiles of the generator's fixed 512
TILE = 512
# generator sub-batch: 16 tiles (= 4 frames) keeps activations ~2 GB on
# an L4 while amortizing launch overhead
MAX_TILES = 16


def _tile(x: torch.Tensor) -> torch.Tensor:
    """(B, C, 1024, 1024) -> (B*4, C, 512, 512), row-major tiles."""
    B, C, _, _ = x.shape
    return (
        x.reshape(B, C, 2, TILE, 2, TILE)
        .permute(0, 2, 4, 1, 3, 5)
        .reshape(B * 4, C, TILE, TILE)
    )


def _untile(x: torch.Tensor, batch: int) -> torch.Tensor:
    """Inverse of _tile: (B*4, C, 512, 512) -> (B, C, 1024, 1024)."""
    C = x.shape[1]
    return (
        x.reshape(batch, 2, 2, C, TILE, TILE)
        .permute(0, 3, 1, 4, 2, 5)
        .reshape(batch, C, WORK, WORK)
    )


class MiganInpainter:
    def __init__(self, device: str = "cuda"):
        from app.vendor.migan import Generator

        model = Generator(resolution=TILE)
        model.load_state_dict(torch.load(ensure_migan_512(), map_location="cpu"), strict=True)
        self.model = model.to(device).eval()
        self.device = device

    @torch.no_grad()
    def fill(self, image: torch.Tensor, occlusion: torch.Tensor) -> torch.Tensor:
        """Fill the occluded pixels of a warped eye.

        image: (B, 3, H, W) float [0, 1] — the forward-warped frame.
        occlusion: (B, 1, H, W) float [0, 1], 1 = disocclusion hole
        (DepthSplatter's mask convention). Returns uint8 (B, 3, H, W):
        the warp with holes filled; non-hole pixels are bit-identical to
        ``(image * 255).round`` of the input.
        """
        B, _, H, W = image.shape
        image = image.to(self.device).float().clamp(0.0, 1.0)
        hole = (occlusion.to(self.device) > 0.5).float()

        img_lo = F.interpolate(image, size=(WORK, WORK), mode="nearest-exact")
        hole_lo = (F.interpolate(hole, size=(WORK, WORK), mode="nearest-exact") > 0).float()
        known_lo = 1.0 - hole_lo
        x = torch.cat([known_lo - 0.5, (img_lo * 2.0 - 1.0) * known_lo], dim=1)

        tiles = _tile(x)
        outs = []
        for i in range(0, tiles.shape[0], MAX_TILES):
            with torch.autocast(self.device):
                outs.append(self.model(tiles[i : i + MAX_TILES]).float())
        out = _untile(torch.cat(outs), B).clamp(-1.0, 1.0)

        # model output only inside the holes; upscale THE FILL, not the frame
        fill_lo = (out * 0.5 + 0.5) * hole_lo + img_lo * known_lo
        fill = F.interpolate(fill_lo, size=(H, W), mode="bicubic", align_corners=False).clamp(0.0, 1.0)

        # paste into slightly dilated holes so fill and warp blend across
        # the mask's aliased edge (same intent as the ProPainter composite)
        from app.stages.propainter_runner import dilate_mask

        paste = dilate_mask(hole > 0.5, kernel_size=3, iterations=2)
        result = torch.where(paste, fill, image)
        return (result * 255.0).round_().clamp_(0, 255).to(torch.uint8)
