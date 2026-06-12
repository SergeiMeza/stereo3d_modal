"""CPU media stage: probing, black-bar removal, scene detection,
output encoding/muxing. No GPU — runs on the cheap media_image.
"""

import json
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path

import modal

from app.common import jobs
from app.common.debug import get_logger
from app.common.storage import (
    slack_secret,
    PIPELINE_VOLUMES,
    bucket_path,
    cache_volume,
    job_cache_dir,
    job_output_dir,
    public_url,
)
from app.images import media_image
from app.modal_app import app

logger = get_logger(__name__)


def probe_video(path: Path) -> dict:
    """ffprobe summary of the first video stream."""
    raw = subprocess.run(
        [
            "ffprobe", "-v", "error", "-select_streams", "v:0",
            "-show_entries",
            "stream=width,height,r_frame_rate,avg_frame_rate,duration,nb_frames,codec_name,pix_fmt",
            "-show_entries", "format=duration",
            "-of", "json", str(path),
        ],
        capture_output=True, text=True, check=True,
    ).stdout
    data = json.loads(raw)
    stream = data["streams"][0]
    fps = float(Fraction(stream["avg_frame_rate"]))  # no eval() — parse as a fraction
    duration = float(stream.get("duration") or data.get("format", {}).get("duration") or 0)
    return {
        "width": stream["width"],
        "height": stream["height"],
        "fps": fps,
        # exact rational ("24000/1001") — floats drift against audio
        # over long durations, so writers get this string instead
        "fps_rational": stream["avg_frame_rate"],
        "duration": duration,
        "num_frames": int(stream.get("nb_frames") or round(duration * fps)),
        "codec": stream.get("codec_name"),
        "pix_fmt": stream.get("pix_fmt"),
    }


def has_audio(path: Path) -> bool:
    raw = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
         "stream=index", "-of", "json", str(path)],
        capture_output=True, text=True, check=True,
    ).stdout
    return bool(json.loads(raw).get("streams"))


def detect_crop(path: Path, probe: dict, samples: int = 3, window: float = 2.0) -> str | None:
    """Detect black bars with ffmpeg cropdetect sampled at several
    points in the video. Returns "w:h:x:y" or None if no crop needed.

    The most conservative (largest) stable crop across samples wins, so
    a momentary dark scene can't trigger an over-crop.
    """
    duration = max(probe["duration"], window)
    crops: dict[str, int] = {}
    for k in range(samples):
        ts = duration * (k + 0.5) / samples
        out = subprocess.run(
            ["ffmpeg", "-hide_banner", "-ss", f"{ts:.2f}", "-i", str(path),
             # no mode=black: needs ffmpeg ≥6.1, debian_slim has 5.x; black is the default
             "-t", f"{window}", "-vf", "cropdetect=limit=24:round=2",
             "-an", "-f", "null", "-"],
            capture_output=True, text=True,
        ).stderr
        for line in out.splitlines():
            if "crop=" in line:
                crop = line.rsplit("crop=", 1)[1].strip()
                crops[crop] = crops.get(crop, 0) + 1
    if not crops:
        return None

    def crop_area(c: str) -> int:
        w, h, _, _ = (int(v) for v in c.split(":"))
        return w * h

    # keep the largest area among crops seen in at least two frames
    stable = [c for c, n in crops.items() if n >= 2] or list(crops)
    best = max(stable, key=crop_area)
    w, h, x, y = (int(v) for v in best.split(":"))
    if w >= probe["width"] and h >= probe["height"]:
        return None
    return best


@app.function(
    image=media_image,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    retries=modal.Retries(max_retries=3, initial_delay=5.0, backoff_coefficient=2.0),
    cpu=4,
    memory=(2 * 1024, 16 * 1024),
    timeout=1800,
)
def preprocess_video(job_id: str, input_path: str, remove_black_bars: bool = True) -> dict:
    """Stage 1: bring the input into the cache volume, removing black
    bars if present (they ruin depth + waste disparity budget).
    Returns the working path + probe metadata."""
    src = bucket_path(input_path)
    if not src.exists():
        raise FileNotFoundError(f"input video not found: {input_path}")

    probe = probe_video(src)
    work_dir = job_cache_dir(job_id)
    crop = detect_crop(src, probe) if remove_black_bars else None

    with jobs.stage_timer(job_id, "preprocess", crop=crop, **{k: probe[k] for k in ("width", "height", "num_frames")}):
        if crop:
            work_path = work_dir / "source_cropped.mp4"
            subprocess.run(
                ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(src),
                 "-vf", f"crop={crop}", "-an", "-c:v", "libx264", "-preset", "fast",
                 "-crf", "16", "-pix_fmt", "yuv420p", "-y", str(work_path)],
                check=True,
            )
            probe = probe_video(work_path)
        else:
            work_path = work_dir / ("source" + src.suffix)
            work_path.write_bytes(src.read_bytes())

    cache_volume.commit()
    # source_path: the pristine input — audio is muxed from here, since
    # the work file is video-only (crop re-encode drops audio with -an)
    return {"work_path": str(work_path), "source_path": str(src), "probe": probe, "crop": crop}


@app.function(
    image=media_image,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    retries=modal.Retries(max_retries=3, initial_delay=5.0, backoff_coefficient=2.0),
    cpu=2,
    memory=(2 * 1024, 16 * 1024),
    timeout=1800,
)
def detect_scenes(input_path: str) -> dict:
    """Standalone scene detection (the production video-depth worker
    detects scenes inline; this exists for testing/inspection)."""
    from scenedetect import AdaptiveDetector, SceneManager, open_video

    cache_volume.reload()
    path = bucket_path(input_path) if not Path(input_path).exists() else Path(input_path)
    video = open_video(str(path))
    manager = SceneManager()
    manager.add_detector(AdaptiveDetector())
    manager.detect_scenes(video=video)
    scenes = [
        {"start": start.get_frames(), "end": end.get_frames(),
         "start_sec": start.get_seconds(), "end_sec": end.get_seconds()}
        for start, end in manager.get_scene_list()
    ]
    return {"scenes": scenes, "count": len(scenes)}


@app.function(
    image=media_image,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    retries=modal.Retries(max_retries=3, initial_delay=5.0, backoff_coefficient=2.0),
    cpu=4,
    memory=(2 * 1024, 16 * 1024),
    timeout=3600,
)
def encode_outputs(
    job_id: str,
    sbs_path: str,
    original_path: str | None = None,
    formats: list[str] | None = None,
    include_audio: bool = True,
) -> dict:
    """Stage 3: derive deliverables from the full-width SBS master and
    publish them to the bucket.

    formats ⊆ {"sbs", "half_sbs", "tb", "half_tb", "anaglyph", "depth"}
    (the SBS master is always published; "depth" is handled by the
    caller since it lives in a separate file).
    """
    formats = formats or ["sbs", "half_sbs", "anaglyph"]
    cache_volume.reload()

    sbs = Path(sbs_path)
    if not sbs.exists():
        raise FileNotFoundError(sbs)

    out_dir = job_output_dir(job_id)
    outputs: dict[str, str] = {}

    audio_args: list[str] = []
    original = Path(original_path) if original_path else None
    if include_audio and original and original.exists() and has_audio(original):
        audio_args = ["-i", str(original), "-map", "0:v", "-map", "1:a?", "-c:a", "aac", "-shortest"]

    # filter recipes from the full-width SBS master
    recipes = {
        "sbs": None,  # plain copy/transcode
        "half_sbs": "scale=iw/2:ih",
        "tb": "stereo3d=sbsl:abl",
        "half_tb": "stereo3d=sbsl:ab2l",
        "anaglyph": "stereo3d=sbsl:arcd",
    }

    av_sync: dict[str, float | None] = {}
    with jobs.stage_timer(job_id, "encode_outputs", formats=formats):
        with tempfile.TemporaryDirectory() as tmp:
            for fmt in formats:
                if fmt not in recipes:
                    logger.warning(f"skipping unknown format {fmt!r}")
                    continue
                # encode locally: mp4 muxing seeks, which bucket mounts
                # don't support — publish with one sequential copy
                local = Path(tmp) / f"{fmt}.mp4"
                cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(sbs)]
                cmd += audio_args
                vf = recipes[fmt]
                if vf:
                    cmd += ["-vf", vf]
                cmd += ["-c:v", "libx264", "-preset", "fast", "-crf", "17",
                        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", str(local)]
                subprocess.run(cmd, check=True)
                dst = out_dir / f"{fmt}.mp4"
                dst.write_bytes(local.read_bytes())
                outputs[fmt] = public_url(dst)
                av_sync.setdefault(fmt, _av_sync_ms(local))

    return {"outputs": outputs, "av_sync_ms": av_sync}


def _av_sync_ms(path: Path) -> float | None:
    """Video-vs-audio duration delta in ms (None if no audio). Frame
    loss anywhere upstream surfaces here as a growing offset."""
    raw = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration",
         "-of", "json", str(path)],
        capture_output=True, text=True,
    ).stdout
    durations = {}
    for s in json.loads(raw).get("streams", []):
        if s.get("duration"):
            durations[s["codec_type"]] = float(s["duration"])
    if "audio" not in durations or "video" not in durations:
        return None
    delta_ms = (durations["video"] - durations["audio"]) * 1000
    if abs(delta_ms) > 25:  # more than ~half a frame at 24fps
        logger.warning(f"⚠️ A/V duration delta {delta_ms:.1f} ms in {path.name}")
    return round(delta_ms, 1)


@app.function(
    image=media_image,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    retries=modal.Retries(max_retries=3, initial_delay=5.0, backoff_coefficient=2.0),
    cpu=2,
    memory=(1024, 8 * 1024),
    timeout=600,
)
def publish_file(job_id: str, cache_file: str, name: str) -> str:
    """Copy a cache-volume artifact (e.g. the depth video) to the
    job's bucket output dir and return its public URL."""
    from app.common.debug import job_logger

    jlog = job_logger(job_id)
    cache_volume.reload()
    src = Path(cache_file)
    dst = job_output_dir(job_id) / name
    jlog.info(f"⬆️  publishing {src.name} → {dst} ({src.stat().st_size / 1e6:.1f} MB)")
    dst.write_bytes(src.read_bytes())
    url = public_url(dst)
    jlog.info(f"✔ published {name}: {url}")
    return url
