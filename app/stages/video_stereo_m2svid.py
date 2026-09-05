"""Video stereo worker (GPU): forward-warp splatting + M2SVid inpainting.

Same role and output contract as ``VideoStereoWorker`` (a full-width
SBS video on the cache volume) with M2SVid — Google's one-step
SVD-based right-view inpainting model (3DV 2026) — filling the
disocclusions instead of ProPainter.

Geometry — this mode is always LEFT-EYE-FIXED:
- ``propainter``/``none`` default (``stereo_mode="both"``): BOTH eyes
  are forward-warped away from the source by half the displacement
  each.
- ``m2svid``: the left eye is the ORIGINAL frame and the right eye is
  forward-warped at the FULL displacement, then inpainted+refined by
  M2SVid — i.e. the same geometry as ``stereo_mode="right"`` in the
  ProPainter worker. This matches how the model was trained (left view
  + warped right view as conditioning) and keeps one eye perfectly
  sharp; the total inter-ocular disparity equals the other modes.

Resolution strategy: M2SVid was trained at 512x512 (dims must be
divisible by 64) with a hard 25-frame window. Frames are splatted at
SOURCE resolution, the warp + masks are downscaled to a ~512-tall
working resolution for the model, and — exactly like the ProPainter
path — only the occlusion holes receive upscaled inpainted pixels; the
rest of the right view keeps full-resolution warp detail. (The
alternative, StereoCrafter-style spatial tiling at native res, is what
upstream recommends for full-frame HD refinement but ships no code
for; revisit if hole quality at 512-tier proves limiting.)

GPU: A100-80GB by default. The 25-frame fp16 SVD-XT-class UNet runs
with cond/uncond batch doubling (50 effective frames) plus M2SVid's
unbounded full attention over all disoccluded tokens across the whole
window — memory scales with disparity, so the 48 GB L40S is too risky
at the default 512x896 working resolution; A100-80GB is also the
authors' dev platform. Route down via with_options once measured.
"""

import time
from pathlib import Path

import modal

from app.common import jobs
from app.common.errors import fail_fast
from app.common.debug import get_logger, track
from app.common.storage import GPU_VOLUMES, cache_volume, hf_secret, slack_secret, job_cache_dir, safe_reload
from app.env import SCALEDOWN_WINDOW
from app.images import m2svid_image
from app.modal_app import app

logger = get_logger(__name__)

M2SVID_STEREO_GPU = "A100-80GB"

with m2svid_image.imports():
    import ffmpeg
    import torch
    import torchvision.transforms.v2 as v2
    from torchcodec.decoders import VideoDecoder

    from app.stages import m2svid_runner
    from app.stages.splat import BOTH, DEFAULT_PLACEMENT, RIGHT, DepthSplatter
    from app.stages.video_stereo import _scene_param_lookup

# model window: fixed by the SVD temporal layers (see m2svid_runner)
M2SVID_CHUNK = 25

# target segment length in frames (10 model windows ≈ 10s @ 24fps);
# each segment is an independently written, resumable checkpoint
SEGMENT_FRAMES = 250


def _round64(x: float) -> int:
    """Nearest multiple of 64, at least 64 (model dim constraint)."""
    return max(64, int(round(x / 64)) * 64)


@app.cls(
    gpu=M2SVID_STEREO_GPU,
    image=m2svid_image,
    volumes=GPU_VOLUMES,
    secrets=[hf_secret, slack_secret],
    cpu=4,
    memory=(4 * 1024, 128 * 1024),
    # Per-WORKER timeout. M2SVid is fast (~6 fps → 1200f chunk ≈ 3 min)
    # but a non-fanned-out sequential run does the whole clip; 2h covers
    # the longest no-fan-out clip plus the diffusion model's cold load.
    timeout=2 * 3600,
    scaledown_window=SCALEDOWN_WINDOW,
    env={"PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True"},
    retries=modal.Retries(max_retries=2, initial_delay=10.0, backoff_coefficient=2.0),
)
class M2SVidStereoWorker:
    @modal.enter()
    def load(self) -> None:
        start = time.perf_counter()
        torch.backends.cudnn.benchmark = True
        self.splatter = DepthSplatter().eval()
        self.model = m2svid_runner.load_m2svid()
        logger.info(f"🚀 m2svid stereo worker ready in {time.perf_counter() - start:.1f}s")

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
        stereo_mode: str = "right",
        placement: tuple[float, float] | None = None,
        # MODEL CONSTRAINT, not a quality/VRAM tuning knob (unlike
        # ProPainter's work_height/work_width). M2SVid is a diffusion model
        # TRAINED at the ~512-tall tier; running far off it pushes the fill
        # out of its training distribution → WORSE fills, not just slower.
        # The pipeline deliberately does NOT plumb these from the request
        # (see app/pipelines/video.py m2svid_kwargs) so they stay pinned.
        # Override only for deliberate model-resolution experiments.
        work_height: int = 512,
        work_width: int | None = None,  # None → aspect-derived from source
        fps_rational: str | None = None,
        band: tuple[float, float] = (0.0, 1.0),
        frame_range: tuple[int, int] | None = None,
        batch_size: int | None = None,
        concat: bool = True,
        scene_params: list[dict] | None = None,
        splat_video_path: str | None = None,
    ) -> dict:
        """Produce a full-width SBS video (left = source, right =
        warped + M2SVid-filled). Paths are inside the cache volume /
        bucket mount. Returns the cache path of the SBS file.

        ``work_height``/``work_width`` are the M2SVid MODEL resolution —
        a fixed training constraint, NOT a tunable like ProPainter's
        equivalents. They snap to multiples of 64; ``work_width=None``
        derives the width from the source aspect ratio while pinning the
        height to the ~512 trained tier (e.g. 512x896 for 16:9). The
        pipeline keeps these at their defaults (it does not forward the
        request's work_height/work_width here, unlike the ProPainter path)
        because off-tier resolutions degrade the diffusion fill quality.
        Splatting is at SOURCE resolution; only the warp+masks handed to
        the model are at the work tier (full-res warp detail is preserved
        outside the inpainted region).

        Written in ~SEGMENT_FRAMES checkpoints aligned to the 25-frame
        model window (segmentation never changes results — windows are
        independent and deterministic); on a preemption retry, finished
        segments are skipped. The final concat is frame-count-verified
        so audio can never drift.

        ``scene_params`` (adaptive per-shot depth script, optional):
        same contract as VideoStereoWorker — per-frame displacement +
        placement looked up by absolute index; only the splatting
        varies, the M2SVid fill is unchanged. Caveat: a 25-frame model
        window straddling a cut mixes two disparity regimes in one
        fill (masked by the cut itself, same as ProPainter batches).
        """
        from app.common.ffmpeg_utils import concat_segments, count_frames

        safe_reload(cache_volume)
        # DUAL-RES (v7): when splat_video_path is given, splat the output-res
        # frames while the M2SVid fill stays at its 512 model tier (the model
        # resolution is independent of the splat resolution — the fill only
        # touches the disocclusion holes, upscaled back into the high-res
        # warp). Without it, src == the work video (byte-identical to before).
        src = Path(splat_video_path or video_path)
        depth_src = Path(depth_path)
        for p in (src, depth_src):
            if not p.exists():
                raise FileNotFoundError(p)

        out = job_cache_dir(job_id) / "sbs_m2svid.mp4"
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

        # model-tier resolution (see generate() docstring): height pinned
        # to the ~512 trained tier, width aspect-derived; both snapped to
        # the model's 64-multiple requirement. NOT a free tuning knob.
        wh = _round64(work_height)
        ww = _round64(work_width if work_width is not None else width * wh / height)
        # BICUBIC down/up (not the ProPainter path's nearest): the
        # diffusion model conditions on natural images and aliasing in
        # the warp shows up in the fill
        to_work = v2.Resize((wh, ww), interpolation=v2.InterpolationMode.BICUBIC, antialias=True)
        to_work_mask = v2.Resize((wh, ww), interpolation=v2.InterpolationMode.BILINEAR, antialias=True)
        to_source = v2.Resize(
            (height, width), interpolation=v2.InterpolationMode.BICUBIC, antialias=True
        )

        if batch_size is None:
            batch_size = M2SVID_CHUNK
        if not (0 < batch_size <= M2SVID_CHUNK):
            raise ValueError(f"batch_size must be in [1, {M2SVID_CHUNK}], got {batch_size}")
        seg_len = batch_size * max(1, round(SEGMENT_FRAMES / batch_size))
        range_start, range_end = frame_range or (0, num_frames)
        logger.info(
            f"🎬 SBS pass: {num_frames} frames @ {width}x{height}, "
            f"batch={batch_size}, segment={seg_len}, inpaint=m2svid, work={ww}x{wh}"
        )

        with jobs.stage_timer(
            job_id,
            "video_stereo[m2svid]",
            gpu=torch.cuda.get_device_name(0).replace("NVIDIA ", ""),
            frames=num_frames,
            width=width,
            height=height,
        ):
            from app.common.debug import job_logger

            jlog = job_logger(job_id)
            params_at = None
            pass_at = None
            base_placement = tuple(float(v) for v in placement) if placement else DEFAULT_PLACEMENT
            if scene_params:
                params_at = _scene_param_lookup(scene_params, displacement, base_placement)
                jlog.info(f"🎛  adaptive per-shot params active: {len(scene_params)} shot(s)")
                from app.stages.video_stereo import _passthrough_lookup

                pass_at = _passthrough_lookup(scene_params)
                if pass_at is not None:
                    n = sum(1 for sp in scene_params if sp.get("passthrough"))
                    jlog.info(f"⏩ passthrough shots: {n} (2D, no warp/inpaint)")
            elif placement:
                params_at = lambda _idx, _p=(displacement, base_placement): _p  # noqa: E731
                jlog.info(f"🎛  job-wide placement {base_placement}")
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

                            from app.stages.video_stereo import _split_passthrough_runs

                            runs = (
                                _split_passthrough_runs(i, j, pass_at)
                                if pass_at is not None
                                else [(i, j, False)]
                            )
                            for a, b, is_pass in runs:
                                sub_frames = frames[a - i : b - i]
                                if is_pass:
                                    # 2D passthrough: both eyes = source frame
                                    for k in range(sub_frames.shape[0]):
                                        frame = sub_frames[k].unsqueeze(0)
                                        sbs = torch.cat([frame, frame], dim=3)
                                        writer.stdin.write(
                                            sbs.squeeze(0).permute(1, 2, 0).cpu().numpy().tobytes()
                                        )
                                    continue
                                self._write_inpainted(
                                    writer, stereo_mode, sub_frames, depths[a - i : b - i],
                                    displacement,
                                    to_work, to_work_mask, to_source, float(meta.average_fps),
                                    frame_start=a, params_at=params_at,
                                )

                            del frames, depths
                            torch.cuda.empty_cache()
                            elapsed = time.perf_counter() - pass_start
                            jlog.info(
                                f"🎬 stereo[m2svid] {j}/{num_frames} frames "
                                f"({j / num_frames:.0%}, {j / elapsed:.1f} fps)"
                            )
                            if frame_range is not None:
                                jobs.report_progress(
                                    job_id, "video_stereo[m2svid]",
                                    j - range_start, num_frames,
                                    band=tuple(band), chunk=range_start,
                                )
                            else:
                                jobs.report_progress(
                                    job_id, "video_stereo[m2svid]", j, num_frames,
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
                    "inpaint": "m2svid",
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
            "inpaint": "m2svid",
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

    # ------------------------------------------------------------ mode

    def _fill_eye(self, frames, warp, occ, to_work, to_work_mask, to_source, fps, mirror: bool):
        """Run M2SVid on one eye. mirror=True flips inputs/outputs
        horizontally (left-eye warps are out-of-distribution otherwise)."""
        if mirror:
            frames, warp, occ = frames.flip(-1), warp.flip(-1), occ.flip(-1)
        warp_u8 = (warp * 255).clamp(0, 255).to(torch.uint8)
        track("m2svid_warp", warp_u8, logger)
        filled_work = m2svid_runner.inpaint_chunk(
            self.model, to_work(frames), to_work(warp_u8).float() / 255.0,
            to_work_mask(occ), fps,
        )
        torch.cuda.empty_cache()
        fill = to_source(filled_work)
        hole = m2svid_runner.hole_mask(occ)
        eye = torch.where(hole.expand(-1, 3, -1, -1), fill, warp_u8)
        return eye.flip(-1) if mirror else eye

    def _write_inpainted(
        self, writer, stereo_mode, frames, depths, displacement, to_work, to_work_mask, to_source, fps,
        frame_start: int = 0, params_at=None,
    ) -> None:
        """Splat the right eye at source resolution and FULL
        displacement, run M2SVid at working resolution, then composite
        the upscaled fill back into the occlusion holes of the
        full-resolution warp. The left eye is the untouched source
        frame, so only the right eye trades hole pixels for upscaled
        ones — everything else keeps source detail.

        ``frame_start`` + ``params_at``: adaptive per-shot lookup (see
        VideoStereoWorker._write_raw_warp) — only the splat parameters
        vary per frame; the fill is untouched.
        """
        mode = BOTH if stereo_mode == "both" else RIGHT
        l_warps, l_occs, r_warps, r_occs = [], [], [], []
        for k in range(frames.shape[0]):
            disp_k, placement_k = (
                params_at(frame_start + k) if params_at is not None
                else (displacement, DEFAULT_PLACEMENT)
            )
            frame = frames[k].unsqueeze(0)
            depth = depths[k].unsqueeze(0).float() / 255.0
            # RIGHT mode warps by the full displacement; BOTH splits it
            # half per eye (DepthSplatter handles the 0.5x internally)
            left, right, left_occ, right_occ = self.splatter(
                image=frame, depthmap=depth, disp=disp_k,
                stereo_mode=mode, placement=placement_k,
            )
            r_warps.append(right)
            r_occs.append(right_occ)
            if left is not None:
                l_warps.append(left)
                l_occs.append(left_occ)

        right = self._fill_eye(frames, torch.cat(r_warps), torch.cat(r_occs),
                               to_work, to_work_mask, to_source, fps, mirror=False)
        if l_warps:
            # M2SVid is trained left-reference/right-target: mirror the
            # left-eye problem horizontally so its warp direction matches
            # the training distribution, fill, then mirror back.
            left = self._fill_eye(frames, torch.cat(l_warps), torch.cat(l_occs),
                                  to_work, to_work_mask, to_source, fps, mirror=True)
        else:
            left = frames  # right-only mode: left eye = source

        sbs = torch.cat([left, right], dim=3)
        for k in range(sbs.shape[0]):
            writer.stdin.write(sbs[k].permute(1, 2, 0).cpu().numpy().tobytes())
