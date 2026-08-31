"""Stereo warp-method job parameter (``warp``) — names + validation.

Pure python, no torch: imported by the API (web_image), the CPU
coordinator (media_image) and the GPU workers alike. The methods
themselves live in splat.py (forward, CUDA) and gather.py (backward,
torch CPU/GPU).
"""

WARP_FORWARD = "forward"  # DepthSplatter scatter + occlusion masks (inpaintable)
WARP_BACKWARD = "backward"  # BackwardWarpStereo gather — no masks, no inpainting
WARP_METHODS = (WARP_FORWARD, WARP_BACKWARD)


def validate_warp(warp: str, inpaint: str | None = None) -> None:
    """Reject an unknown ``warp`` and the contradictory combination
    ``warp="backward"`` + an inpainting model. The backward warp produces
    no occlusion masks — there is nothing for ProPainter/LAMA/M2SVid to
    fill — so asking for both is a caller bug, not something to ignore
    silently (the inpaint pass would run over nothing and still be
    billed). ``inpaint=None`` skips the pairing check (still images have
    no inpaint knob; LAMA is implied by the forward warp)."""
    if warp not in WARP_METHODS:
        raise ValueError(f"unknown warp method: {warp!r} (expected one of {WARP_METHODS})")
    if warp == WARP_BACKWARD and inpaint not in (None, "none"):
        raise ValueError(
            f"warp='backward' produces no occlusion masks, so inpaint={inpaint!r} "
            "has nothing to fill — use inpaint='none' with the backward warp, "
            "or warp='forward' to inpaint"
        )
