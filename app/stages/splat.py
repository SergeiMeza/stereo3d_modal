"""Forward-warp stereo splatting.

Migrated from depth_splatting_v1.py (adapted from TencentARC
StereoCrafter). Raw forward warp + occlusion masks only — empirically
this beats any blur/feather post-processing, so none is applied here.
The occlusion masks exist solely to drive inpainting; "no inpainting"
mode just uses the warped frames directly.

Stereo mode is a plain string: "left" | "right" | "both".
"""

import torch
import torch.nn as nn

from Forward_Warp import forward_warp

LEFT = "left"
RIGHT = "right"
BOTH = "both"


class ForwardWarpStereo(nn.Module):
    def __init__(self, eps=1e-6, occlu_map=False):
        super().__init__()
        self.eps = eps
        self.occlu_map = occlu_map
        self.fw = forward_warp()

    def forward(self, im: torch.Tensor, disp: torch.Tensor, sign=-1):
        """
        im:   (B, C, H, W) float
        disp: (B, 1, H, W) float, signed horizontal disparity in pixels
        returns warped (B, C, H, W) [+ occlusion map (B, 1, H, W)]
        """
        im = im.contiguous()
        disp = disp.contiguous()
        weights_map = disp - disp.min()
        # 1.414 ** x instead of exp(x) avoids numerical overflow
        weights_map = (1.414) ** weights_map
        flow = sign * disp.squeeze(1)
        dummy_flow = torch.zeros_like(flow, requires_grad=False)
        flow = torch.stack((flow, dummy_flow), dim=-1)
        res_accum = self.fw(im * weights_map, flow)
        mask = self.fw(weights_map, flow)
        mask.clamp_(min=self.eps)
        res = res_accum / mask
        if not self.occlu_map:
            return res
        ones = torch.ones_like(disp, requires_grad=False)
        occlu_map = self.fw(ones, flow).clamp(0.0, 1.0)
        occlu_map = 1.0 - occlu_map
        return res, occlu_map


class DepthSplatter(nn.Module):
    """depthmap [0, 1] -> left/right warped views + occlusion masks."""

    def __init__(self):
        super().__init__()
        self.stereo_projector = ForwardWarpStereo(occlu_map=True).cuda()

    def forward(
        self,
        image: torch.Tensor,  # (B, C, H, W) uint8 or float [0,1]
        depthmap: torch.Tensor,  # (B, 1, H, W) float [0,1]
        disp: float,  # max displacement as a fraction of width
        stereo_mode: str = BOTH,
    ) -> tuple[
        torch.Tensor | None,  # left_image  float [0,1]
        torch.Tensor | None,  # right_image float [0,1]
        torch.Tensor | None,  # left occlusion map  float [0,1]
        torch.Tensor | None,  # right occlusion map float [0,1]
    ]:
        _, _, H, W = image.shape

        if image.dtype == torch.uint8:
            image = image.cuda() / 255.0
        if depthmap.dtype == torch.uint8:
            depthmap = depthmap.cuda() / 255.0

        max_disp = disp * W
        if stereo_mode == BOTH:
            max_disp *= 0.5

        # depth [0,1] -> disparity scaled to [-1, 0.5]: content sits
        # mostly behind the screen plane with moderate pop-out
        disp_map = depthmap * 1.5 - 1.0
        disp_map = max_disp * disp_map

        left_image = right_image = left_mask = right_mask = None

        if stereo_mode in (BOTH, LEFT):
            left_image, left_mask = self.stereo_projector(image, disp_map, sign=+1)
        if stereo_mode in (BOTH, RIGHT):
            right_image, right_mask = self.stereo_projector(image, disp_map, sign=-1)

        return left_image, right_image, left_mask, right_mask
