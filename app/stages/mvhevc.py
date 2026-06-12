"""MV-HEVC encoding for Apple Vision Pro (experimental).

Converts a full-width SBS master into a two-view MV-HEVC .mov using
NVENC on an L4 (verified: ffmpeg 8.1 `hevc_nvenc -profile:v mv` works
on Modal's driver 580 hosts; B200/H100/H200/A100 have no NVENC).

Current output is a playable MV-HEVC (Multiview Main) file. The extra
`vexu` spatial metadata that makes Photos treat it as "spatial video"
is a planned follow-up (Linux-side atom injection); third-party AVP
players handle plain MV-HEVC already.
"""

import json
import subprocess
import tempfile
from pathlib import Path

import modal

from app.common import jobs
from app.common.errors import fail_fast
from app.common.debug import get_logger
from app.common.storage import (
    slack_secret,
    PIPELINE_VOLUMES,
    cache_volume,
    job_output_dir,
    public_url,
    safe_reload,
)
from app.images import nvenc_image
from app.modal_app import app
from app.stages import vexu as vexu_blobs

logger = get_logger(__name__)

MVHEVC_GPU = "L4"


@app.function(
    image=nvenc_image,
    gpu=MVHEVC_GPU,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    cpu=4,
    memory=(2 * 1024, 16 * 1024),
    timeout=3600,
    retries=modal.Retries(max_retries=2, initial_delay=10.0, backoff_coefficient=2.0),
)
@fail_fast
def encode_mvhevc(
    job_id: str,
    sbs_path: str,
    quality: int = 28,
    original_path: str | None = None,
    spatial: dict | None = None,
) -> dict:
    """Encode a full-width SBS video into Apple spatial video:
    MV-HEVC (NVENC) → MP4Box mux (hvcC+lhvC) → vexu/hfov injection.

    spatial: {"hero": "left"|"right"|None, "baseline_mm": float,
              "hfov_deg": float, "dadj": int} — see app/stages/vexu.py
    for defaults (iPhone-15-Pro-like).
    """
    from app.common.debug import job_logger

    jlog = job_logger(job_id)

    safe_reload(cache_volume)
    sbs = Path(sbs_path)
    if not sbs.exists():
        raise FileNotFoundError(sbs)

    out_dir = job_output_dir(job_id)

    from app.stages.media import probe_video

    fps = probe_video(sbs)["fps"]
    jlog.info(f"🎯 MV-HEVC encode: {sbs.name} @ {fps:.3f} fps, cq={quality}, spatial={spatial}")

    with jobs.stage_timer(job_id, "encode_mvhevc", gpu=MVHEVC_GPU, quality=quality):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            raw = tmp_dir / "video.hevc"
            local = tmp_dir / "mvhevc.mov"

            # 1) split SBS into eyes, interleave as frame-sequence
            #    stereo, encode two views with NVENC's multiview profile.
            #    Output a RAW elementary stream: ffmpeg's mov muxer drops
            #    the second view's layer data (verified) — MP4Box doesn't.
            encode = subprocess.run(
                [
                    "ffmpeg8", "-y", "-hide_banner", "-loglevel", "warning",
                    "-i", str(sbs),
                    "-filter_complex",
                    "[0:v]crop=iw/2:ih:0:0[left];[0:v]crop=iw/2:ih:iw/2:0[right];"
                    "[left][right]framepack=frameseq[v]",
                    "-map", "[v]",
                    "-c:v", "hevc_nvenc", "-profile:v", "mv", "-tune", "hq",
                    "-rc", "vbr", "-cq", str(quality), "-b_ref_mode", "0",
                    "-f", "hevc", str(raw),
                ],
                capture_output=True, text=True,
            )
            if encode.returncode != 0:
                raise RuntimeError(f"MV-HEVC encode failed: {encode.stderr[-2000:]}")
            jlog.info(f"✔ NVENC two-view stream: {raw.stat().st_size / 1e6:.1f} MB")

            # 2) optional audio from the original
            mux_inputs = ["-add", f"{raw}:fps={fps}"]
            original = Path(original_path) if original_path else None
            if original and original.exists():
                audio = tmp_dir / "audio.m4a"
                got_audio = subprocess.run(
                    ["ffmpeg8", "-y", "-loglevel", "error", "-i", str(original),
                     "-vn", "-c:a", "aac", str(audio)],
                    capture_output=True, text=True,
                ).returncode == 0 and audio.exists()
                if got_audio:
                    mux_inputs += ["-add", str(audio)]

            # 3) mux with MP4Box (modern GPAC writes hvcC + lhvC;
            #    ffmpeg's mov muxer would drop the second view)
            muxed = tmp_dir / "muxed.mp4"
            mux = subprocess.run(
                ["MP4Box", *mux_inputs, "-new", str(muxed)],
                capture_output=True, text=True,
            )
            if mux.returncode != 0:
                raise RuntimeError(f"MP4Box mux failed: {mux.stderr[-2000:]}")
            jlog.info(f"✔ MP4Box mux done (audio={'yes' if len(mux_inputs) > 2 else 'no'})")

            # 4) inject Apple spatial metadata (vexu + hfov) into the
            #    hvc1 sample entry — required for the visionOS/macOS
            #    "spatial media" treatment
            spatial = spatial or {}
            (tmp_dir / "vexu.bin").write_bytes(
                vexu_blobs.build_vexu(
                    hero=spatial.get("hero", "left"),
                    baseline_mm=float(spatial.get("baseline_mm", vexu_blobs.DEFAULT_BASELINE_MM)),
                    dadj=int(spatial.get("dadj", vexu_blobs.DEFAULT_DADJ)),
                    projection=spatial.get("projection", "rect"),
                )
            )
            (tmp_dir / "hfov.bin").write_bytes(
                vexu_blobs.build_hfov(float(spatial.get("hfov_deg", vexu_blobs.DEFAULT_HFOV_DEG)))
            )
            inject = subprocess.run(
                ["mp4edit",
                 "--insert", f"moov/trak/mdia/minf/stbl/stsd/hvc1:{tmp_dir}/vexu.bin",
                 "--insert", f"moov/trak/mdia/minf/stbl/stsd/hvc1:{tmp_dir}/hfov.bin",
                 str(muxed), str(local)],
                capture_output=True, text=True,
            )
            if inject.returncode != 0:
                raise RuntimeError(f"vexu injection failed: {inject.stderr[-1000:]}")

            # 5) verify: lhvC + vexu + hfov present, second view decodes
            dump = subprocess.run(
                ["mp4dump", str(local)], capture_output=True, text=True
            ).stdout
            boxes_ok = all(tag in dump for tag in ("lhvC", "vexu", "hfov"))

            info = subprocess.run(
                ["ffprobe8", "-v", "error", "-show_entries",
                 "stream=codec_name,codec_tag_string,profile,width,height",
                 "-of", "json", str(local)],
                capture_output=True, text=True,
            ).stdout

            check = subprocess.run(
                ["ffmpeg8", "-y", "-loglevel", "error", "-i", str(local),
                 "-map", "0:v:view:1", "-frames:v", "1", str(tmp_dir / "v1.png")],
                capture_output=True, text=True,
            )
            two_views = check.returncode == 0 and (tmp_dir / "v1.png").exists()

            dst = out_dir / "mvhevc.mov"
            dst.write_bytes(local.read_bytes())
            jlog.info(
                f"🏁 spatial .mov published: {local.stat().st_size / 1e6:.1f} MB, "
                f"boxes_ok={boxes_ok}, two_views={two_views} → {public_url(dst)}"
            )

    return {
        "mvhevc": public_url(dst),
        "two_views_verified": two_views,
        "spatial_boxes_verified": boxes_ok,
        "streams": json.loads(info).get("streams", []),
    }


@app.function(
    image=nvenc_image,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    cpu=16,
    memory=(8 * 1024, 32 * 1024),
    timeout=3600,
    retries=modal.Retries(max_retries=2, initial_delay=10.0, backoff_coefficient=2.0),
)
@fail_fast
def encode_mvhevc_x265(
    job_id: str,
    sbs_path: str,
    crf: int = 23,
    preset: str = "medium",
    original_path: str | None = None,
    spatial: dict | None = None,
) -> dict:
    """Apple-recognized spatial video via x265 MV-HEVC (CPU).

    x265 is the only Linux encoder whose VPS multiview signaling
    Apple's spatial classifier accepts — NVENC output (encode_mvhevc)
    plays in players but never earns the Photos/Files spatial badge.
    Same downstream chain: MP4Box mux (hvcC+lhvC) + vexu/hfov injection.
    """
    from app.common.debug import job_logger
    from app.stages.media import probe_video

    jlog = job_logger(job_id)
    safe_reload(cache_volume)
    sbs = Path(sbs_path)
    if not sbs.exists():
        raise FileNotFoundError(sbs)

    probe = probe_video(sbs)
    eye_w, eye_h = probe["width"] // 2, probe["height"]
    fps_rational = probe["fps_rational"]
    num_frames = probe["num_frames"]
    keyint = max(1, round(probe["fps"] * 2))  # closed 2s GOPs for visionOS
    out_dir = job_output_dir(job_id)
    jlog.info(f"🎯 x265 MV-HEVC: {eye_w}x{eye_h}/eye, {num_frames}f, crf={crf}, preset={preset}")

    with jobs.stage_timer(job_id, "encode_mvhevc_x265", crf=crf, preset=preset):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            yuv = tmp_dir / "sbs.yuv"
            raw = tmp_dir / "video.hevc"

            # 1) decode the full-SBS master to raw 8-bit yuv420p
            subprocess.run(
                ["ffmpeg8", "-y", "-loglevel", "error", "-i", str(sbs),
                 "-an", "-pix_fmt", "yuv420p", "-f", "rawvideo", str(yuv)],
                check=True,
            )

            # 2) x265 multiview: format 1 = one SBS input, two views;
            #    --input-res is PER-VIEW
            cfg = tmp_dir / "mv.cfg"
            cfg.write_text(f'--num-views 2\n--format 1\n--input "{yuv}"\n')
            enc = subprocess.run(
                ["x265", "--multiview-config", str(cfg),
                 "--input-res", f"{eye_w}x{eye_h}", "--input-csp", "i420",
                 "--input-depth", "8", "--fps", fps_rational,
                 "--frames", str(num_frames), "--profile", "main",
                 "--colorprim", "bt709", "--transfer", "bt709",
                 "--colormatrix", "bt709", "--range", "limited",
                 "--preset", preset, "--crf", str(crf),
                 "--keyint", str(keyint), "--min-keyint", str(keyint),
                 "--no-open-gop", "--repeat-headers",
                 "--output", str(raw)],
                capture_output=True, text=True,
            )
            if enc.returncode != 0 or not raw.exists():
                raise RuntimeError(f"x265 multiview encode failed: {enc.stderr[-2000:]}")
            jlog.info(f"✔ x265 two-view stream: {raw.stat().st_size / 1e6:.1f} MB")

            # 3) mux + audio + vexu/hfov injection (same proven chain)
            mux_inputs = ["-add", f"{raw}:fps={fps_rational}:colr=nclx,bt709,bt709,bt709,off"]
            original = Path(original_path) if original_path else None
            if original and original.exists():
                audio = tmp_dir / "audio.m4a"
                ok = subprocess.run(
                    ["ffmpeg8", "-y", "-loglevel", "error", "-i", str(original),
                     "-vn", "-c:a", "aac", str(audio)],
                    capture_output=True, text=True,
                ).returncode == 0 and audio.exists()
                if ok:
                    mux_inputs += ["-add", str(audio)]

            muxed = tmp_dir / "muxed.mp4"
            local = tmp_dir / "mvhevc.mov"
            mux = subprocess.run(["MP4Box", *mux_inputs, "-new", str(muxed)],
                                 capture_output=True, text=True)
            if mux.returncode != 0:
                raise RuntimeError(f"MP4Box mux failed: {mux.stderr[-1500:]}")

            spatial = spatial or {}
            (tmp_dir / "vexu.bin").write_bytes(vexu_blobs.build_vexu(
                hero=spatial.get("hero", "left"),
                baseline_mm=float(spatial.get("baseline_mm", vexu_blobs.DEFAULT_BASELINE_MM)),
                dadj=int(spatial.get("dadj", vexu_blobs.DEFAULT_DADJ)),
                projection=spatial.get("projection", "rect"),
            ))
            (tmp_dir / "hfov.bin").write_bytes(
                vexu_blobs.build_hfov(float(spatial.get("hfov_deg", vexu_blobs.DEFAULT_HFOV_DEG)))
            )
            inject = subprocess.run(
                ["mp4edit",
                 "--insert", f"moov/trak/mdia/minf/stbl/stsd/hvc1:{tmp_dir}/vexu.bin",
                 "--insert", f"moov/trak/mdia/minf/stbl/stsd/hvc1:{tmp_dir}/hfov.bin",
                 str(muxed), str(local)],
                capture_output=True, text=True,
            )
            if inject.returncode != 0:
                raise RuntimeError(f"vexu injection failed: {inject.stderr[-1000:]}")

            dump = subprocess.run(["mp4dump", str(local)], capture_output=True, text=True).stdout
            boxes_ok = all(tag in dump for tag in ("lhvC", "vexu", "hfov"))
            check = subprocess.run(
                ["ffmpeg8", "-y", "-loglevel", "error", "-i", str(local),
                 "-map", "0:v:view:1", "-frames:v", "1", str(tmp_dir / "v1.png")],
                capture_output=True, text=True,
            )
            two_views = check.returncode == 0 and (tmp_dir / "v1.png").exists()

            dst = out_dir / "mvhevc.mov"
            dst.write_bytes(local.read_bytes())
            jlog.info(f"🏁 x265 spatial .mov: {local.stat().st_size / 1e6:.1f} MB, "
                      f"boxes_ok={boxes_ok}, two_views={two_views} → {public_url(dst)}")

    return {
        "mvhevc": public_url(dst),
        "encoder": "x265",
        "two_views_verified": two_views,
        "spatial_boxes_verified": boxes_ok,
    }
