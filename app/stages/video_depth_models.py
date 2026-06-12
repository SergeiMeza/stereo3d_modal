"""Per-frame video depth worker (GPU).

Runs single-image depth backends over every frame of a video and
writes the SAME output contract as VideoDepthWorker.generate: a
gray16le H.264 depth video at the model's working resolution (larger
value = closer, i.e. disparity convention), plus frame count / fps /
shape / scene-cut metadata.

Backends (request field ``depth_model``):

- ``da2-metric-indoor`` / ``da2-metric-outdoor`` — Depth-Anything-V2
  metric fine-tunes (Hypersim / VKITTI) via transformers; output is
  absolute depth in meters (sigmoid * max_depth: 20 m / 80 m).
- ``da3`` — Depth Anything 3 DA3MONO-LARGE; output is scale-free
  relative DEPTH (not disparity).
- ``da3-metric`` — DA3METRIC-LARGE; output is focal-normalized metric
  depth (meters = focal_px * output / 300). The focal factor is
  unknown for arbitrary footage but constant per video, and a constant
  scale cancels under the normalization below.

Unlike VideoDepthAnything there is no temporal window or cross-window
alignment — every frame is independent — so temporal coherence comes
entirely from the normalization policy:

- RELATIVE models: each frame's scale is only meaningful within the
  model's own output, so disparity ``d = 1 / max(depth, eps)`` is
  min-max normalized to [0, 1] over each SCENE (mirroring the VDA
  path's per-scene normalization); scene cuts reset the mapping so
  depth never bleeds across a cut.
- METRIC models: depth is converted to disparity ``d = 1 / max(depth,
  eps)`` and mapped through one JOB-WIDE affine range estimated up
  front from sampled frames:

      norm(d) = clip((d - p1) / (p99 - p1), 0, 1)

  where p1/p99 are the 1st/99th disparity percentiles over ~32 frames
  sampled uniformly across the whole video. A single global mapping
  means a given physical distance gets the same gray value in every
  scene — the cross-scene consistency that is the point of metric mode
  (percentiles, rather than min/max, so a few outlier pixels such as
  specular highlights cannot compress the usable range; ``eps`` only
  guards the division).

Checkpointing mirrors video_depth.py: one segment file per scene,
skipped if already complete on a retried call, lossless concat, and
the frame-count invariant enforced before returning.
"""

import time
from pathlib import Path

import modal

from app.common import jobs
from app.common.errors import fail_fast
from app.common.debug import get_logger, track
from app.common.ffmpeg_utils import concat_segments, count_frames
from app.common.storage import GPU_VOLUMES, cache_volume, hf_secret, slack_secret, job_cache_dir, safe_reload
from app.env import SCALEDOWN_WINDOW
from app.images import depth_models_image
from app.modal_app import app

logger = get_logger(__name__)

FRAME_DEPTH_GPU = "L40S"

# Request enum (api/main.py validates against this; "vda" routes to the
# original VideoDepthWorker and never reaches this module).
# exposed in the API; DA2-metric variants stay dormant (indoor/outdoor
# checkpoint split makes them operationally clumsy — user decision) but
# the loader still understands them for experiments
DEPTH_MODELS = ("da3", "da3-metric")
METRIC_MODELS = ("da2-metric-indoor", "da2-metric-outdoor", "da3-metric")

# Frames sampled for the job-wide disparity range (metric models).
RANGE_SAMPLE_FRAMES = 32
# Depth floor before inversion — guards 1/0 only; the percentile (or
# per-scene min-max) mapping handles outliers.
DEPTH_EPS = 1e-4

with depth_models_image.imports():
    import ffmpeg
    import torch
    import torchvision.transforms.v2 as v2
    from torchcodec.decoders import VideoDecoder

    from app.common.weights import ensure_da2_metric, ensure_da3


def _gray16_video_writer(h: int, w: int, fps, file: str | Path):
    """ffmpeg writer consuming raw gray16le frames on stdin.

    Duplicated from app/stages/depth_processor.py: importing that
    module would pull the vendored VideoDepthAnything stack (and its
    image deps) into this container for the sake of ten lines.
    """
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


def _detect_scene_ranges(path: Path, num_frames: int) -> list[tuple[int, int]]:
    """Scene boundaries [(first, last), ...] covering all frames.

    Runs up front (blocking) rather than concurrently with inference as
    DepthProcessor does: metric models need a sampling pre-pass before
    any depth is written anyway, and relative models need a scene's
    full extent before its normalization. Only internal cut positions
    are taken from scenedetect — the total comes from the decoder, so
    the ranges always sum to exactly ``num_frames``.
    """
    from scenedetect import AdaptiveDetector, SceneManager, open_video

    video = open_video(str(path))
    manager = SceneManager()
    manager.add_detector(AdaptiveDetector())
    manager.detect_scenes(video=video)
    cuts = sorted(
        {s.get_frames() for s, _ in manager.get_scene_list()[1:] if 0 < s.get_frames() < num_frames}
    )
    bounds = [0, *cuts, num_frames]
    return list(zip(bounds[:-1], bounds[1:]))


def _resize_shape(source_shape: tuple[int, int], input_size: int) -> tuple[int, int]:
    """Working resolution: short side = input_size, both multiples of
    14 (same rule as DepthProcessor)."""
    height, width = source_shape
    ratio = max(height, width) / min(height, width)
    if height > width:
        return (round(input_size * ratio / 14) * 14, input_size)
    return (input_size, round(input_size * ratio / 14) * 14)


@app.cls(
    gpu=FRAME_DEPTH_GPU,
    image=depth_models_image,
    volumes=GPU_VOLUMES,
    secrets=[hf_secret, slack_secret],
    cpu=4,
    memory=(4 * 1024, 128 * 1024),
    timeout=3600,
    scaledown_window=SCALEDOWN_WINDOW,
    retries=modal.Retries(max_retries=2, initial_delay=10.0, backoff_coefficient=2.0),
)
class FrameDepthWorker:
    model_name: str = modal.parameter(default="da3")

    @modal.enter()
    def load(self) -> None:
        if self.model_name not in DEPTH_MODELS:
            raise ValueError(f"unknown depth model {self.model_name!r}, expected one of {DEPTH_MODELS}")
        start = time.perf_counter()
        torch.backends.cudnn.benchmark = True
        self.metric = self.model_name in METRIC_MODELS
        if self.model_name.startswith("da2-metric"):
            from transformers import DepthAnythingForDepthEstimation

            variant = self.model_name.rsplit("-", 1)[-1]  # indoor | outdoor
            self.model = (
                DepthAnythingForDepthEstimation.from_pretrained(str(ensure_da2_metric(variant)))
                .to("cuda")
                .eval()
            )
        else:
            from depth_anything_3.api import DepthAnything3

            checkpoint = ensure_da3("mono-large", metric=self.model_name == "da3-metric")
            self.model = DepthAnything3.from_pretrained(str(checkpoint)).to("cuda")
        logger.info(f"🚀 {self.model_name} loaded in {time.perf_counter() - start:.1f}s")

    @modal.exit()
    def flush(self) -> None:
        # also runs on preemption (30s grace): persist finished scene
        # segments so the retried call can resume instead of restarting
        cache_volume.commit()

    @modal.method()
    @fail_fast
    def generate(
        self,
        job_id: str,
        input_path: str,
        input_size: int = 980,
        batch_size: int = 8,
        fps_rational: str | None = None,
        band: tuple[float, float] = (0.0, 1.0),
    ) -> dict:
        """Compute a per-frame depth video for ``input_path`` (a path
        inside the cache volume or bucket mount). Returns metadata
        including the cache-volume path of the gray16le depth video —
        the same contract as VideoDepthWorker.generate.

        Resumable: scene segments completed before a preemption are
        skipped on the retried call."""
        if input_size % 14 != 0:
            raise ValueError(f"input_size must be a multiple of 14, got {input_size}")
        safe_reload(cache_volume)  # pick up files written by upstream stages
        src = Path(input_path)
        if not src.exists():
            raise FileNotFoundError(f"input video not found: {src}")

        out = job_cache_dir(job_id) / "depth.mp4"
        decoder = VideoDecoder(str(src), device="cpu", num_ffmpeg_threads=0)
        meta = decoder.metadata
        if meta.height is None or meta.width is None:
            raise ValueError(f"could not read dimensions of {src}")
        source_shape = (meta.height, meta.width)
        total_frames = meta.num_frames
        fps = fps_rational or float(meta.average_fps)
        infer = self._make_infer(source_shape, input_size)

        # client-facing progress, throttled to one dict write per ~5s
        start = time.perf_counter()
        last_report = [0.0]

        def on_progress(done: int, total: int) -> None:
            now = time.perf_counter()
            if now - last_report[0] < 5 and done < total:
                return
            last_report[0] = now
            jobs.report_progress(
                job_id, "video_depth", done, total,
                rate_per_s=done / max(now - start, 1e-6), band=tuple(band),
            )

        with jobs.stage_timer(
            job_id, "video_depth",
            gpu=torch.cuda.get_device_name(0).replace("NVIDIA ", ""),
            input_size=input_size, model=self.model_name,
        ):
            ranges = _detect_scene_ranges(src, total_frames)
            jlog_cuts = [first for first, _ in ranges[1:]]
            logger.info(f"🔪 {len(ranges)} scene(s), cuts at {jlog_cuts or 'none'}")

            disp_range: tuple[float, float] | None = None
            if self.metric:
                disp_range = self._estimate_disparity_range(decoder, total_frames, batch_size, infer)
                logger.info(f"📏 job-wide disparity range (p1, p99) = {disp_range}")

            seg_dir = Path(f"{out}.segments")
            seg_dir.mkdir(parents=True, exist_ok=True)
            to_u16 = v2.ToDtype(torch.uint16, scale=True)
            depth_shape: tuple[int, int] | None = None

            segments: list[Path] = []
            num_frames = 0
            for first, last in ranges:
                seg = seg_dir / f"depth_{first:08d}_{last:08d}.mp4"
                if seg.exists() and count_frames(seg) == last - first:
                    logger.info(f"⏭  scene [{first}, {last}) already done, skipping")
                else:
                    disp = self._scene_disparity(
                        decoder, first, last, batch_size, infer,
                        on_batch=lambda done, base=num_frames: on_progress(base + done, total_frames),
                        align_frames=(disp_range is None),  # relative models only
                    )
                    normalized = self._normalize(disp, disp_range)
                    track(f"scene_depth[{first}:{last}]", normalized, logger)
                    if depth_shape is None:
                        depth_shape = (normalized.shape[-2], normalized.shape[-1])
                    writer = _gray16_video_writer(h=depth_shape[0], w=depth_shape[1], fps=fps, file=seg)
                    try:
                        writer.stdin.write(to_u16(normalized.unsqueeze(1)).numpy().tobytes())
                    finally:
                        writer.stdin.close()
                        writer.wait()
                    del disp, normalized
                segments.append(seg)
                num_frames += last - first
                cache_volume.commit()  # checkpoint: scene segment survives preemption

            if depth_shape is None:  # every segment was resumed from cache
                depth_shape = _resize_shape(source_shape, input_size)
            concat_segments(segments, out)
            written = count_frames(out)
            if written != num_frames:
                raise RuntimeError(
                    f"depth frame count mismatch: wrote {written}, expected {num_frames} "
                    "— refusing to continue (audio would drift out of sync)"
                )

        cache_volume.commit()
        del decoder  # drop decoder file handles before the next input
        torch.cuda.empty_cache()

        return {
            "depth_path": str(out),
            "num_frames": num_frames,
            "fps": float(meta.average_fps),
            "source_shape": list(source_shape),
            "depth_shape": list(depth_shape),
            "scene_cuts": jlog_cuts,
        }

    # -------------------------------------------------------- inference

    def _make_infer(self, source_shape: tuple[int, int], input_size: int):
        """Bind a ``(T, C, H, W) uint8 cpu -> (T, h, w) float32 cpu raw
        depth`` function for this call's video geometry."""
        if self.model_name.startswith("da2-metric"):
            resize_shape = _resize_shape(source_shape, input_size)
            # Official DA2 preprocessing: aspect-preserving resize to
            # multiples of 14 + ImageNet stats, no padding (≤7 px of
            # aspect distortion from the rounding).
            pre = torch.nn.Sequential(
                v2.ToDtype(torch.float32, scale=True),
                v2.Resize(size=resize_shape, interpolation=v2.InterpolationMode.BICUBIC, antialias=True),
                v2.Normalize(mean=[0.485, 0.456, 0.406], std=[0.229, 0.224, 0.225]),
            )
            return lambda frames: self._infer_da2(frames, pre)
        return lambda frames: self._infer_da3(frames, input_size)

    def _infer_da2(self, frames: "torch.Tensor", pre) -> "torch.Tensor":
        """transformers DA2-metric: returns depth in meters at the
        working resolution."""
        with torch.no_grad(), torch.autocast(device_type="cuda"):
            depth = self.model(pixel_values=pre(frames.cuda())).predicted_depth  # (T, h, w)
        return depth.float().cpu()

    def _infer_da3(self, frames: "torch.Tensor", input_size: int) -> "torch.Tensor":
        """DA3 api: its InputProcessor handles resize (short side =
        input_size via lower_bound_resize, matching the VDA working-
        resolution convention) + ImageNet normalization. With
        ``alt_start=-1`` in the mono/metric presets there is no
        cross-view attention, so batching frames cannot couple them."""
        imgs = [f.permute(1, 2, 0).contiguous().numpy() for f in frames]  # HWC RGB uint8
        prediction = self.model.inference(
            imgs, process_res=input_size, process_res_method="lower_bound_resize"
        )
        return torch.from_numpy(prediction.depth).float()  # (T, h, w)

    def _scene_disparity(
        self, decoder, first: int, last: int, batch_size: int, infer, on_batch,
        align_frames: bool = False,
    ) -> "torch.Tensor":
        """Raw disparity 1/depth (N, h, w) float16 on CPU for one scene.
        on_batch(done_in_scene) fires per inference batch.

        align_frames (relative models): each frame's disparity is
        affinely aligned (scale+shift least squares, VDA-style) to the
        previous aligned frame — per-frame relative outputs each have an
        arbitrary affine, and scene-wide min-max alone cannot remove
        that frame-to-frame flicker. Metric models skip this (their
        scale is already consistent).
        """
        chunks: list[torch.Tensor] = []
        ref: torch.Tensor | None = None
        for b0 in range(first, last, batch_size):
            b1 = min(b0 + batch_size, last)
            depth = infer(decoder[b0:b1])
            disp = depth.clamp(min=DEPTH_EPS).reciprocal().float()
            if align_frames:
                # Anchor every frame to the scene's FIRST frame: chaining
                # frame->previous compounds scale errors multiplicatively
                # and collapses the signal to a constant over long scenes
                # (observed). A fixed anchor cannot drift; the scale guard
                # rejects degenerate fits (e.g. momentary occlusions).
                aligned = []
                for i in range(disp.shape[0]):
                    d = disp[i]
                    if ref is None:
                        ref = d
                    else:
                        scale, shift = _affine_to_ref(d, ref)
                        if 0.25 < float(scale) < 4.0:
                            d = (d * scale + shift).clamp(min=0.0)
                    aligned.append(d)
                disp = torch.stack(aligned)
            # fp16 buffer: same precision the VDA path stores scenes at
            chunks.append(disp.to(torch.float16))
            on_batch(b1 - first)
        return torch.cat(chunks)

    def _normalize(self, disp: "torch.Tensor", disp_range: tuple[float, float] | None) -> "torch.Tensor":
        """Map disparity to [0, 1]: job-wide affine for metric models,
        per-scene min-max for relative ones (see module docstring)."""
        disp = disp.float()
        if disp_range is not None:
            lo, hi = disp_range
            return ((disp - lo) / (hi - lo)).clamp(0.0, 1.0)
        # robust percentiles, not min-max: one outlier frame in a scene
        # (imperfect alignment fit, model spike) would otherwise stretch
        # the range and crush the whole scene toward black (observed)
        flat = disp.flatten()
        if flat.numel() > 8_000_000:
            flat = flat[:: flat.numel() // 8_000_000 + 1]
        lo, hi = torch.quantile(flat, torch.tensor([0.005, 0.995])).tolist()
        return ((disp - lo) / (hi - lo + 1e-8)).clamp(0.0, 1.0)

    def _estimate_disparity_range(self, decoder, total_frames: int, batch_size: int, infer) -> tuple[float, float]:
        """Quick first pass for metric models: p1/p99 of disparity over
        ~RANGE_SAMPLE_FRAMES frames sampled uniformly across the video,
        so one affine mapping holds for the whole job."""
        n = min(RANGE_SAMPLE_FRAMES, total_frames)
        indices = sorted({round(i * (total_frames - 1) / max(n - 1, 1)) for i in range(n)})
        samples: list[torch.Tensor] = []
        for b0 in range(0, len(indices), batch_size):
            batch = indices[b0 : b0 + batch_size]
            frames = torch.stack([decoder[i] for i in batch])
            disp = infer(frames).clamp(min=DEPTH_EPS).reciprocal()
            # subsample pixels: torch.quantile is capped at ~16M elements
            flat = disp.flatten()
            samples.append(flat[:: max(1, flat.numel() // 500_000)])
        pooled = torch.cat(samples)
        lo, hi = torch.quantile(pooled, torch.tensor([0.01, 0.99])).tolist()
        if hi - lo < 1e-6:  # near-constant depth: avoid amplifying noise
            hi = lo + 1e-6
        return (lo, hi)


def _affine_to_ref(pred: "torch.Tensor", target: "torch.Tensor", max_px: int = 100_000):
    """Least-squares (scale, shift) mapping pred -> target over a pixel
    subsample (closed-form 2x2 solve, same math as the VDA alignment)."""
    import torch

    p = pred.flatten()
    t = target.flatten()
    stride = max(1, p.numel() // max_px)
    p, t = p[::stride].float(), t[::stride].float()
    a00 = (p * p).sum()
    a01 = p.sum()
    a11 = torch.tensor(float(p.numel()))
    b0 = (p * t).sum()
    b1 = t.sum()
    det = a00 * a11 - a01 * a01
    if det.abs() < 1e-12:
        return b0 / (a00 + 1e-6), torch.tensor(0.0)
    return (a11 * b0 - a01 * b1) / det, (-a01 * b0 + a00 * b1) / det
