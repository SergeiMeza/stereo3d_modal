"""Small ffmpeg/ffprobe helpers shared across stages.

Pure subprocess — no torch, no vendored model code — so any container
with ffmpeg can import this.
"""

import subprocess
from pathlib import Path


def count_frames(path: Path) -> int:
    """Exact frame count by counting packets (fast, no decode)."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-count_packets", "-show_entries", "stream=nb_read_packets",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True,
    ).stdout.strip()
    return int(out) if out else -1


def concat_segments(segments: list[Path], output: Path) -> None:
    """Lossless stream-copy concat of mp4 segments in order."""
    if len(segments) == 1:
        output.write_bytes(segments[0].read_bytes())
        return
    list_file = Path(f"{output}.concat.txt")
    list_file.write_text("".join(f"file '{s}'\n" for s in segments))
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "concat",
         "-safe", "0", "-i", str(list_file), "-c", "copy", "-y", str(output)],
        check=True,
    )
    list_file.unlink()
