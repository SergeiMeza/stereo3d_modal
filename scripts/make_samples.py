"""Regenerate the local sample clips from the two source videos.

The sample set under ``samples/videos/`` is derived from two 4K source
videos with deterministic ffmpeg cuts. Small clips (<100 MB) are
committed to the repo directly; the two 4K 60s clips exceed GitHub's
100 MB push limit and are .gitignored — regenerate them here.

Sources (NOT in the repo — local only):
  SRC_DANCE     /Users/meza/V5bVtAej1hs.mp4   (24000/1001 fps, 3840x2160, ~139 s)
  SRC_LETTERBOX /Users/meza/K9_VFxzCuQ0.mp4   (24000/1001 fps, 3840x2160, ~221 s;
                                                hard black bars → crop 3840:1664:0:248)

Clip offsets were chosen so the 10s and 60s clips share the same start:
  dance clips     start at source t=10 s
  letterbox clips start at source t=30 s

Usage:
    python scripts/make_samples.py            # regenerate the 60s clips (default)
    python scripts/make_samples.py --all      # regenerate the full set

After regenerating, push to GCS with:  modal run scripts/upload_samples.py
"""

import argparse
import subprocess
from pathlib import Path

SRC_DANCE = Path("/Users/meza/V5bVtAej1hs.mp4")
SRC_LETTERBOX = Path("/Users/meza/K9_VFxzCuQ0.mp4")
OUT = Path(__file__).resolve().parent.parent / "samples" / "videos"

# (name, source, start_s, dur_s, scale_height_or_None, with_audio)
# scale=None keeps native 2160p. Audio (AAC 192k) is muxed for the
# clips used as end-to-end inputs (A/V-sync testing).
SAMPLES_60S = [
    ("clip_60s_scenes_2160p.mp4", SRC_DANCE, 10, 60, None, True),
    ("clip_60s_scenes_1080p.mp4", SRC_DANCE, 10, 60, 1080, True),
    ("letterbox_60s_2160p.mp4", SRC_LETTERBOX, 30, 60, None, True),
    ("letterbox_60s_1080p.mp4", SRC_LETTERBOX, 30, 60, 1080, True),
]

# The shorter clips (committed to the repo) for completeness / full --all.
SAMPLES_SHORT = [
    ("clip_1s_2160p.mp4", SRC_DANCE, 10, 1, None, False),
    ("clip_1s_1080p.mp4", SRC_DANCE, 10, 1, 1080, False),
    ("clip_1s_720p.mp4", SRC_DANCE, 10, 1, 720, False),
    ("clip_1s_480p.mp4", SRC_DANCE, 10, 1, 480, False),
    ("clip_10s_scenes_2160p.mp4", SRC_DANCE, 10, 10, None, False),
    ("clip_10s_scenes_1080p.mp4", SRC_DANCE, 10, 10, 1080, False),
    ("clip_10s_scenes_720p.mp4", SRC_DANCE, 10, 10, 720, False),
    ("clip_10s_scenes_480p.mp4", SRC_DANCE, 10, 10, 480, False),
    ("letterbox_1s_2160p.mp4", SRC_LETTERBOX, 30, 1, None, False),
    ("letterbox_1s_1080p.mp4", SRC_LETTERBOX, 30, 1, 1080, False),
    ("letterbox_10s_2160p.mp4", SRC_LETTERBOX, 30, 10, None, False),
    ("letterbox_10s_1080p.mp4", SRC_LETTERBOX, 30, 10, 1080, False),
]


def cut(name, src, start, dur, scale_h, with_audio):
    if not src.exists():
        raise SystemExit(f"source missing: {src} (sources are local-only)")
    out = OUT / name
    vf = [] if scale_h is None else [f"scale=-2:{scale_h}"]
    cmd = ["ffmpeg", "-y", "-v", "error", "-ss", str(start), "-i", str(src), "-t", str(dur)]
    if vf:
        cmd += ["-vf", ",".join(vf)]
    cmd += ["-c:v", "libx264", "-crf", "16", "-preset", "slow", "-pix_fmt", "yuv420p"]
    cmd += ["-c:a", "aac", "-b:a", "192k"] if with_audio else ["-an"]
    cmd.append(str(out))
    subprocess.run(cmd, check=True)
    print(f"  ✓ {name} ({out.stat().st_size / 1e6:.1f} MB)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="regenerate every clip, not just the 60s ones")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)
    todo = SAMPLES_60S + (SAMPLES_SHORT if args.all else [])
    print(f"regenerating {len(todo)} clip(s) → {OUT}")
    for spec in todo:
        cut(*spec)
    print("done. push to GCS with: modal run scripts/upload_samples.py")


if __name__ == "__main__":
    main()
