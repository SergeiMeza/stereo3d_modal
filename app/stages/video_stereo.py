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
from app.common.debug import get_logger, track
from app.common.storage import GPU_VOLUMES, cache_volume, hf_secret, job_cache_dir
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
    from app.stages.splat import BOTH, DepthSplatter


def _pick_batch_size(num_frames: int) -> int:
    """Largest n in [20, 30] such that the final batch is not a single
    frame (a 1-frame ProPainter window has no flow to work with)."""
    for n in range(30, 19, -1):
        if num_frames % n != 1:
            return n
    return 20


@app.cls(
    gpu=VIDEO_STEREO_GPU,
    image=stereo_image,
    volumes=GPU_VOLUMES,
    secrets=[hf_secret],
    cpu=4,
    memory=(4 * 1024, 128 * 1024),
    timeout=3600,
    scaledown_window=120,
)
class VideoStereoWorker:
    @modal.enter()
    def load(self) -> None:
        start = time.perf_counter()
        torch.backends.cudnn.benchmark = True
        self.splatter = DepthSplatter().eval()
        self.propainter = propainter_runner.ProPainterModels()
        logger.info(f"🚀 stereo worker ready in {time.perf_counter() - start:.1f}s")

    @modal.method()
    def generate(
        self,
        job_id: str,
        video_path: str,
        depth_path: str,
        displacement: float = 0.0125,
        inpaint: str = "propainter",
        work_height: int = 720,
        work_width: int = 1280,
    ) -> dict:
        """Produce a full-width SBS video. Paths are inside the cache
        volume / bucket mount. Returns the cache path of the SBS file."""
        if inpaint not in ("propainter", "none"):
            raise ValueError(f"unknown inpaint mode: {inpaint!r}")

        cache_volume.reload()
        src = Path(video_path)
        depth_src = Path(depth_path)
        for p in (src, depth_src):
            if not p.exists():
                raise FileNotFoundError(p)

        out = job_cache_dir(job_id) / f"sbs_{inpaint}.mp4"

        decoder = VideoDecoder(str(src), device="cpu", num_ffmpeg_threads=0)
        depth_decoder = VideoDecoder(str(depth_src), device="cpu", num_ffmpeg_threads=0)
        meta = decoder.metadata
        fps = float(meta.average_fps)
        height, width = meta.height, meta.width
        num_frames = min(meta.num_frames, depth_decoder.metadata.num_frames)

        writer = (
            ffmpeg.input(
                "pipe:", format="rawvideo", pix_fmt="rgb24", s=f"{width * 2}x{height}", r=fps
            )
            .output(
                str(out),
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

        to_work = v2.Resize(
            (work_height, work_width),
            interpolation=v2.InterpolationMode.NEAREST_EXACT,
            antialias=True,
        )
        to_source = v2.Resize(
            (height, width), interpolation=v2.InterpolationMode.BICUBIC, antialias=True
        )

        batch_size = _pick_batch_size(num_frames)
        logger.info(
            f"🎬 SBS pass: {num_frames} frames @ {width}x{height}, "
            f"batch={batch_size}, inpaint={inpaint}"
        )

        with jobs.stage_timer(
            job_id,
            f"video_stereo[{inpaint}]",
            gpu=VIDEO_STEREO_GPU,
            frames=num_frames,
            width=width,
            height=height,
        ):
            with torch.no_grad():
                for i in range(0, num_frames, batch_size):
                    j = min(i + batch_size, num_frames)
                    frames = decoder[i:j].cuda()  # (T, 3, H, W) uint8
                    depths = depth_decoder[i:j].cuda()  # (T, C, h, w) uint8
                    if depths.shape[1] > 1:
                        depths = depths[:, :1]
                    depths = to_source(depths)

                    if inpaint == "none":
                        self._write_raw_warp(writer, frames, depths, displacement)
                    else:
                        self._write_inpainted(
                            writer, frames, depths, displacement, to_work, to_source
                        )

                    del frames, depths
                    torch.cuda.empty_cache()

            writer.stdin.close()
            writer.wait()

        cache_volume.commit()
        return {
            "sbs_path": str(out),
            "num_frames": num_frames,
            "fps": fps,
            "width": width * 2,
            "height": height,
            "inpaint": inpaint,
        }

    # ------------------------------------------------------------ modes

    def _write_raw_warp(self, writer, frames, depths, displacement: float) -> None:
        """Forward warp only — no masks, no inpainting."""
        for k in range(frames.shape[0]):
            frame = frames[k].unsqueeze(0)
            depth = depths[k].unsqueeze(0).float() / 255.0
            left, right, _, _ = self.splatter(
                image=frame, depthmap=depth, disp=displacement, stereo_mode=BOTH
            )
            sbs = torch.cat([left, right], dim=3)
            sbs = (sbs * 255).clamp(0, 255).to(torch.uint8)
            writer.stdin.write(sbs.squeeze(0).permute(1, 2, 0).cpu().numpy().tobytes())

    def _write_inpainted(self, writer, frames, depths, displacement, to_work, to_source) -> None:
        """Splat at source resolution, inpaint occlusions with
        ProPainter at working resolution, then composite the upscaled
        fill back into the full-resolution warp.

        Unlike the old pipeline (which round-tripped whole frames
        through the working resolution, softening everything), only the
        occlusion holes receive upscaled inpainted pixels — the rest of
        the frame keeps source detail.
        """
        l_work, l_masks, l_dilated = [], [], []
        r_work, r_masks, r_dilated = [], [], []
        l_hires, r_hires = [], []  # full-res warp + dilated mask, uint8/bool on CPU

        for k in range(frames.shape[0]):
            frame = frames[k].unsqueeze(0)
            depth = depths[k].unsqueeze(0).float() / 255.0
            left, right, left_occ, right_occ = self.splatter(
                image=frame, depthmap=depth, disp=displacement, stereo_mode=BOTH
            )
            left_u8 = (left * 255).clamp(0, 255).to(torch.uint8)
            right_u8 = (right * 255).clamp(0, 255).to(torch.uint8)
            l_mask_hi = propainter_runner.dilate_mask(left_occ > 0.5, kernel_size=3, iterations=2)
            r_mask_hi = propainter_runner.dilate_mask(right_occ > 0.5, kernel_size=3, iterations=2)
            l_hires.append((left_u8.cpu(), l_mask_hi.cpu()))
            r_hires.append((right_u8.cpu(), r_mask_hi.cpu()))

            l_work.append(to_work(left_u8))
            r_work.append(to_work(right_u8))
            l_mask = to_work(left_occ) > 0.5
            r_mask = to_work(right_occ) > 0.5
            l_masks.append(l_mask)
            r_masks.append(r_mask)
            l_dilated.append(propainter_runner.dilate_mask(l_mask, kernel_size=3, iterations=2))
            r_dilated.append(propainter_runner.dilate_mask(r_mask, kernel_size=3, iterations=2))

        l_work = torch.cat(l_work, dim=0)
        r_work = torch.cat(r_work, dim=0)
        l_masks = torch.cat(l_masks, dim=0)
        r_masks = torch.cat(r_masks, dim=0)
        l_dilated = torch.cat(l_dilated, dim=0)
        r_dilated = torch.cat(r_dilated, dim=0)
        track("propainter_l_frames", l_work, logger)

        left_done = propainter_runner.inpaint_window(self.propainter, l_work, l_masks, l_dilated)
        torch.cuda.empty_cache()
        right_done = propainter_runner.inpaint_window(self.propainter, r_work, r_masks, r_dilated)
        torch.cuda.empty_cache()

        for k, (lf, rf) in enumerate(zip(left_done, right_done)):
            left = self._composite(lf, *l_hires[k], to_source)
            right = self._composite(rf, *r_hires[k], to_source)
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
