"""Still-image stereo worker (GPU, A10G).

One container runs the whole image pipeline — black-bar crop, depth
(TorchScript Depth-Anything-V2-Large fp16), forward-warp splatting,
LAMA inpainting, output composition — since each step is fast and
shipping tensors between containers would dominate runtime.
"""

import time
from pathlib import Path

import modal

from app.common import jobs
from app.common.debug import get_logger, track
from app.common.storage import (
    GPU_VOLUMES,
    bucket_path,
    hf_secret,
    job_output_dir,
    public_url,
)
from app.images import image_stereo_image
from app.modal_app import app

logger = get_logger(__name__)

IMAGE_GPU = "A10G"

# Depth model input: longest side ~1400px, snapped to a multiple of 14.
DEPTH_MAX_SIDE = 1400
# LAMA was traced at a fixed square input.
LAMA_SIZE = (1008, 1008)

with image_stereo_image.imports():
    import torch
    import torchvision.io as tv_io
    import torchvision.transforms.v2 as v2
    from PIL import Image, ImageOps
    from pillow_heif import register_heif_opener

    from app.common.weights import ensure_depth_anything_v2, ensure_lama
    from app.stages import stereo_formats
    from app.stages.splat import BOTH, LEFT, RIGHT, DepthSplatter


@app.cls(
    gpu=IMAGE_GPU,
    image=image_stereo_image,
    volumes=GPU_VOLUMES,
    secrets=[hf_secret],
    cpu=2,
    memory=(2 * 1024, 32 * 1024),
    timeout=3600,
    scaledown_window=120,
)
class ImageStereoWorker:
    @modal.enter()
    def load(self) -> None:
        start = time.perf_counter()
        torch.backends.cudnn.benchmark = True
        register_heif_opener()

        self.depth_model = torch.jit.optimize_for_inference(
            torch.jit.load(str(ensure_depth_anything_v2()), map_location="cuda")
        )
        self.lama = torch.jit.optimize_for_inference(
            torch.jit.load(str(ensure_lama()), map_location="cuda")
        )
        self.splatter = DepthSplatter().eval()
        logger.info(f"🚀 image worker ready in {time.perf_counter() - start:.1f}s")

    @modal.method()
    def process_batch(self, job_id: str, items: list[dict]) -> dict:
        """Process a batch of images sequentially in this container.
        Each item: {"item_id", "input_path", "displacement", "stereo_mode",
        "formats", "output_depthmap", "remove_black_bars"}."""
        results: dict[str, dict] = {}
        completed = failed = 0
        for item in items:
            item_id = item["item_id"]
            try:
                results[item_id] = self._process_one(job_id, item)
                completed += 1
            except Exception as exc:  # keep batch going; report per item
                logger.exception(f"❌ item {item_id} failed")
                results[item_id] = {"status": jobs.FAILED, "error": str(exc)}
                failed += 1
            jobs.update_job(
                job_id,
                progress=(completed + failed) / len(items),
                outputs={k: v.get("outputs", {}) for k, v in results.items()},
            )
        return {"results": results, "completed": completed, "failed": failed}

    # ----------------------------------------------------------- steps

    def _process_one(self, job_id: str, item: dict) -> dict:
        item_id = item["item_id"]
        displacement = float(item.get("displacement", 0.01))
        stereo_mode = item.get("stereo_mode", BOTH)
        formats = item.get("formats", ["lr"])
        unknown = set(formats) - set(stereo_formats.FORMATS)
        if unknown:
            raise ValueError(f"unknown formats: {sorted(unknown)}")

        with jobs.stage_timer(job_id, f"image[{item_id}]", gpu=IMAGE_GPU):
            frame = self._load_image(bucket_path(item["input_path"]))
            if item.get("remove_black_bars", True):
                frame, crop_box = self._crop_black_bars(frame)
            else:
                crop_box = None
            track("original_frame", frame, logger)

            depth = self._estimate_depth(frame)
            track("depth_normalized", depth, logger)

            left, right = self._stereo_pair(frame, depth, displacement, stereo_mode)

            out_dir = job_output_dir(job_id)
            outputs: dict[str, str] = {}
            self._save_png(left, out_dir / f"{item_id}_left.png")
            self._save_png(right, out_dir / f"{item_id}_right.png")
            outputs["left"] = public_url(out_dir / f"{item_id}_left.png")
            outputs["right"] = public_url(out_dir / f"{item_id}_right.png")

            for fmt in formats:
                composed = stereo_formats.compose_stereo(left, right, fmt)
                path = out_dir / f"{item_id}_{fmt}.png"
                self._save_png(composed, path)
                outputs[fmt] = public_url(path)

            if item.get("output_depthmap", True):
                colored = stereo_formats.colorize_depth(depth)
                path = out_dir / f"{item_id}_depth.png"
                self._save_png(colored, path)
                outputs["depth"] = public_url(path)

        return {
            "status": jobs.COMPLETED,
            "outputs": outputs,
            "crop_box": crop_box,
        }

    def _load_image(self, path: Path) -> "torch.Tensor":
        """Read JPEG/PNG/HEIC as (1, 3, H, W) uint8 on GPU, EXIF-rotated."""
        if not path.exists():
            raise FileNotFoundError(f"input image not found: {path}")
        if path.suffix.lower() in (".heic", ".heif"):
            pil = Image.open(path)
            if pil.mode != "RGB":
                pil = pil.convert("RGB")
            pil = ImageOps.exif_transpose(pil)
            tensor = v2.PILToTensor()(pil)
        else:
            tensor = tv_io.read_image(
                str(path),
                mode=tv_io.image.ImageReadMode.RGB,
                apply_exif_orientation=True,
            )
        return tensor.unsqueeze(0).cuda()

    def _crop_black_bars(self, frame: "torch.Tensor", threshold: int = 24) -> tuple["torch.Tensor", list[int] | None]:
        """Trim uniform near-black borders (letterbox/pillarbox). Black
        bars distort depth estimation and waste disparity budget."""
        gray = frame[0].float().mean(dim=0)  # (H, W)
        row_max = gray.max(dim=1).values
        col_max = gray.max(dim=0).values
        rows = torch.nonzero(row_max > threshold).flatten()
        cols = torch.nonzero(col_max > threshold).flatten()
        if rows.numel() == 0 or cols.numel() == 0:
            return frame, None
        top, bottom = int(rows[0]), int(rows[-1]) + 1
        left, right = int(cols[0]), int(cols[-1]) + 1
        h, w = gray.shape
        if top == 0 and left == 0 and bottom == h and right == w:
            return frame, None
        logger.info(f"✂️  black-bar crop: rows [{top}:{bottom}], cols [{left}:{right}]")
        return frame[:, :, top:bottom, left:right], [left, top, right, bottom]

    def _estimate_depth(self, frame: "torch.Tensor") -> "torch.Tensor":
        """(1, 3, H, W) uint8 -> (1, 1, H, W) float depth in [0, 1]."""
        _, _, h, w = frame.shape
        scale = DEPTH_MAX_SIDE / max(w, h)
        dw = int(w * scale / 14) * 14
        dh = int(h * scale / 14) * 14

        pre = torch.nn.Sequential(
            v2.ToDtype(torch.float16, scale=True),
            v2.Resize((dh, dw), interpolation=v2.InterpolationMode.BICUBIC),
            v2.Normalize(mean=[0.43216, 0.394666, 0.37645], std=[0.22803, 0.22145, 0.216989]),
        )
        post = v2.Resize((h, w), interpolation=v2.InterpolationMode.BILINEAR)

        depth = self.depth_model(pre(frame))[0]
        depth = post(depth).unsqueeze(1).float()
        return (depth - depth.min()) / (depth.max() - depth.min() + 1e-8)

    def _stereo_pair(self, frame, depth, displacement: float, stereo_mode: str):
        """Splat + LAMA-inpaint. Returns (left, right) uint8 (1,3,H,W)."""
        splat_left, splat_right, left_occ, right_occ = self.splatter(
            image=frame, depthmap=depth, disp=displacement, stereo_mode=stereo_mode
        )

        left = right = None
        if stereo_mode in (BOTH, LEFT):
            left = self._inpaint(splat_left, left_occ)
        if stereo_mode in (BOTH, RIGHT):
            right = self._inpaint(splat_right, right_occ)
        if stereo_mode == LEFT:
            right = frame
        if stereo_mode == RIGHT:
            left = frame
        return left, right

    def _inpaint(self, image: "torch.Tensor", occlusion: "torch.Tensor") -> "torch.Tensor":
        """LAMA fill of occluded pixels. image float [0,1], occlusion
        float [0,1] where 1 = hole. Returns uint8 (1, 3, H, W)."""
        _, _, h, w = image.shape
        valid = occlusion <= 0.5  # True where the warp produced pixels

        resize_in = v2.Resize(LAMA_SIZE, interpolation=v2.InterpolationMode.NEAREST_EXACT)
        resize_out = v2.Resize((h, w), interpolation=v2.InterpolationMode.BICUBIC)

        with torch.jit.optimized_execution(True):
            fill = self.lama(resize_in(image), resize_in((~valid).float()))
        fill = resize_out(fill) / 255.0

        result = image * valid + fill * ~valid
        return (result * 255).clamp(0, 255).to(torch.uint8)

    @staticmethod
    def _save_png(tensor: "torch.Tensor", path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        v2.ToPILImage()(tensor.squeeze(0).cpu()).save(path)
