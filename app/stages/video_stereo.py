"""Video stereo worker (GPU): forward-warp splatting + inpainting.

Consumes the source video plus the depth video produced by
VideoDepthWorker and writes a full-width side-by-side (SBS) stereo
video to the cache volume.

Inpainting modes:
- "propainter" — flow-guided video inpainting (best quality, slower).
  Runs at a bounded working resolution then upsamples the filled
  regions back to source resolution.
- "none" — raw warp only (no masks, no blurs). Empirically a strong
  baseline and the fastest path.

Warp methods (``warp``, orthogonal to ``inpaint``):
- "forward" — DepthSplatter scatter (default). The only method that
  yields occlusion masks, so the only one ``inpaint="propainter"``
  can follow.
- "backward" — BackwardWarpStereo gather (app-parity kernel, see
  gather.py). No holes → requires ``inpaint="none"``; the pairing with
  "propainter" is rejected up front rather than silently ignored.
"""

import time
from pathlib import Path

import modal

from app.common import jobs
from app.common.errors import fail_fast
from app.common.debug import get_logger, track
from app.common.storage import GPU_VOLUMES, cache_volume, hf_secret, slack_secret, job_cache_dir, safe_reload
from app.env import SCALEDOWN_WINDOW
from app.images import stereo_image, stereo_lite_image
from app.modal_app import app

logger = get_logger(__name__)

VIDEO_STEREO_GPU = "L40S"
# Backward-warp ("Stretched edges") tier. The gather warp is one grid_sample
# per frame — the stage is bound by SBS encoding, not by the GPU — so it runs
# on the cheapest NVENC-capable card: no ProPainter (never used, 3 networks
# of cold start), no Forward_Warp, HEVC NVENC segment encoding instead of
# libx264 slow on 4 cores (the 4 fps that idled an H200 at $3.95/h, job
# 73e91a7e50f5 2026-08-31). L4 ($0.80/h): NVENC verified in this repo for
# MV-HEVC; HEVC NVENC takes up to 8192 px wide (H.264 NVENC caps at 4096,
# below a 3k/4k SBS frame). H100/H200 have NO NVENC.
BACKWARD_WARP_GPU = "L4"

with stereo_image.imports():
    import ffmpeg
    import torch
    import torchvision.transforms.v2 as v2
    from torchcodec.decoders import VideoDecoder

    from app.stages import propainter_runner
    from app.stages.gather import BackwardWarpStereo
    from app.stages.splat import BOTH, DEFAULT_PLACEMENT, LEFT, RIGHT, DepthSplatter

# torch-free (coordinator + tests import this module without a GPU stack)
from app.stages.warp_modes import WARP_BACKWARD, WARP_FORWARD, validate_warp


# ProPainter's VRAM working set scales with WINDOW FRAMES × INPAINT-RES
# PIXELS, but the safe budget is PER GPU TIER, not per GB — the L40S
# proven point (30 frames × 1.24 MP on 48 GB) and the H200 measurements
# below imply different GB-per-MP·frame slopes, so don't unify them.
#   L40S: 30 frames at ~1.24 MP (the @720-tier benchmarks) is the proven
#     ceiling on 48 GB — unchanged.
#   H200: 30 frames at 2.79 MP OOMed at ~120 GB resident (job
#     c51480d2c0aa, 2026-07-03); the shrunken 13-frame windows (37
#     MP·frames) peaked only 50–62 GB across 5 containers AND ~doubled
#     the propainter GPU-seconds — $25.5 billed vs the ~$12 projected at
#     30 frames (job 8aadc9e33449, 2026-07-03) — per-window flow/reference
#     overhead dominates. ~1.7 GB per MP·frame measured ⇒ 65 MP·frames
#     targets ~110 GB peak: most of the window (and its temporal context)
#     back, with ~30 GB headroom for spikes.
# Smaller windows trade temporal fill context AND real money for memory —
# shrink only as far as the tier requires.
_PROPAINTER_MP_FRAMES_BUDGET = 30 * 1.24  # ≈37 MP·frames — L40S (48 GB)
_PROPAINTER_MP_FRAMES_BUDGET_H200 = 65.0  # 140 GB tier


def _pick_batch_size(
    num_frames: int, work_mp: float = 0.9, vram_gb: float | None = None
) -> int:
    """Largest ProPainter window n in [8, 30] whose working set fits the
    GPU tier's budget (n × work_mp ≤ budget, see above), such that the
    final batch is not a single frame (a 1-frame ProPainter window has no
    flow to work with). ``work_mp``: inpaint working resolution in
    megapixels. ``vram_gb``: the worker detects its own card; callers off
    the GPU (the fan-out coordinator) must pass the tier they routed to —
    unknown/no-CUDA falls back to the small tier."""
    if vram_gb is None:
        try:
            vram_gb = torch.cuda.get_device_properties(0).total_memory / 2**30
        except Exception:  # coordinator/tests: no CUDA visible
            vram_gb = 45.0
    budget = (
        _PROPAINTER_MP_FRAMES_BUDGET_H200
        if vram_gb >= 100
        else _PROPAINTER_MP_FRAMES_BUDGET
    )
    cap = max(8, min(30, int(budget / max(work_mp, 0.1))))
    for n in range(cap, 7, -1):
        if num_frames % n != 1:
            return n
    return 8


# target segment length in frames (~10s @ 24fps); each segment is an
# independently written, resumable checkpoint
SEGMENT_FRAMES = 240


def _validate_modes(inpaint: str, stereo_mode: str, warp: str) -> None:
    """Pure argument check for ``generate`` (kept out of the Modal method
    so it is unit-testable without a GPU). Rejects unknown values and
    the contradictory backward-warp + inpainting pairing."""
    if inpaint not in ("propainter", "none"):
        raise ValueError(f"unknown inpaint mode: {inpaint!r}")
    if stereo_mode not in ("both", "left", "right"):
        raise ValueError(f"unknown stereo_mode: {stereo_mode!r}")
    validate_warp(warp, inpaint)


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


def _passthrough_lookup(scene_params: list[dict]):
    """``index -> bool`` predicate over shots flagged ``passthrough: true``
    (ship as 2D: both eyes = untouched source — credits, logos, etc.).
    Returns None when no shot is flagged so the hot loop skips the split
    entirely."""
    spans = [
        (int(sp["first"]), int(sp["last"]))
        for sp in scene_params
        if sp.get("passthrough")
    ]
    if not spans:
        return None

    def at(index: int) -> bool:
        return any(first <= index < last for first, last in spans)

    return at


def _split_passthrough_runs(start: int, end: int, pass_at) -> list[tuple[int, int, bool]]:
    """Split [start, end) into maximal runs of constant passthrough-ness so
    a batch straddling a passthrough boundary dispatches each side to the
    right writer. Pure function."""
    runs: list[tuple[int, int, bool]] = []
    a = start
    cur = pass_at(start)
    for idx in range(start + 1, end):
        v = pass_at(idx)
        if v != cur:
            runs.append((a, idx, cur))
            a, cur = idx, v
    runs.append((a, end, cur))
    return runs


class _StereoWorkerBase:
    """Shared implementation of both stereo workers (Modal collects the
    @modal.enter/@modal.method partials through the MRO). ``LITE`` selects
    the backward-warp tier: no inpaint/splat models, NVENC segments."""

    LITE = False

    @modal.enter()
    def load(self) -> None:
        start = time.perf_counter()
        torch.backends.cudnn.benchmark = True
        self.gatherer = BackwardWarpStereo().eval()
        if self.LITE:
            # backward-warp tier: nothing else to load. ProPainter alone is
            # ~30-60 s of GPU cold start per worker that this mode never uses.
            self.splatter = None
            self.propainter = None
            self.segment_codec = "hevc_nvenc" if _nvenc_available() else "libx264"
            if self.segment_codec != "hevc_nvenc":
                logger.warning("⚠️  hevc_nvenc unavailable on this worker — falling back to libx264 veryfast")
        else:
            self.splatter = DepthSplatter().eval()
            self.propainter = propainter_runner.ProPainterModels()
            self.segment_codec = "libx264"
        logger.info(
            f"🚀 stereo worker ready in {time.perf_counter() - start:.1f}s "
            f"(tier={'lite' if self.LITE else 'full'}, segments={self.segment_codec})"
        )

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
        splat_video_path: str | None = None,
        warp: str = WARP_FORWARD,
    ) -> dict:
        """Produce a full-width SBS video. Paths are inside the cache
        volume / bucket mount. Returns the cache path of the SBS file.

        ``warp``: "forward" (splat; default) or "backward" (gather, see
        gather.py). "backward" only combines with ``inpaint="none"`` —
        it produces no occlusion masks, so there is nothing for
        ProPainter to fill and the pairing raises ValueError.

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

        _validate_modes(inpaint, stereo_mode, warp)
        if self.LITE and (warp != WARP_BACKWARD or inpaint != "none"):
            raise ValueError(
                f"the lite stereo tier only runs warp='backward' + inpaint='none' "
                f"(got warp={warp!r}, inpaint={inpaint!r}) — route this job to VideoStereoWorker"
            )
        # the raw-warp writer takes whichever warper the job asked for;
        # the inpainted path is forward-only (enforced above)
        raw_warper = self.gatherer if warp == WARP_BACKWARD else self.splatter

        safe_reload(cache_volume)
        # DUAL-RES (v7): when splat_video_path is given, the SPLAT + composite
        # run on those output-res frames while ProPainter still fills at
        # (work_height, work_width). The forward-warp is a geometric pixel
        # shift, so warping the high-res frames preserves output-res detail
        # everywhere except the disocclusion holes (filled at inpaint res,
        # upscaled into the high-res warp by _composite). Depth (depth-res)
        # upscales to the SPLAT dims via to_source. Without it, src == the
        # work video and behavior is byte-identical to before.
        src = Path(splat_video_path or video_path)
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
        # height/width = the SPLAT (output) resolution — the warp, composite,
        # and SBS output all happen here; ProPainter sees to_work below.
        height, width = meta.height, meta.width
        num_frames = min(meta.num_frames, depth_decoder.metadata.num_frames)
        if meta.num_frames != depth_decoder.metadata.num_frames:
            raise RuntimeError(
                f"frame count mismatch: splat/source {meta.num_frames} vs depth "
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
            batch_size = _pick_batch_size(
                num_frames, work_height * work_width / 1e6
            )
        seg_len = batch_size * max(1, round(SEGMENT_FRAMES / batch_size))
        range_start, range_end = frame_range or (0, num_frames)
        logger.info(
            f"🎬 SBS pass: {num_frames} frames @ {width}x{height}, "
            f"batch={batch_size}, segment={seg_len}, inpaint={inpaint}, warp={warp}"
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
            pass_at = None
            if scene_params:
                params_at = _scene_param_lookup(scene_params, displacement, DEFAULT_PLACEMENT)
                jlog.info(f"🎛  adaptive per-shot params active: {len(scene_params)} shot(s)")
                pass_at = _passthrough_lookup(scene_params)
                if pass_at is not None:
                    n = sum(1 for sp in scene_params if sp.get("passthrough"))
                    jlog.info(f"⏩ passthrough shots: {n} (2D, no warp/inpaint)")
            pass_start = time.perf_counter()
            segments: list[Path] = []
            # per-phase wall accumulators (decode+depth-upscale / warp / pipe
            # write incl. the encoder back-pressure) — the raw-warp stage is
            # NOT GPU-bound, so this line is what tells the tiers apart
            phase = {"decode": 0.0, "warp": 0.0, "write": 0.0}

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
                            t_dec = time.perf_counter()
                            frames = decoder[i:j].cuda()  # (T, 3, H, W) uint8
                            depths = depth_decoder[i:j].cuda()  # (T, C, h, w) uint8
                            if depths.shape[1] > 1:
                                depths = depths[:, :1]
                            depths = to_source(depths)
                            torch.cuda.synchronize()
                            phase["decode"] += time.perf_counter() - t_dec

                            runs = (
                                _split_passthrough_runs(i, j, pass_at)
                                if pass_at is not None
                                else [(i, j, False)]
                            )
                            for a, b, is_pass in runs:
                                sub_frames = frames[a - i : b - i]
                                if is_pass:
                                    self._write_passthrough(writer, sub_frames)
                                    continue
                                sub_depths = depths[a - i : b - i]
                                if inpaint == "none":
                                    self._write_raw_warp(
                                        writer, sub_frames, sub_depths, displacement, stereo_mode,
                                        frame_start=a, params_at=params_at, warper=raw_warper,
                                        phase=phase,
                                    )
                                else:
                                    self._write_inpainted(
                                        writer, sub_frames, sub_depths, displacement,
                                        to_work, to_source, stereo_mode,
                                        frame_start=a, params_at=params_at,
                                    )

                            del frames, depths
                            torch.cuda.empty_cache()
                            elapsed = time.perf_counter() - pass_start
                            jlog.info(
                                f"🎬 stereo[{inpaint}] {j}/{num_frames} frames "
                                f"({j / num_frames:.0%}, {j / elapsed:.1f} fps) "
                                f"⏱ decode {phase['decode']:.1f}s warp {phase['warp']:.1f}s "
                                f"write {phase['write']:.1f}s"
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
                    "warp": warp,
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
            "warp": warp,
        }

    def _segment_writer(self, path: Path, width: int, height: int, fps):
        """SBS segment encoder. Full tier: libx264 slow crf 16 (unchanged).
        Lite tier: HEVC NVENC (p5/hq, cq 19 — visually lossless for an
        intermediate that every deliverable re-encodes from; concat is a
        stream copy so all segments of a job share the codec). The lite
        image runs ffmpeg 8 (static build), so it uses the non-deprecated
        ``fps_mode``; the full image keeps its ``vsync``."""
        src = ffmpeg.input(
            "pipe:", format="rawvideo", pix_fmt="rgb24", s=f"{width * 2}x{height}", r=fps
        )
        codec = getattr(self, "segment_codec", "libx264")
        if codec == "hevc_nvenc":
            out = src.output(
                str(path), pix_fmt="yuv420p", vcodec="hevc_nvenc", preset="p5", tune="hq",
                rc="vbr", cq=19, fps_mode="cfr", r=fps, **{"b:v": 0},
            )
        elif self.LITE:  # nvenc fallback: keep the tier cheap on CPU too
            out = src.output(
                str(path), pix_fmt="yuv420p", vcodec="libx264", preset="veryfast",
                fps_mode="cfr", r=fps, crf=16,
            )
        else:
            out = src.output(
                str(path), pix_fmt="yuv420p", vcodec="libx264", preset="slow",
                vsync="cfr", r=fps, crf=16,
            )
        return out.global_args("-loglevel", "error").overwrite_output().run_async(pipe_stdin=True)

    # ------------------------------------------------------------ modes

    @staticmethod
    def _write_passthrough(writer, frames) -> None:
        """Passthrough shots ship as 2D: both eyes are the untouched source
        frame — no depth read, no warp, no inpainting. Byte layout matches
        the other writers (rgb24, width×2)."""
        for k in range(frames.shape[0]):
            frame = frames[k].unsqueeze(0)
            sbs = torch.cat([frame, frame], dim=3)
            writer.stdin.write(sbs.squeeze(0).permute(1, 2, 0).cpu().numpy().tobytes())

    def _write_raw_warp(
        self, writer, frames, depths, displacement, stereo_mode,
        frame_start: int = 0, params_at=None, warper=None, phase=None,
    ) -> None:
        """Raw warp only — no masks, no inpainting. In "left"/"right"
        mode the other eye is the untouched original frame and the
        generated eye gets the FULL displacement (matching the still
        image pipeline's convention).

        ``warper``: the splatter (forward, default) or the gatherer
        (backward) — both share the DepthSplatter call signature and
        this writer ignores the mask slots either way.

        ``frame_start`` is the batch's absolute start index, so
        ``params_at`` (adaptive per-shot lookup) can resolve each
        frame's shot even when a batch straddles a scene cut."""
        warper = self.splatter if warper is None else warper
        for k in range(frames.shape[0]):
            t_frame = time.perf_counter()
            disp_k, placement_k = (
                params_at(frame_start + k) if params_at is not None
                else (displacement, DEFAULT_PLACEMENT)
            )
            frame = frames[k].unsqueeze(0)
            depth = depths[k].unsqueeze(0).float() / 255.0
            left, right, _, _ = warper(
                image=frame, depthmap=depth, disp=disp_k,
                stereo_mode=stereo_mode, placement=placement_k,
            )
            left_u8 = frame if left is None else (left * 255).clamp(0, 255).to(torch.uint8)
            right_u8 = frame if right is None else (right * 255).clamp(0, 255).to(torch.uint8)
            sbs = torch.cat([left_u8, right_u8], dim=3)
            # .contiguous() before the host copy — see _write_inpainted
            packed = sbs.squeeze(0).permute(1, 2, 0).contiguous().cpu().numpy().tobytes()
            if phase is not None:
                t_now = time.perf_counter()
                phase["warp"] += t_now - t_frame
                t_frame = t_now
            writer.stdin.write(packed)
            if phase is not None:
                phase["write"] += time.perf_counter() - t_frame

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
                # .contiguous() BEFORE the host copy: numpy's tobytes() on a
                # strided view is an element-wise CPU copy (~150 ms/frame at 3k —
                # it was the whole stereo stage's bottleneck, measured 2026-08-31)
                sbs.squeeze(0).permute(1, 2, 0).to(torch.uint8).contiguous().cpu().numpy().tobytes()
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


def _nvenc_available() -> bool:
    """True when this container's ffmpeg can drive HEVC NVENC (encoder
    compiled in AND a usable NVENC session on this GPU)."""
    import subprocess
    try:
        probe = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=256x256:r=24",
             "-frames:v", "2", "-c:v", "hevc_nvenc", "-f", "null", "-"],
            capture_output=True, text=True, timeout=60,
        )
        return probe.returncode == 0
    except Exception:  # missing binary, timeout — treat as unavailable
        return False


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
class VideoStereoWorker(_StereoWorkerBase):
    """Full tier (L40S/H200): forward warp + ProPainter, and the historical
    behavior for every mode — including backward warp when a caller
    bypasses the routing."""


@app.cls(
    gpu=BACKWARD_WARP_GPU,
    image=stereo_lite_image,
    volumes=GPU_VOLUMES,
    secrets=[hf_secret, slack_secret],
    cpu=4,
    memory=(4 * 1024, 32 * 1024),
    # a lite chunk is encode-bound at >100 fps; 1h is generous
    timeout=3600,
    scaledown_window=SCALEDOWN_WINDOW,
    env={"PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"},
    retries=modal.Retries(max_retries=2, initial_delay=10.0, backoff_coefficient=2.0),
)
class VideoStereoLiteWorker(_StereoWorkerBase):
    """Backward-warp tier (see BACKWARD_WARP_GPU). Accepts ONLY
    warp='backward' + inpaint='none'."""

    LITE = True
