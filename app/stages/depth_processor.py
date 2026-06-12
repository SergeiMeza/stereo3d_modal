"""Scene-aware streaming video depth estimation.

Migrated from scene_video_depth.DepthProcessor (project A, latest
depth pipeline = video_depth_model_v2). Uses the vendored
VideoDepthAnything v3 inference scheme:

- the video is processed in windows of INFER_LEN=32 frames with
  OVERLAP=10 frames of context carried between windows,
- depth across windows is aligned with a least-squares scale/shift fit
  on keyframes, and the INTERP_LEN=8 boundary frames are blended,
- scene cuts (detected concurrently on CPU) reset the alignment so
  depth never bleeds across a cut,
- frames stream through a generator and are written incrementally as a
  16-bit grayscale video, so memory stays bounded for long clips.

This module imports torch and must only be imported inside GPU
containers (video_depth_image).
"""

from __future__ import annotations

import math
import queue
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Generator, Iterator, Literal

import ffmpeg
import torch
import torchvision.transforms.v2 as v2
from torchcodec.decoders import VideoDecoder
from tqdm import tqdm

from app.common.debug import get_logger, track
from app.vendor.video_depth_anything.video_depth_v3 import (
    INFER_LEN,
    INTERP_LEN,
    KEYFRAMES,
    OVERLAP,
    VideoDepthAnything,
    compute_scale_and_shift,
    get_interpolate_frames,
)

logger = get_logger(__name__)

torch.backends.cudnn.benchmark = True
torch.backends.cudnn.enabled = True

Encoder = Literal["vits", "vitl"]

MODEL_CONFIGS: dict[str, dict] = {
    "vits": {"encoder": "vits", "features": 64, "out_channels": [48, 96, 192, 384]},
    "vitl": {"encoder": "vitl", "features": 256, "out_channels": [256, 512, 1024, 1024]},
}


def load_video_depth_model(checkpoint: Path, encoder: Encoder, device: str = "cuda") -> VideoDepthAnything:
    if encoder not in MODEL_CONFIGS:
        raise ValueError(f"unknown encoder {encoder!r}, expected one of {list(MODEL_CONFIGS)}")
    model = VideoDepthAnything(**MODEL_CONFIGS[encoder])
    model.load_state_dict(torch.load(checkpoint, map_location="cpu"), strict=True)
    return model.to(device).eval()


@dataclass
class DepthResult:
    """Metadata returned after a full depth pass."""

    num_frames: int = 0
    fps: float = 0.0
    source_shape: tuple[int, int] = (0, 0)  # (H, W)
    depth_shape: tuple[int, int] = (0, 0)  # (H, W) of the written depth video
    scene_cuts: list[int] = field(default_factory=list)  # frame indices


class DepthProcessor:
    """Streams scene-aligned depth for one video file."""

    # Alignment constants derived from the model's inference scheme. Do not change.
    ALIGN_LEN = OVERLAP - INTERP_LEN
    KF_ALIGN_LIST = KEYFRAMES[: OVERLAP - INTERP_LEN]
    FRAME_STEP = INFER_LEN - OVERLAP

    def __init__(
        self,
        path: Path,
        model: VideoDepthAnything,
        input_size: int = 980,
        device: str = "cuda",
        fp32: bool = False,
    ):
        if input_size % 14 != 0:
            raise ValueError(f"input_size must be a multiple of 14, got {input_size}")
        self.path = Path(path)
        self.model = model
        self.input_size = input_size
        self.device = device
        self.fp32 = fp32
        self.to_u16 = v2.ToDtype(torch.uint16, scale=True)

        self.decoder = VideoDecoder(str(self.path), device="cpu", num_ffmpeg_threads=0)
        self.scene_queue: queue.Queue[int | None] = queue.Queue()
        self.scene_cuts: list[int] = []

        self._build_transforms()
        self._start_scene_detection()

    # ------------------------------------------------------------ setup

    def _build_transforms(self) -> None:
        meta = self.decoder.metadata
        height, width = meta.height, meta.width
        if height is None or width is None:
            raise ValueError(f"could not read dimensions of {self.path}")
        self.source_shape = (height, width)

        ratio = max(height, width) / min(height, width)
        pad_h = round(height / 14) * 14 - height
        pad_w = round(width / 14) * 14 - width

        if height > width:
            resize_shape = (round(self.input_size * ratio / 14) * 14, self.input_size)
        else:
            resize_shape = (self.input_size, round(self.input_size * ratio / 14) * 14)
        self.resize_shape: tuple[int, int] = resize_shape

        dtype = torch.float32 if self.fp32 else torch.float16
        self.pre_process = torch.nn.Sequential(
            v2.ToDtype(dtype, scale=True),
            v2.Pad(
                padding=(
                    -math.ceil(-pad_w / 2),
                    math.ceil(pad_w / 2),
                    -math.ceil(-pad_h / 2),
                    math.ceil(pad_h / 2),
                ),
                padding_mode="reflect",
            ),
            v2.Resize(size=resize_shape, interpolation=v2.InterpolationMode.BICUBIC, antialias=True),
            v2.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
        )

    def _start_scene_detection(self) -> None:
        """Detect scene cuts on CPU concurrently with GPU inference."""
        from scenedetect import AdaptiveDetector, SceneManager, open_video

        num_frames = self.decoder.metadata.num_frames

        def worker() -> None:
            def on_new_scene(_frame_img, frame_num: int) -> None:
                logger.info(f"🔪 scene cut at frame {frame_num}")
                self.scene_cuts.append(frame_num)
                self.scene_queue.put(frame_num)

            video = open_video(str(self.path))
            manager = SceneManager()
            manager.add_detector(AdaptiveDetector())
            manager.detect_scenes(video=video, callback=on_new_scene)
            self.scene_queue.put(num_frames)  # final pseudo-cut: end of video
            self.scene_queue.put(None)  # sentinel: detection finished

        threading.Thread(target=worker, daemon=True, name="scene-detect").start()

    # -------------------------------------------------------- inference

    def _process_scene(self, first: int, last: int) -> Generator[torch.Tensor, None, None]:
        """Yield aligned depth tensors (N, 1, h, w) for frames [first, last)."""
        device = self.device
        pre_input: torch.Tensor | None = None
        aligned: list[torch.Tensor] = []
        ref_align: list[torch.Tensor] = []
        emitted = 0
        scene_len = last - first

        for frame_id in tqdm(
            range(first, last, self.FRAME_STEP), desc=f"✨ depth [{first}, {last})"
        ):
            overshoot = frame_id + INFER_LEN - last
            if overshoot > 0:
                cur_input = (
                    torch.cat(
                        [
                            self.decoder[frame_id:last],
                            self.decoder[last - 1].repeat(overshoot, 1, 1, 1),
                        ]
                    )
                    .unsqueeze(0)
                    .to(device)
                )
            else:
                cur_input = self.decoder[frame_id : frame_id + INFER_LEN].unsqueeze(0).to(device)

            cur_input = self.pre_process(cur_input)
            if pre_input is not None:
                cur_input[:, :OVERLAP, ...] = pre_input[:, KEYFRAMES, ...]
            pre_input = cur_input

            with torch.no_grad(), torch.autocast(device_type=device, enabled=not self.fp32):
                depth = self.model.forward(cur_input)  # (1, INFER_LEN, h, w)

            depth = depth.to(cur_input.dtype)
            depth = depth.flatten(0, 1).unsqueeze(1)  # (INFER_LEN, 1, h, w)

            if not aligned:
                aligned.extend(depth[i] for i in range(INFER_LEN))
                ref_align.extend(depth[kf_id] for kf_id in self.KF_ALIGN_LIST)
            else:
                pred = depth[: self.ALIGN_LEN].reshape(-1)
                target = torch.cat(ref_align, dim=0).reshape(-1)
                mask = torch.ones_like(target)
                scale, shift = compute_scale_and_shift(pred, target, mask)

                pre_blend = aligned[-INTERP_LEN:]
                post_blend = [
                    (depth[i] * scale + shift).clamp(min=0.0)
                    for i in range(self.ALIGN_LEN, OVERLAP)
                ]
                aligned[-INTERP_LEN:] = get_interpolate_frames(pre_blend, post_blend)

                for i in range(OVERLAP, INFER_LEN):
                    aligned.append((depth[i] * scale + shift).clamp(min=0.0))

                ref_align = ref_align[:1] + [
                    (depth[kf_id] * scale + shift).clamp(min=0.0)
                    for kf_id in self.KF_ALIGN_LIST[1:]
                ]

            final_frames = torch.stack(aligned[:-INTERP_LEN], dim=0)
            if emitted + final_frames.shape[0] > scene_len:
                final_frames = final_frames[: scene_len - emitted]
            emitted += final_frames.shape[0]
            yield final_frames
            aligned = aligned[-INTERP_LEN:]

    def scenes(self) -> Iterator[tuple[torch.Tensor, int, int]]:
        """Iterate scenes; yields (normalized depth (N,1,h,w) on CPU, first, last)."""
        first = 0
        while True:
            item = self.scene_queue.get()
            if item is None:
                break
            last = item
            if last <= first:
                continue
            chunk = torch.cat([t.to("cpu") for t in self._process_scene(first, last)])
            lo, hi = chunk.min(), chunk.max()
            normalized = (chunk - lo) / (hi - lo + 1e-8)
            track(f"scene_depth[{first}:{last}]", normalized, logger)
            yield normalized, first, last
            first = last

    def write_depth_video(self, output: Path) -> DepthResult:
        """Run the full pass, writing a gray16le H.264 depth video."""
        meta = self.decoder.metadata
        fps = float(meta.average_fps)
        h, w = self.resize_shape
        writer = gray16_video_writer(h=h, w=w, fps=fps, file=output)
        num_frames = 0
        try:
            for normalized, first, last in self.scenes():
                writer.stdin.write(self.to_u16(normalized).numpy().tobytes())
                num_frames += last - first
        finally:
            writer.stdin.close()
            writer.wait()
        return DepthResult(
            num_frames=num_frames,
            fps=fps,
            source_shape=self.source_shape,
            depth_shape=self.resize_shape,
            scene_cuts=sorted(self.scene_cuts),
        )


def gray16_video_writer(h: int, w: int, fps: float, file: str | Path) -> subprocess.Popen:
    """ffmpeg writer consuming raw gray16le frames on stdin."""
    return (
        ffmpeg.input("pipe:", format="rawvideo", pix_fmt="gray16le", s=f"{w}x{h}", r=fps)
        .output(
            str(file),
            pix_fmt="gray16le",
            vcodec="libx264",
            preset="slow",
            crf=18,
            vsync="cfr",
            r=fps,
        )
        .global_args("-loglevel", "error", "-threads", "0")
        .overwrite_output()
        .run_async(pipe_stdin=True)
    )
