"""Stereo pair composition helpers (torch, GPU or CPU).

Output formats:
- "lr" / "tb"           — full side-by-side / top-bottom
- "half_lr" / "half_tb" — squeezed variants (compatible with most TVs)
- "anaglyph"            — Dubois optimized red-cyan
"""

import torch
import torchvision.transforms.v2 as v2

FORMATS = ("lr", "tb", "half_lr", "half_tb", "anaglyph")
# The gateway's public vocabulary calls side-by-side "sbs" (the video
# pipeline's name for the same layout). Accept it as an alias so one
# format vocabulary works across video and image conversions; outputs
# keep the name the caller asked for.
ALIASES = {"sbs": "lr", "half_sbs": "half_lr"}

# Dubois optimization matrices minimize ghosting for red-cyan glasses.
_DUBOIS_LEFT = torch.tensor(
    [[0.437, 0.449, 0.164], [-0.062, -0.062, -0.024], [-0.048, -0.050, -0.017]]
)
_DUBOIS_RIGHT = torch.tensor(
    [[-0.011, -0.032, -0.007], [0.377, 0.761, 0.009], [-0.026, -0.093, 1.234]]
)


def compose_stereo(left: torch.Tensor, right: torch.Tensor, output_format: str) -> torch.Tensor:
    """Compose (1, 3, H, W) uint8 left/right frames into one frame."""
    if left.dim() == 3:
        left = left.unsqueeze(0)
    if right.dim() == 3:
        right = right.unsqueeze(0)
    if left.shape != right.shape:
        raise ValueError(f"left {tuple(left.shape)} != right {tuple(right.shape)}")

    output_format = ALIASES.get(output_format, output_format)

    if output_format == "lr":
        return torch.cat((left, right), dim=3)
    if output_format == "tb":
        return torch.cat((left, right), dim=2)

    height, width = left.shape[2], left.shape[3]
    if output_format == "half_lr":
        resize = v2.Resize((height, width // 2), interpolation=v2.InterpolationMode.BICUBIC)
        return torch.cat((resize(left), resize(right)), dim=3)
    if output_format == "half_tb":
        resize = v2.Resize((height // 2, width), interpolation=v2.InterpolationMode.BICUBIC)
        return torch.cat((resize(left), resize(right)), dim=2)
    if output_format == "anaglyph":
        ana = dubois_anaglyph(left.float() / 255.0, right.float() / 255.0)
        return (ana * 255).clamp(0, 255).to(torch.uint8)

    raise ValueError(f"unknown output format {output_format!r}, expected one of {FORMATS}")


def dubois_anaglyph(left: torch.Tensor, right: torch.Tensor) -> torch.Tensor:
    """Dubois red-cyan anaglyph. Inputs (B, 3, H, W) float [0, 1]."""
    device = left.device
    m_left = _DUBOIS_LEFT.to(device)
    m_right = _DUBOIS_RIGHT.to(device)

    b, _, h, w = left.shape
    left_px = left.permute(0, 2, 3, 1).reshape(-1, 3)
    right_px = right.permute(0, 2, 3, 1).reshape(-1, 3)
    result = torch.clamp(left_px @ m_left.t() + right_px @ m_right.t(), 0.0, 1.0)
    return result.reshape(b, h, w, 3).permute(0, 3, 1, 2)


def colorize_depth(depth: torch.Tensor, colormap: str = "inferno") -> torch.Tensor:
    """(1, 1, H, W) or (H, W) float [0,1] -> (3, H, W) uint8 colormapped."""
    import matplotlib.cm as cm

    d = depth.squeeze().cpu().numpy()
    colored = cm.get_cmap(colormap)(d)[..., :3]  # (H, W, 3) float
    return (torch.from_numpy(colored).permute(2, 0, 1) * 255).to(torch.uint8)
