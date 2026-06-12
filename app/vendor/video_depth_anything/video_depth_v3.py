# Copyright (2025) Bytedance Ltd. and/or its affiliates

# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at

#     http://www.apache.org/licenses/LICENSE-2.0

# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
import torch
import torch.nn.functional as F
import torch.nn as nn

from .dinov2 import DINOv2
from .dpt_temporal import DPTHeadTemporal


# infer settings, do not change
INFER_LEN = 32
OVERLAP = 10
KEYFRAMES = [0, 12, 24, 25, 26, 27, 28, 29, 30, 31]
INTERP_LEN = 8


def compute_scale_and_shift(
    prediction: torch.Tensor,
    target: torch.Tensor,
    mask: torch.Tensor,
    scale_only: bool = False,
):
    """
    If scale_only is True, returns (scale, 0).
    Otherwise returns (scale, shift) that solves:
      mask * (scale * prediction + shift) ≈ mask * target  in least squares.
    """
    if scale_only:
        scale = compute_scale(prediction, target, mask)
        return scale, torch.tensor(0.0, dtype=torch.float32)
    else:
        return compute_scale_and_shift_full(prediction, target, mask)


def compute_scale(prediction: torch.Tensor, target: torch.Tensor, mask: torch.Tensor):
    """
    Solve for x in: sum(mask * (x * prediction) * prediction) = sum(mask * prediction * target)
    so that scale = x minimizes ||mask*(x*prediction - target)||².
    """
    prediction = prediction.float()
    target = target.float()
    mask = mask.float()

    a00 = torch.sum(mask * prediction * prediction)
    b0 = torch.sum(mask * prediction * target)

    # Add epsilon to avoid division by zero
    scale = b0 / (a00 + 1e-6)
    return scale


def compute_scale_and_shift_full(
    prediction: torch.Tensor, target: torch.Tensor, mask: torch.Tensor
):
    """
    Solve for (x0, x1) in the 2×2 linear system:
      [a00  a01] [x0] = [b0]
      [a01  a11] [x1]   [b1]
    where:
      a00 = sum(mask * prediction * prediction)
      a01 = sum(mask * prediction)
      a11 = sum(mask)
      b0  = sum(mask * prediction * target)
      b1  = sum(mask * target)
    Returns (x0, x1) = (scale, shift).
    """
    prediction = prediction.float()
    target = target.float()
    mask = mask.float()

    a00 = torch.sum(mask * prediction * prediction)
    a01 = torch.sum(mask * prediction)
    a11 = torch.sum(mask)

    b0 = torch.sum(mask * prediction * target)
    b1 = torch.sum(mask * target)

    det = a00 * a11 - a01 * a01
    if det.abs() < 1e-12:
        # Fallback to scale-only if the system is singular
        x0 = b0 / (a00 + 1e-6)
        x1 = torch.tensor(0.0, dtype=torch.float32)
    else:
        x0 = (a11 * b0 - a01 * b1) / det
        x1 = (-a01 * b0 + a00 * b1) / det

    return x0, x1


def get_interpolate_frames(
    frame_list_pre: list[torch.Tensor], frame_list_post: list[torch.Tensor]
) -> list[torch.Tensor]:
    """
    Given two lists of equally many frames (tensors of shape H×W),
    return a list of interpolated frames between each corresponding pair:
      for i in [0..N-1], weight w_i = i / (N-1), and
      output_i = (1 - w_i) * pre_i + w_i * post_i.
    """
    assert len(frame_list_pre) == len(frame_list_post)
    N = len(frame_list_pre)
    # Create weights [0, 1/(N-1), 2/(N-1), ..., 1]
    weights = torch.linspace(0.0, 1.0, steps=N, dtype=torch.float32)
    interpolated = []
    for i in range(N):
        w = weights[i]
        pre = frame_list_pre[i]
        post = frame_list_post[i]
        interp = pre * (1.0 - w) + post * w
        interpolated.append(interp)
    return interpolated


class VideoDepthAnything(nn.Module):
    def __init__(
        self,
        encoder="vitl",
        features=256,
        out_channels=[256, 512, 1024, 1024],
        use_bn=False,
        use_clstoken=False,
        num_frames=32,
        pe="ape",
    ):
        super(VideoDepthAnything, self).__init__()

        self.intermediate_layer_idx = {"vits": [2, 5, 8, 11], "vitl": [4, 11, 17, 23]}

        self.encoder = encoder
        self.pretrained = DINOv2(model_name=encoder)

        self.head = DPTHeadTemporal(
            self.pretrained.embed_dim,
            features,
            use_bn,
            out_channels=out_channels,
            use_clstoken=use_clstoken,
            num_frames=num_frames,
            pe=pe,
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        B, T, C, H, W = x.shape
        patch_h, patch_w = H // 14, W // 14
        features = self.pretrained.get_intermediate_layers(
            x.flatten(0, 1),
            self.intermediate_layer_idx[self.encoder],
            return_class_token=True,
        )
        depth = self.head(features, patch_h, patch_w, T)
        depth = F.interpolate(depth, size=(H, W), mode="bilinear", align_corners=True)
        depth = F.relu(depth)
        return depth.squeeze(1).unflatten(0, (B, T))  # return shape [B, T, H, W]
