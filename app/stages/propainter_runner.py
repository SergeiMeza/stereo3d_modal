"""ProPainter video inpainting runner.

Migrated from video_inpainting_model_v4 (project A's latest/best
quality video inpainting). Fills the occlusion holes left by forward
warping using optical-flow-guided propagation + a sparse transformer.

GPU-only module; import inside stereo_image containers.
"""

from __future__ import annotations

import numpy as np
import torch
import torch.nn.functional as F

from app.common.debug import get_logger
from app.common.weights import ensure_propainter
from app.vendor.propainter.model.modules.flow_comp_raft import RAFT_bi
from app.vendor.propainter.model.propainter import InpaintGenerator
from app.vendor.propainter.model.recurrent_flow_completion import (
    RecurrentFlowCompleteNet,
)

logger = get_logger(__name__)


def get_ref_index(
    mid_neighbor_id: int,
    neighbor_ids: list[int],
    length: int,
    ref_stride: int = 10,
    ref_num: int = -1,
) -> list[int]:
    """Pick global reference frames for the transformer pass."""
    ref_index = []
    if ref_num == -1:
        for i in range(0, length, ref_stride):
            if i not in neighbor_ids:
                ref_index.append(i)
    else:
        start_idx = max(0, mid_neighbor_id - ref_stride * (ref_num // 2))
        end_idx = min(length, mid_neighbor_id + ref_stride * (ref_num // 2))
        for i in range(start_idx, end_idx, ref_stride):
            if i not in neighbor_ids:
                if len(ref_index) > ref_num:
                    break
                ref_index.append(i)
    return ref_index


def dilate_mask(mask: torch.Tensor, kernel_size: int = 3, iterations: int = 2) -> torch.Tensor:
    """Binary-dilate an occlusion mask so isolated warp holes merge into
    contiguous regions ProPainter can fill. Returns a bool tensor with
    the input's batch/channel layout."""
    squeeze_batch = False
    if mask.dim() == 2:
        mask = mask.unsqueeze(0).unsqueeze(0)
    elif mask.dim() == 3:
        mask = mask.unsqueeze(0)
        squeeze_batch = True

    if mask.dtype is torch.bool:
        binary = mask
    elif mask.max() > 1.0:
        binary = mask > 253
    else:
        binary = mask > 0.99

    dilated = binary.float()
    kernel = torch.ones(1, 1, kernel_size, kernel_size, device=mask.device)
    for _ in range(iterations):
        dilated = F.conv2d(dilated, kernel, padding=kernel_size // 2)
        dilated = (dilated > 0).float()

    if squeeze_batch:
        dilated = dilated.squeeze(0)
    return dilated.bool()


class ProPainterModels:
    """The three networks ProPainter inference needs."""

    def __init__(self, device: str = "cuda"):
        self.device = device
        paths = ensure_propainter()

        self.generator = InpaintGenerator(model_path=str(paths["propainter"])).to(device)
        self.generator.eval()

        self.raft = RAFT_bi(str(paths["raft"]), device)

        flow_net = RecurrentFlowCompleteNet(str(paths["flow_completion"]))
        for p in flow_net.parameters():
            p.requires_grad = False
        self.flow_complete = flow_net.to(device).eval()


@torch.no_grad()
def inpaint_window(
    models: ProPainterModels,
    frames_u8: torch.Tensor,  # (T, 3, H, W) uint8 on GPU
    flow_masks: torch.Tensor,  # (T, 1, H, W) bool — raw occlusion
    dilated_masks: torch.Tensor,  # (T, 1, H, W) bool — dilated occlusion
    raft_iter: int = 20,
    neighbor_length: int = 10,
    ref_stride: int = 10,
    subvideo_length: int | None = None,
) -> list[np.ndarray]:
    """Inpaint one window of frames. Returns uint8 HWC numpy frames.

    Mirrors the reference ProPainter inference loop: bidirectional RAFT
    flow → recurrent flow completion → flow-guided image propagation →
    sparse transformer over neighbor + reference frames.
    """
    video_length, _, h, w = frames_u8.shape
    if subvideo_length is None:
        subvideo_length = video_length

    ori_frames = [f.permute(1, 2, 0).cpu().numpy().astype(np.uint8) for f in frames_u8]

    frames = frames_u8.unsqueeze(0).float() / 255.0
    frames = frames * 2 - 1  # [-1, 1]
    flow_masks = flow_masks.unsqueeze(0).float()
    masks_dilated = dilated_masks.unsqueeze(0).float()
    torch.cuda.empty_cache()

    # ---- bidirectional flow (chunked: RAFT is memory hungry at high res)
    if w <= 640:
        short_clip_len = 12
    elif w <= 720:
        short_clip_len = 8
    elif w <= 1280:
        short_clip_len = 4
    else:
        short_clip_len = 2

    if video_length > short_clip_len:
        gt_flows_f_list, gt_flows_b_list = [], []
        for f in range(0, video_length, short_clip_len):
            end_f = min(video_length, f + short_clip_len)
            if f == 0:
                flows_f, flows_b = models.raft(frames[:, f:end_f], iters=raft_iter)
            else:
                flows_f, flows_b = models.raft(frames[:, f - 1 : end_f], iters=raft_iter)
            gt_flows_f_list.append(flows_f)
            gt_flows_b_list.append(flows_b)
            torch.cuda.empty_cache()
        gt_flows_bi = (torch.cat(gt_flows_f_list, dim=1), torch.cat(gt_flows_b_list, dim=1))
    else:
        gt_flows_bi = models.raft(frames, iters=raft_iter)
        torch.cuda.empty_cache()

    # ---- flow completion
    flow_length = gt_flows_bi[0].size(1)
    if flow_length > subvideo_length:
        pred_flows_f, pred_flows_b = [], []
        pad_len = 5
        for f in range(0, flow_length, subvideo_length):
            s_f = max(0, f - pad_len)
            e_f = min(flow_length, f + subvideo_length + pad_len)
            pad_len_s = max(0, f) - s_f
            pad_len_e = e_f - min(flow_length, f + subvideo_length)
            sub_flows = (gt_flows_bi[0][:, s_f:e_f], gt_flows_bi[1][:, s_f:e_f])
            pred_sub, _ = models.flow_complete.forward_bidirect_flow(
                sub_flows, flow_masks[:, s_f : e_f + 1]
            )
            pred_sub = models.flow_complete.combine_flow(
                sub_flows, pred_sub, flow_masks[:, s_f : e_f + 1]
            )
            pred_flows_f.append(pred_sub[0][:, pad_len_s : e_f - s_f - pad_len_e])
            pred_flows_b.append(pred_sub[1][:, pad_len_s : e_f - s_f - pad_len_e])
            torch.cuda.empty_cache()
        pred_flows_bi = (torch.cat(pred_flows_f, dim=1), torch.cat(pred_flows_b, dim=1))
    else:
        pred_flows_bi, _ = models.flow_complete.forward_bidirect_flow(gt_flows_bi, flow_masks)
        pred_flows_bi = models.flow_complete.combine_flow(gt_flows_bi, pred_flows_bi, flow_masks)
        torch.cuda.empty_cache()

    # ---- flow-guided image propagation
    masked_frames = frames * (1 - masks_dilated)
    subvideo_length_img_prop = min(100, subvideo_length)
    if video_length > subvideo_length_img_prop:
        updated_frames_list, updated_masks_list = [], []
        pad_len = 10
        for f in range(0, video_length, subvideo_length_img_prop):
            s_f = max(0, f - pad_len)
            e_f = min(video_length, f + subvideo_length_img_prop + pad_len)
            pad_len_s = max(0, f) - s_f
            pad_len_e = e_f - min(video_length, f + subvideo_length_img_prop)

            b, t, _, _, _ = masks_dilated[:, s_f:e_f].size()
            sub_flows = (pred_flows_bi[0][:, s_f : e_f - 1], pred_flows_bi[1][:, s_f : e_f - 1])
            prop_imgs_sub, updated_local_masks_sub = models.generator.img_propagation(
                masked_frames[:, s_f:e_f], sub_flows, masks_dilated[:, s_f:e_f], "nearest"
            )
            updated_frames_sub = (
                frames[:, s_f:e_f] * (1 - masks_dilated[:, s_f:e_f])
                + prop_imgs_sub.view(b, t, 3, h, w) * masks_dilated[:, s_f:e_f]
            )
            updated_masks_sub = updated_local_masks_sub.view(b, t, 1, h, w)
            updated_frames_list.append(updated_frames_sub[:, pad_len_s : e_f - s_f - pad_len_e])
            updated_masks_list.append(updated_masks_sub[:, pad_len_s : e_f - s_f - pad_len_e])
            torch.cuda.empty_cache()
        updated_frames = torch.cat(updated_frames_list, dim=1)
        updated_masks = torch.cat(updated_masks_list, dim=1)
    else:
        b, t, _, _, _ = masks_dilated.size()
        prop_imgs, updated_local_masks = models.generator.img_propagation(
            masked_frames, pred_flows_bi, masks_dilated, "nearest"
        )
        updated_frames = (
            frames * (1 - masks_dilated) + prop_imgs.view(b, t, 3, h, w) * masks_dilated
        )
        updated_masks = updated_local_masks.view(b, t, 1, h, w)
        torch.cuda.empty_cache()

    # ---- neighbor + reference transformer pass
    comp_frames: list[np.ndarray | None] = [None] * video_length
    neighbor_stride = neighbor_length // 2
    ref_num = subvideo_length // ref_stride if video_length > subvideo_length else -1

    for f in range(0, video_length, neighbor_stride):
        neighbor_ids = list(
            range(max(0, f - neighbor_stride), min(video_length, f + neighbor_stride + 1))
        )
        ref_ids = get_ref_index(f, neighbor_ids, video_length, ref_stride, ref_num)
        selected_imgs = updated_frames[:, neighbor_ids + ref_ids]
        selected_masks = masks_dilated[:, neighbor_ids + ref_ids]
        selected_update_masks = updated_masks[:, neighbor_ids + ref_ids]
        selected_pred_flows_bi = (
            pred_flows_bi[0][:, neighbor_ids[:-1]],
            pred_flows_bi[1][:, neighbor_ids[:-1]],
        )

        l_t = len(neighbor_ids)
        pred_img = models.generator(
            selected_imgs, selected_pred_flows_bi, selected_masks, selected_update_masks, l_t
        )
        pred_img = pred_img.view(-1, 3, h, w)
        pred_img = (pred_img + 1) / 2
        pred_img = pred_img.cpu().permute(0, 2, 3, 1).numpy() * 255
        binary_masks = (
            masks_dilated[0, neighbor_ids].cpu().permute(0, 2, 3, 1).numpy().astype(np.uint8)
        )
        for i, idx in enumerate(neighbor_ids):
            img = pred_img[i].astype(np.uint8) * binary_masks[i] + ori_frames[idx] * (
                1 - binary_masks[i]
            )
            if comp_frames[idx] is None:
                comp_frames[idx] = img
            else:
                comp_frames[idx] = (
                    comp_frames[idx].astype(np.float32) * 0.5 + img.astype(np.float32) * 0.5
                )
            comp_frames[idx] = comp_frames[idx].astype(np.uint8)
        torch.cuda.empty_cache()

    return comp_frames
