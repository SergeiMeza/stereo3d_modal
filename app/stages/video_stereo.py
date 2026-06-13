"""Video stereo worker (GPU): forward-warp splatting + inpainting.

Consumes the source video plus the depth video produced by
VideoDepthWorker and writes a full-width side-by-side (SBS) stereo
video to the cache volume.

Inpainting modes:
- "propainter" — flow-guided video inpainting (best quality, slower).
  Runs at a bounded working resolution then upsamples the filled
  regions back to source resolution.
- "none" — raw forward warp only (no masks, no blurs). Empirically a
  strong baseline and the fastest path.
"""

import time
from pathlib import Path

import modal

from app.common import jobs
from app.common.errors import fail_fast
from app.common.debug import get_logger, track
from app.common.storage import GPU_VOLUMES, cache_volume, hf_secret, slack_secret, job_cache_dir, safe_reload
from app.env import SCALEDOWN_WINDOW
from app.images import stereo_image
from app.modal_app import app

logger = get_logger(__name__)

VIDEO_STEREO_GPU = "L40S"

with stereo_image.imports():
    import ffmpeg
    import torch
    import torchvision.transforms.v2 as v2
    from torchcodec.decoders import VideoDecoder

    from app.stages import propainter_runner
    from app.stages.splat import BOTH, DEFAULT_PLACEMENT, LEFT, RIGHT, DepthSplatter


def _pick_batch_size(num_frames: int) -> int:
    """Largest n in [20, 30] such that the final batch is not a single
    frame (a 1-frame ProPainter window has no flow to work with)."""
    for n in range(30, 19, -1):
        if num_frames % n != 1:
            return n
    return 20


# target segment length in frames (~10s @ 24fps); each segment is an
# independently written, resumable checkpoint
SEGMENT_FRAMES = 240


def _scene_param_lookup(
    scene_params: list[dict],
    default_displacement: float,
    default_placement: tuple[float, float],
):
    """Build ``index -> (displacement, placement)`` over absolute frame
    indices from a per-shot depth script (profile_scenes output).

    Lookup is by absolute index — segment/batch boundaries are aligned
    to ProPainter batches, NOT scene cuts, so a batch can straddle two
    shots and each frame must resolve its own shot. Frames not covered
    by any shot (defensive: the script should tile the video) fall back
    to the job-level defaults rather than failing mid-render.

    Intra-shot ramps: a span carrying a "keyframes" list (dynamic shots
    from profile_scenes, entries {"index", "displacement", "placement"})
    does not hold one constant setting — displacement and each placement
    component are linearly interpolated between the bracketing keyframes
    by frame index, clamped to the first/last keyframe's values outside
    their range, so a shot whose depth composition changes ramps
    smoothly instead of using one static compromise. Spans without
    "keyframes" behave exactly as before. Pure function of its inputs.
    """
    spans = sorted(
        (
            (
                int(sp["first"]),
                int(sp["last"]),
                float(sp["displacement"]),
                tuple(float(v) for v in sp["placement"]),
                tuple(sorted(
                    (
                        int(kf["index"]),
                        float(kf["displacement"]),
                        tuple(float(v) for v in kf["placement"]),
                    )
                    for kf in sp["keyframes"]
                )) if sp.get("keyframes") else None,
            )
            for sp in scene_params
        ),
        key=lambda span: (span[0], span[1]),
    )

    def lookup(index: int) -> tuple[float, tuple[float, float]]:
        for first, last, disp, placement, keyframes in spans:
            if first <= index < last:
                if not keyframes:
                    return disp, placement
                if index <= keyframes[0][0]:
                    return keyframes[0][1], keyframes[0][2]
                if index >= keyframes[-1][0]:
                    return keyframes[-1][1], keyframes[-1][2]
                # half-open brackets: an index exactly on a keyframe is
                # t=0 of the next bracket, returning its values exactly
                for (i0, d0, p0), (i1, d1, p1) in zip(keyframes, keyframes[1:]):
                    if i0 <= index < i1:
                        t = (index - i0) / (i1 - i0)
                        return (
                            d0 + (d1 - d0) * t,
                            (
                                p0[0] + (p1[0] - p0[0]) * t,
                                p0[1] + (p1[1] - p0[1]) * t,
                            ),
                        )
        return default_displacement, default_placement

    return lookup


@app.cls(
    gpu=VIDEO_STEREO_GPU,
    image=stereo_image,
    volumes=GPU_VOLUMES,
    secrets=[hf_secret, slack_secret],
    cpu=4,
    memory=(4 * 1024, 128 * 1024),
    # Per-WORKER timeout. Fan-out caps a chunk at STEREO_CHUNK_FRAMES
    # (~1200f ≈ 33 min ProPainter at 0.6 fps); a non-fanned-out
    # sequential run handles the WHOLE video in one worker, so this
    # ceiling must cover the longest sequential clip we'd run without
    # fan-out (≤1500f). 2h leaves wide margin for both + model load.
    timeout=2 * 3600,
    scaledown_window=SCALEDOWN_WINDOW,
    env={"PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"},
    retries=modal.Retries(max_retries=2, initial_delay=10.0, backoff_coefficient=2.0),
)
class VideoStereoWorker:
    @modal.enter()
    def load(self) -> None:
        start = time.perf_counter()
        torch.backends.cudnn.benchmark = True
        self.splatter = DepthSplatter().eval()
        self.propainter = propainter_runner.ProPainterModels()
        logger.info(f"🚀 stereo worker ready in {time.perf_counter() - start:.1f}s")

    @modal.exit()
    def flush(self) -> None:
        # also runs on preemption (30s grace): persist finished SBS
        # segments so the retried call resumes instead of restarting
        cache_volume.commit()

    @modal.method()
    @fail_fast
    def generate(
        self,
        job_id: str,
        video_path: str,
        depth_path: str,
        displacement: float = 0.0125,
        inpaint: str = "propainter",
        work_height: int = 720,
        work_width: int = 1280,
        stereo_mode: str = "both",
        fps_rational: str | None = None,
        band: tuple[float, float] = (0.0, 1.0),
        frame_range: tuple[int, int] | None = None,
        batch_size: int | None = None,
        concat: bool = True,
        scene_params: list[dict] | None = None,
    ) -> dict:
        """Produce a full-width SBS video. Paths are inside the cache
        volume / bucket mount. Returns the cache path of the SBS file.

        Written in ~SEGMENT_FRAMES checkpoints (aligned to ProPainter
        batch boundaries, so segmentation never changes results); on a
        preemption retry, finished segments are skipped. The final
        concat is frame-count-verified so audio can never drift.

        ``scene_params`` (adaptive per-shot depth script, optional):
        list of {"first", "last", "displacement", "placement"} dicts
        from FrameDepthWorker.profile_scenes. When given, each frame's
        splatting displacement + placement come from its shot (looked
        up by absolute frame index); shots carrying a "keyframes" list
        (dynamic shots) ramp linearly between keyframes — see
        _scene_param_lookup. Masks and inpainting are unchanged. When
        None, behavior is byte-identical to before: the
        ``displacement`` argument and the default placement apply to
        every frame.
        """
        from app.common.ffmpeg_utils import concat_segments, count_frames

        if inpaint not in ("propainter", "none"):
            raise ValueError(f"unknown inpaint mode: {inpaint!r}")
        if stereo_mode not in ("both", "left", "right"):
            raise ValueError(f"unknown stereo_mode: {stereo_mode!r}")

        safe_reload(cache_volume)
        src = Path(video_path)
        depth_src = Path(depth_path)
        for p in (src, depth_src):
            if not p.exists():
                raise FileNotFoundError(p)

        out = job_cache_dir(job_id) / f"sbs_{inpaint}.mp4"
        seg_dir = Path(f"{out}.segments")
        seg_dir.mkdir(parents=True, exist_ok=True)

        decoder = VideoDecoder(str(src), device="cpu", num_ffmpeg_threads=0)
        depth_decoder = VideoDecoder(str(depth_src), device="cpu", num_ffmpeg_threads=0)
        meta = decoder.metadata
        fps = fps_rational or float(meta.average_fps)
        height, width = meta.height, meta.width
        num_frames = min(meta.num_frames, depth_decoder.metadata.num_frames)
        if meta.num_frames != depth_decoder.metadata.num_frames:
            raise RuntimeError(
                f"frame count mismatch: source {meta.num_frames} vs depth "
                f"{depth_decoder.metadata.num_frames} — upstream stage dropped frames"
            )

        to_work = v2.Resize(
            (work_height, work_width),
            interpolation=v2.InterpolationMode.NEAREST_EXACT,
            antialias=True,
        )
        to_source = v2.Resize(
            (height, width), interpolation=v2.InterpolationMode.BICUBIC, antialias=True
        )

        if batch_size is None:
            batch_size = _pick_batch_size(num_frames)
        seg_len = batch_size * max(1, round(SEGMENT_FRAMES / batch_size))
        range_start, range_end = frame_range or (0, num_frames)
        logger.info(
            f"🎬 SBS pass: {num_frames} frames @ {width}x{height}, "
            f"batch={batch_size}, segment={seg_len}, inpaint={inpaint}"
        )

        with jobs.stage_timer(
            job_id,
            f"video_stereo[{inpaint}]",
            gpu=torch.cuda.get_device_name(0).replace("NVIDIA ", ""),
            frames=num_frames,
            width=width,
            height=height,
        ):
            from app.common.debug import job_logger

            jlog = job_logger(job_id)
            params_at = None
            if scene_params:
                params_at = _scene_param_lookup(scene_params, displacement, DEFAULT_PLACEMENT)
                jlog.info(f"🎛  adaptive per-shot params active: {len(scene_params)} shot(s)")
            pass_start = time.perf_counter()
            segments: list[Path] = []

            with torch.no_grad():
                for s in range(range_start, range_end, seg_len):
                    e = min(s + seg_len, range_end)
                    seg = seg_dir / f"sbs_{s:08d}_{e:08d}.mp4"
                    segments.append(seg)
                    if seg.exists() and count_frames(seg) == e - s:
                        jlog.info(f"⏭  segment [{s}, {e}) already done, skipping")
                        continue

                    writer = self._segment_writer(seg, width, height, fps)
                    try:
                        for i in range(s, e, batch_size):
                            j = min(i + batch_size, e)
                            frames = decoder[i:j].cuda()  # (T, 3, H, W) uint8
                            depths = depth_decoder[i:j].cuda()  # (T, C, h, w) uint8
                            if depths.shape[1] > 1:
                                depths = depths[:, :1]
                            depths = to_source(depths)

                            if inpaint == "none":
                                self._write_raw_warp(
                                    writer, frames, depths, displacement, stereo_mode,
                                    frame_start=i, params_at=params_at,
                                )
                            else:
                                self._write_inpainted(
                                    writer, frames, depths, displacement,
                                    to_work, to_source, stereo_mode,
                                    frame_start=i, params_at=params_at,
                                )

                            del frames, depths
                            torch.cuda.empty_cache()
                            elapsed = time.perf_counter() - pass_start
                            jlog.info(
                                f"🎬 stereo[{inpaint}] {j}/{num_frames} frames "
                                f"({j / num_frames:.0%}, {j / elapsed:.1f} fps)"
                            )
                            if frame_range is not None:
                                jobs.report_progress(
                                    job_id, f"video_stereo[{inpaint}]",
                                    j - range_start, num_frames,
                                    band=tuple(band), chunk=range_start,
                                )
                            else:
                                jobs.report_progress(
                                    job_id, f"video_stereo[{inpaint}]", j, num_frames,
                                    rate_per_s=j / max(elapsed, 1e-6), band=tuple(band),
                                )
                    finally:
                        writer.stdin.close()
                        writer.wait()
                    cache_volume.commit()  # checkpoint the finished segment

            if not concat:
                cache_volume.commit()
                del decoder, depth_decoder
                return {
                    "segments": [str(p) for p in segments],
                    "num_frames": range_end - range_start,
                    "fps": float(meta.average_fps),
                    "width": width * 2,
                    "height": height,
                    "inpaint": inpaint,
                }
            concat_segments(segments, out)
            written = count_frames(out)
            if written != num_frames:
                raise RuntimeError(
                    f"SBS frame count mismatch: wrote {written}, expected {num_frames} "
                    "— refusing to continue (audio would drift out of sync)"
                )

        cache_volume.commit()
        del decoder, depth_decoder  # drop file handles before the next input
        return {
            "sbs_path": str(out),
            "num_frames": num_frames,
            "fps": float(meta.average_fps),
            "width": width * 2,
            "height": height,
            "inpaint": inpaint,
        }

    @staticmethod
    def _segment_writer(path: Path, width: int, height: int, fps):
        return (
            ffmpeg.input(
                "pipe:", format="rawvideo", pix_fmt="rgb24", s=f"{width * 2}x{height}", r=fps
            )
            .output(
                str(path),
                pix_fmt="yuv420p",
                vcodec="libx264",
                preset="slow",
                vsync="cfr",
                r=fps,
                crf=16,
            )
            .global_args("-loglevel", "error")
            .overwrite_output()
            .run_async(pipe_stdin=True)
        )

    # ------------------------------------------------------------ modes

    def _write_raw_warp(
        self, writer, frames, depths, displacement, stereo_mode,
        frame_start: int = 0, params_at=None,
    ) -> None:
        """Forward warp only — no masks, no inpainting. In "left"/"right"
        mode the other eye is the untouched original frame and the
        generated eye gets the FULL displacement (matching the still
        image pipeline's convention).

        ``frame_start`` is the batch's absolute start index, so
        ``params_at`` (adaptive per-shot lookup) can resolve each
        frame's shot even when a batch straddles a scene cut."""
        for k in range(frames.shape[0]):
            disp_k, placement_k = (
                params_at(frame_start + k) if params_at is not None
                else (displacement, DEFAULT_PLACEMENT)
            )
            frame = frames[k].unsqueeze(0)
            depth = depths[k].unsqueeze(0).float() / 255.0
            left, right, _, _ = self.splatter(
                image=frame, depthmap=depth, disp=disp_k,
                stereo_mode=stereo_mode, placement=placement_k,
            )
            left_u8 = frame if left is None else (left * 255).clamp(0, 255).to(torch.uint8)
            right_u8 = frame if right is None else (right * 255).clamp(0, 255).to(torch.uint8)
            sbs = torch.cat([left_u8, right_u8], dim=3)
            writer.stdin.write(sbs.squeeze(0).permute(1, 2, 0).cpu().numpy().tobytes())

    def _write_inpainted(
        self, writer, frames, depths, displacement, to_work, to_source, stereo_mode,
        frame_start: int = 0, params_at=None,
    ) -> None:
        """Splat at source resolution, inpaint occlusions with
        ProPainter at working resolution, then composite the upscaled
        fill back into the full-resolution warp (only the holes receive
        upscaled pixels — the rest keeps source detail).

        stereo_mode "left"/"right": only that eye is synthesized (full
        displacement) and inpainted — the other eye is the original
        frame, halving the ProPainter cost vs "both".

        ``frame_start`` + ``params_at``: adaptive per-shot lookup, see
        _write_raw_warp — only the splatting parameters vary per frame;
        the mask/ProPainter flow is untouched.
        """
        gen_left = stereo_mode in (BOTH, LEFT)
        gen_right = stereo_mode in (BOTH, RIGHT)
        sides = {}  # name -> (work_frames, masks, dilated, hires list)
        originals = []

        for k in range(frames.shape[0]):
            disp_k, placement_k = (
                params_at(frame_start + k) if params_at is not None
                else (displacement, DEFAULT_PLACEMENT)
            )
            frame = frames[k].unsqueeze(0)
            originals.append(frame.cpu())
            depth = depths[k].unsqueeze(0).float() / 255.0
            left, right, left_occ, right_occ = self.splatter(
                image=frame, depthmap=depth, disp=disp_k,
                stereo_mode=stereo_mode, placement=placement_k,
            )
            for name, img, occ in (("L", left, left_occ), ("R", right, right_occ)):
                if img is None:
                    continue
                u8 = (img * 255).clamp(0, 255).to(torch.uint8)
                mask_hi = propainter_runner.dilate_mask(occ > 0.5, kernel_size=3, iterations=2)
                mask_wk = to_work(occ) > 0.5
                side = sides.setdefault(name, ([], [], [], []))
                side[0].append(to_work(u8))
                side[1].append(mask_wk)
                side[2].append(propainter_runner.dilate_mask(mask_wk, kernel_size=3, iterations=2))
                side[3].append((u8.cpu(), mask_hi.cpu()))

        done = {}
        for name, (work, masks, dilated, hires) in sides.items():
            filled = propainter_runner.inpaint_window(
                self.propainter,
                torch.cat(work, dim=0),
                torch.cat(masks, dim=0),
                torch.cat(dilated, dim=0),
            )
            torch.cuda.empty_cache()
            done[name] = (filled, hires)

        for k in range(frames.shape[0]):
            if gen_left:
                filled, hires = done["L"]
                left = self._composite(filled[k], *hires[k], to_source)
            else:
                left = originals[k].cuda()
            if gen_right:
                filled, hires = done["R"]
                right = self._composite(filled[k], *hires[k], to_source)
            else:
                right = originals[k].cuda()
            sbs = torch.cat([left, right], dim=3)
            writer.stdin.write(
                sbs.squeeze(0).permute(1, 2, 0).to(torch.uint8).cpu().numpy().tobytes()
            )

    @staticmethod
    def _composite(inpainted_np, warp_hires: "torch.Tensor", mask_hires: "torch.Tensor", to_source):
        """Paste upscaled inpainted pixels into the dilated occlusion
        holes of the full-resolution warp."""
        filled = torch.from_numpy(inpainted_np).permute(2, 0, 1).unsqueeze(0).cuda()
        filled = to_source(filled)
        warp = warp_hires.cuda()
        mask = mask_hires.cuda()
        return torch.where(mask, filled, warp)
