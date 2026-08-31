"""Depth-stage cost benchmark (staging Modal, R&D only).

    MODAL_PROFILE=stereo-crafter-stg APP_ENV=test modal run scripts/bench_depth.py \
        [--clip videos/clip_60s_scenes_1080p.mp4] [--input-size 980] [--h100]

Answers, with numbers instead of guesses, where a depth chunk's paid GPU
seconds go and which levers pay:

1. PHASES — the real DepthProcessor.write_depth_video, instrumented:
   decode (torchcodec) / model forward / everything else (pre-process,
   to-cpu, normalize, gray16 x264 encode) / volume commit, per scene.
2. SHORT-WINDOW variant — the last window of each scene is sized to the
   frames that remain instead of padded to INFER_LEN=32 by repeating the
   last frame (and the tail is flushed explicitly). Same alignment math.
   Reports the frames-through-the-model ratio, wall time, and the depth
   delta vs baseline (mean |Δ| on [0,1]-normalized depth, per scene).
3. FORWARD-ONLY microbench — ms/frame at T ∈ {32, 16, 8} and B ∈ {1, 2}
   on the chosen GPU, so $/frame can be compared across tiers.
4. ENCODE — libx264 preset slow (current) vs veryfast for a gray16 scene.

Nothing here touches the pipeline; it imports the production modules.
"""

import time
from pathlib import Path

import modal

from app.common.storage import GPU_VOLUMES, bucket_path, cache_volume, hf_secret
from app.images import video_depth_image
from app.modal_app import app

with video_depth_image.imports():
    import torch

    from app.common.weights import ensure_video_depth_anything
    from app.stages.depth_processor import DepthProcessor, load_video_depth_model
    from app.vendor.video_depth_anything.video_depth_v3 import (
        INFER_LEN, INTERP_LEN, KEYFRAMES, OVERLAP, compute_scale_and_shift, get_interpolate_frames,
    )


def _sync():
    torch.cuda.synchronize()


class _TimedDecoder:
    """Proxy around torchcodec's VideoDecoder that accumulates decode time."""

    def __init__(self, inner):
        self._d = inner
        self.seconds = 0.0

    def __getitem__(self, k):
        t = time.perf_counter()
        out = self._d[k]
        self.seconds += time.perf_counter() - t
        return out

    def __getattr__(self, name):
        return getattr(self._d, name)


class _TimedModel:
    def __init__(self, model):
        self._m = model
        self.seconds = 0.0
        self.frames = 0

    def forward(self, x):
        _sync(); t = time.perf_counter()
        out = self._m.forward(x)
        _sync(); self.seconds += time.perf_counter() - t
        self.frames += x.shape[1]
        return out

    def __getattr__(self, name):
        return getattr(self._m, name)


def _short_window_cls():
    """Built at runtime: DepthProcessor only exists inside the GPU image
    (the imports() block is a no-op elsewhere, e.g. on the launching Mac)."""
    class ShortWindowProcessor(DepthProcessor):
        """Variant: the final window of a scene covers only the frames that
        remain (T = min(INFER_LEN, last - frame_id)); the INTERP_LEN tail is
        flushed at the end instead of being pushed out by padded frames."""

        def _process_scene(self, first, last):
            device = self.device
            pre_input = None
            aligned, ref_align = [], []
            emitted = 0
            scene_len = last - first
            for frame_id in range(first, last, self.FRAME_STEP):
                T = min(INFER_LEN, last - frame_id)
                if pre_input is not None and T <= OVERLAP:
                    break  # nothing new: those frames are already in the tail
                cur_input = self.decoder[frame_id: frame_id + T].unsqueeze(0).to(device)
                cur_input = self.pre_process(cur_input)
                if pre_input is not None:
                    cur_input[:, :OVERLAP, ...] = pre_input[:, KEYFRAMES, ...]
                # the NEXT window needs KEYFRAMES (up to index 31) from this one:
                # only a full window can be a context source, which holds because
                # only the last window is ever short
                pre_input = cur_input
                with torch.no_grad(), torch.autocast(device_type=device, enabled=not self.fp32):
                    depth = self.model.forward(cur_input)
                depth = depth.to(cur_input.dtype).flatten(0, 1).unsqueeze(1)
                if not aligned:
                    aligned.extend(depth[i] for i in range(T))
                    ref_align.extend(depth[kf] for kf in self.KF_ALIGN_LIST if kf < T)
                else:
                    pred = depth[: self.ALIGN_LEN].reshape(-1)
                    target = torch.cat(ref_align, dim=0).reshape(-1)
                    scale, shift = compute_scale_and_shift(pred, target, torch.ones_like(target))
                    pre_blend = aligned[-INTERP_LEN:]
                    post_blend = [(depth[i] * scale + shift).clamp(min=0.0) for i in range(self.ALIGN_LEN, OVERLAP)]
                    aligned[-INTERP_LEN:] = get_interpolate_frames(pre_blend, post_blend)
                    for i in range(OVERLAP, T):
                        aligned.append((depth[i] * scale + shift).clamp(min=0.0))
                    ref_align = ref_align[:1] + [(depth[kf] * scale + shift).clamp(min=0.0) for kf in self.KF_ALIGN_LIST[1:]]
                if len(aligned) > INTERP_LEN:
                    final = torch.stack(aligned[:-INTERP_LEN], dim=0)
                    if emitted + final.shape[0] > scene_len:
                        final = final[: scene_len - emitted]
                    emitted += final.shape[0]
                    yield final
                    aligned = aligned[-INTERP_LEN:]
            if aligned and emitted < scene_len:
                tail = torch.stack(aligned, dim=0)[: scene_len - emitted]
                emitted += tail.shape[0]
                yield tail
            assert emitted == scene_len, (first, last, emitted)
    return ShortWindowProcessor


def _run_processor(cls, src, model, input_size, out, ranges=None, label=""):
    proc = cls(src, model, input_size=input_size, scene_ranges=ranges)
    dec = _TimedDecoder(proc.decoder); proc.decoder = dec
    tm = _TimedModel(model); proc.model = tm
    commits = [0.0]
    scene_wall = []

    def on_scene_done(first, last):
        t = time.perf_counter(); cache_volume.commit()  # what the worker does per scene
        commits[0] += time.perf_counter() - t

    t0 = time.perf_counter()
    res = proc.write_depth_video(out, on_scene_done=on_scene_done, concat=False)
    wall = time.perf_counter() - t0
    n = res.num_frames
    other = wall - dec.seconds - tm.seconds - commits[0]
    print(f"[{label}] frames={n} scenes={len(res.segments)} wall={wall:.1f}s → {n/wall:.2f} fps"
          f" | decode {dec.seconds:.1f}s | forward {tm.seconds:.1f}s ({tm.frames} frames through model,"
          f" {tm.frames/n:.2f}× video, {1000*tm.seconds/tm.frames:.1f} ms/model-frame)"
          f" | commit {commits[0]:.1f}s | other(pre+cpu+norm+x264) {other:.1f}s")
    return res, proc


def _read_gray16(path):
    from torchcodec.decoders import VideoDecoder
    d = VideoDecoder(str(path), device="cpu")
    return d[:].float()[:, :1] / 255.0  # 8-bit read is enough for a delta


def _bench_forward(model, input_size, gpu_label):
    h = input_size; w = round(input_size * 16 / 9 / 14) * 14  # 16:9 work frame
    print(f"[forward:{gpu_label}] input {h}x{w}")
    # B=2 T=32 at 980 OOMs a 44 GB L40S (measured) — batching windows is out
    for B, T in ((1, 32), (1, 16), (1, 8)):
        x = torch.randn(B, T, 3, h, w, device="cuda", dtype=torch.float16)
        with torch.no_grad(), torch.autocast("cuda"):
            for _ in range(2): model.forward(x)  # warm-up
            _sync(); t = time.perf_counter()
            for _ in range(3): model.forward(x)
            _sync(); dt = (time.perf_counter() - t) / 3
        print(f"[forward:{gpu_label}] B={B} T={T}: {dt*1000:.0f} ms/window = {dt*1000/(B*T):.1f} ms/frame")
        del x; torch.cuda.empty_cache()


def _bench_encode(h, w, frames=600):
    import numpy as np
    data = (np.random.rand(frames, h, w) * 65535).astype(np.uint16).tobytes()
    for preset in ("slow", "veryfast"):
        import ffmpeg
        t = time.perf_counter()
        p = (ffmpeg.input("pipe:", format="rawvideo", pix_fmt="gray16le", s=f"{w}x{h}", r=24)
             .output("/tmp/enc_test.mp4", pix_fmt="gray16le", vcodec="libx264", preset=preset, crf=18, vsync="cfr", r=24)
             .global_args("-loglevel", "error", "-threads", "0").overwrite_output().run_async(pipe_stdin=True))
        p.stdin.write(data); p.stdin.close(); p.wait()
        size = Path("/tmp/enc_test.mp4").stat().st_size
        print(f"[encode] preset={preset}: {time.perf_counter()-t:.1f}s for {frames} frames {w}x{h} gray16 → {size/1e6:.1f} MB")


BENCH_DIR = Path("/cache/bench_depth")  # cache volume: shared between the two containers


def _pass(clip: str, input_size: int, gpu_label: str, mode: str, ranges=None):
    """One full DepthProcessor pass in a FRESH container (a T=32 window at
    980 px needs ~18.7 GB on top of ~26 GB of activations, so two passes in
    one 44 GB L40S process OOM on leftovers). Segments land in the cache
    volume for the delta step. Returns (scene ranges, segment paths)."""
    from app.common.storage import safe_reload
    safe_reload(cache_volume)
    src = bucket_path(f"inputs/samples/{clip}")
    assert src.exists(), src
    t = time.perf_counter()
    model = load_video_depth_model(ensure_video_depth_anything("vitl"), "vitl")
    print(f"[{gpu_label}:{mode}] model load {time.perf_counter()-t:.1f}s | {torch.cuda.get_device_name(0)}")
    out_dir = BENCH_DIR / mode; out_dir.mkdir(parents=True, exist_ok=True)
    cls = DepthProcessor if mode == "baseline" else _short_window_cls()
    res, _ = _run_processor(cls, src, model, input_size, out_dir / "depth.mp4", ranges=ranges, label=f"{mode}:{gpu_label}")
    cache_volume.commit()
    if ranges is None:
        ranges, first = [], 0
        for last in res.scene_cuts:
            ranges.append((first, last)); first = last
        lens = [b - a for a, b in ranges]
        print(f"[scenes] {len(ranges)} scenes, mean {sum(lens)/len(lens):.1f} frames, min {min(lens)}, max {max(lens)}")
    return ranges, res.segments, list(res.depth_shape)


def _delta(base_segments, short_segments, depth_shape):
    from app.common.storage import safe_reload
    safe_reload(cache_volume)
    deltas = []
    for a, b in zip(base_segments, short_segments):
        da, db = _read_gray16(a), _read_gray16(b)
        assert da.shape == db.shape, (a, da.shape, db.shape)
        deltas.append((da - db).abs().mean().item())
    print(f"[delta] mean|Δdepth| per scene: mean {sum(deltas)/len(deltas):.4f}, max {max(deltas):.4f} (0–1 scale, {len(deltas)} scenes)")
    h, w = depth_shape
    _bench_encode(h, w)


def _forward_only(input_size: int, gpu_label: str):
    t = time.perf_counter()
    model = load_video_depth_model(ensure_video_depth_anything("vitl"), "vitl")
    print(f"[{gpu_label}] model load {time.perf_counter()-t:.1f}s | {torch.cuda.get_device_name(0)}")
    _bench_forward(model, input_size, gpu_label)


_GPU_KW = dict(volumes=GPU_VOLUMES, secrets=[hf_secret], cpu=4, memory=16 * 1024, timeout=3600,
               env={"PYTORCH_CUDA_ALLOC_CONF": "expandable_segments:True", "PYTORCH_ALLOC_CONF": "expandable_segments:True"})


@app.function(image=video_depth_image, gpu="L40S", **_GPU_KW)
def pass_l40s(clip: str, input_size: int, mode: str, ranges=None):
    return _pass(clip, input_size, "L40S", mode, ranges)


@app.function(image=video_depth_image, gpu="L40S", **_GPU_KW)
def delta_l40s(base_segments, short_segments, depth_shape):
    _delta(base_segments, short_segments, depth_shape)


@app.function(image=video_depth_image, gpu="H100", **_GPU_KW)
def forward_h100(input_size: int):
    _forward_only(input_size, "H100")


@app.local_entrypoint()
def main(clip: str = "videos/clip_60s_scenes_1080p.mp4", input_size: int = 980, h100: bool = False):
    ranges, base_segs, shape = pass_l40s.remote(clip, input_size, "baseline")
    _, short_segs, _ = pass_l40s.remote(clip, input_size, "short", ranges)
    delta_l40s.remote(base_segs, short_segs, shape)
    if h100:
        forward_h100.remote(input_size)
