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

# Closed-GOP segment length for visionOS spatial playback (seconds).
# Both the single-file .mov keyint and the HLS segment length derive
# from this so segment boundaries always land on IDR frames.
GOP_SECONDS = 2


def _x265_multiview_cmd(
    cfg_path: Path,
    raw_out: Path,
    eye_w: int,
    eye_h: int,
    fps_rational: str,
    num_frames: int,
    keyint: int,
    crf: int,
    preset: str,
) -> list[str]:
    """THE single x265 multiview invocation, shared by the single-file
    .mov path (encode_mvhevc_x265) and the segmented HLS path
    (encode_mvhevc_hls per-segment encode). The flags here were
    hard-won — see encode_mvhevc_x265's notes:

      * --num-views 2 / --format 0 / two --input yuv (in the cfg file):
        the only Linux MV-HEVC signaling Apple's spatial classifier
        accepts; format 1 (single SBS input) desyncs the two views.
      * closed 2s GOPs (--keyint == --min-keyint, --no-open-gop) +
        --no-scenecut: periodic IDRs only, so the stream can be cut at
        segment boundaries; adaptive scene-cut I-frames are asymmetric
        across the two layers and corrupt layer-1 prediction.
      * --repeat-headers: every IDR (hence every HLS segment) carries
        its own VPS/SPS/PPS — required so each .m4s is independently
        decodable AND retains the multiview VPS Apple keys on.

    The HLS path decodes each segment's yuv pre-trimmed and passes the
    segment length as ``num_frames`` + ``keyint``, so x265 starts at
    frame 0 of the per-segment yuv and emits one closed GOP per segment.
    """
    return [
        "x265", "--multiview-config", str(cfg_path),
        "--input-res", f"{eye_w}x{eye_h}", "--input-csp", "i420",
        "--input-depth", "8", "--fps", fps_rational,
        "--frames", str(num_frames), "--profile", "main",
        "--colorprim", "bt709", "--transfer", "bt709",
        "--colormatrix", "bt709", "--range", "limited",
        "--preset", preset, "--crf", str(crf),
        "--keyint", str(keyint), "--min-keyint", str(keyint),
        "--no-open-gop", "--repeat-headers",
        "--no-scenecut",
        "--output", str(raw_out),
    ]


def _decode_eyes_yuv(
    sbs: Path,
    left_yuv: Path,
    right_yuv: Path,
    *,
    frame_range: tuple[int, int] | None = None,
) -> None:
    """Decode an SBS master (or a frame sub-range of it) into two per-eye
    yuv420p raw streams — the input format x265 multiview expects. Used
    whole-clip by encode_mvhevc_x265 and per-segment by the HLS path.

    ``frame_range`` (first, last) trims to a half-open [first, last) frame
    window by source frame index — applied INSIDE each per-eye filter
    chain so both eyes stay frame-aligned."""
    if frame_range is not None:
        first, last = frame_range
        trim = f"select='between(n\\,{first}\\,{last - 1})',setpts=N/FRAME_RATE/TB,"
    else:
        trim = ""
    subprocess.run(
        ["ffmpeg8", "-y", "-loglevel", "error", "-i", str(sbs), "-an",
         "-filter_complex",
         f"[0:v]crop=iw/2:ih:0:0,{trim}null[l];"
         f"[0:v]crop=iw/2:ih:iw/2:0,{trim}null[r]",
         "-map", "[l]", "-pix_fmt", "yuv420p", "-f", "rawvideo", str(left_yuv),
         "-map", "[r]", "-pix_fmt", "yuv420p", "-f", "rawvideo", str(right_yuv)],
        check=True,
    )


@app.function(
    image=nvenc_image,
    gpu=MVHEVC_GPU,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    cpu=4,
    memory=(2 * 1024, 16 * 1024),
    # NVENC is fast (GPU-accelerated) but kept generous for long clips
    timeout=3 * 3600,
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
    # x265 multiview is single-encode CPU work that scales with length
    # AND resolution: ~36x realtime at 4K (≈3h for a 5-min clip), ~18x
    # at qhd. It can't fan out (one contiguous encode), so the timeout
    # must cover the worst case — 6h ceiling for long 4K jobs.
    timeout=6 * 3600,
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
    keyint = max(1, round(probe["fps"] * GOP_SECONDS))  # closed 2s GOPs for visionOS
    out_dir = job_output_dir(job_id)
    jlog.info(f"🎯 x265 MV-HEVC: {eye_w}x{eye_h}/eye, {num_frames}f, crf={crf}, preset={preset}")

    with jobs.stage_timer(job_id, "encode_mvhevc_x265", crf=crf, preset=preset):
        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)
            left_yuv = tmp_dir / "left.yuv"
            right_yuv = tmp_dir / "right.yuv"
            raw = tmp_dir / "video.hevc"

            # 1) decode the SBS master into two per-eye raw streams.
            #    format 0 (two inputs) — the single-SBS-input format 1
            #    produced temporally desynced views (left/right showed
            #    different scenes); two explicit inputs is the
            #    community-validated path.
            _decode_eyes_yuv(sbs, left_yuv, right_yuv)

            # 2) x265 multiview: first --input = layer 0 = hero (left) eye.
            #    Shared invocation (_x265_multiview_cmd) — same command the
            #    HLS path runs per segment.
            cfg = tmp_dir / "mv.cfg"
            cfg.write_text(
                f'--num-views 2\n--format 0\n--input "{left_yuv}"\n--input "{right_yuv}"\n'
            )
            enc = subprocess.run(
                _x265_multiview_cmd(
                    cfg, raw, eye_w, eye_h, fps_rational, num_frames,
                    keyint, crf, preset,
                ),
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


# ======================================================================
# MV-HEVC over HLS (.m3u8 + fMP4 segments) — segmented spatial video
# ======================================================================
#
# WHY a second format: encode_mvhevc_x265 produces ONE Apple-spatial
# .mov via a single contiguous CPU x265 encode — it CANNOT fan out (one
# bitstream, one vexu/MP4Box mux) and is the right shape for "share to
# Photos". HLS is the segmented form: a .m3u8 playlist over closed-GOP
# fMP4 segments, each independently encodable. That gives (a) PARALLEL
# encoding for long/4K clips and (b) a streaming deliverable that
# visionOS/Safari play.
#
# -------- Apple's HLS spatial-video requirements (researched) ---------
# Sources (confirmed June 2026):
#   * Apple Developer Forums thread 743503 ("Stereo video HLS") — a
#     complete working master+media playlist pair from Apple's own
#     mediafilesegmenter/variantplaylistcreator output.
#     https://developer.apple.com/forums/thread/743503
#   * Apple Developer Forums thread 748094 ("How to encode MV-HEVC
#     spatial videos using HLS tool correctly?") — REQ-VIDEO-LAYOUT,
#     EXT-X-VERSION:12, HLS tools 1.22+.
#     https://developer.apple.com/forums/thread/748094
#   * "What's new in HTTP Live Streaming" (WWDC 2025), and "Deliver
#     video content for spatial experiences" (WWDC23, session 10071).
#     https://developer.apple.com/streaming/Whats-new-HLS.pdf
#     https://developer.apple.com/videos/play/wwdc2023/10071/
#
# Confirmed facts:
#   1. STEREO SIGNAL — the MASTER (multivariant) playlist's
#      EXT-X-STREAM-INF carries  REQ-VIDEO-LAYOUT="CH-STEREO"  (and the
#      same on EXT-X-I-FRAME-STREAM-INF when present). For flat (non-
#      projected) spatial video the value is plain "CH-STEREO"; the
#      richer form "CH-STEREO/PROJ-EQUI|PROJ-PRIM|PROJ-FISH" adds a
#      projection specifier for immersive/180/360 content — we are flat
#      rectilinear, so "CH-STEREO" is correct.  EXT-X-VERSION:12 in the
#      master is what signals tool support; an EXT-X-VERSION:7 master is
#      the symptom of an OLD tool that silently dropped the stereo tag.
#   2. SEGMENT FORMAT — fMP4/CMAF only (HEVC is not allowed in MPEG-TS
#      in modern HLS). Media playlist: EXT-X-MAP:URI="init.mp4" init
#      segment + segNNN.m4s media segments, EXT-X-VERSION:7,
#      EXT-X-INDEPENDENT-SEGMENTS, EXT-X-PLAYLIST-TYPE:VOD.
#   3. PER-SEGMENT HEADERS — each segment is just the SAME two-layer
#      MV-HEVC stream cut at an IDR. Closed 2s GOPs + --repeat-headers
#      (already in _x265_multiview_cmd) put a fresh multiview VPS/SPS/PPS
#      at the head of every segment, which is exactly what Apple's
#      classifier and the fMP4 init segment need. There is no separate
#      per-segment vexu injection — the stereo signal lives in the VPS
#      (inside the segments) + REQ-VIDEO-LAYOUT (in the playlist).
#   4. AUDIO — simplest correct option: mux the AAC track into the same
#      fMP4 segments (muxed A/V rendition). The forum's working master
#      lists CODECS="mp4a.40.2,hvc1..." on a single EXT-X-STREAM-INF,
#      confirming muxed audio is accepted. (A separate EXT-X-MEDIA audio
#      rendition is also valid but unnecessary here.)
#
# NEEDS DEVICE VALIDATION: the segment/playlist shape below is assembled
# with ffmpeg's hls muxer (Apple's mediafilesegmenter is macOS-only and
# NOT in nvenc_image). It MUST be played on visionOS/Safari to confirm
# (a) it plays and (b) it is recognized as STEREO. See docs/MVHEVC_HLS.md.

HLS_REQ_VIDEO_LAYOUT = "CH-STEREO"  # flat stereoscopic MV-HEVC (no projection)


def plan_hls_segments(num_frames: int, fps: float, segment_seconds: int = GOP_SECONDS):
    """Tile [0, num_frames) into closed-GOP-aligned segment frame ranges.

    Each segment is ``segment_seconds * fps`` frames (rounded the SAME
    way as the x265 keyint, so segment boundaries coincide with IDRs).
    The last segment absorbs the remainder. Returns a list of
    (first, last) half-open ranges that tile [0, num_frames) exactly.
    """
    if num_frames <= 0:
        return []
    seg = max(1, round(fps * segment_seconds))
    return [(s, min(s + seg, num_frames)) for s in range(0, num_frames, seg)]


def build_hls_master(
    *,
    media_playlist: str,
    codecs: str,
    width: int,
    height: int,
    fps: float,
    bandwidth: int,
    has_audio: bool,
) -> str:
    """Build the multivariant (master) playlist that carries the stereo
    signal. ``REQ-VIDEO-LAYOUT="CH-STEREO"`` on EXT-X-STREAM-INF is the
    tag visionOS/Safari key on to treat the stream as stereoscopic
    MV-HEVC (Apple Developer Forums thread 743503)."""
    lines = [
        "#EXTM3U",
        "#EXT-X-VERSION:12",  # <12 = old tool that drops the stereo tag
        "#EXT-X-INDEPENDENT-SEGMENTS",
        (
            f"#EXT-X-STREAM-INF:BANDWIDTH={bandwidth},"
            f"VIDEO-RANGE=SDR,"
            f'CODECS="{codecs}",'
            f"RESOLUTION={width}x{height},"
            f"FRAME-RATE={fps:.3f},"
            f"CLOSED-CAPTIONS=NONE,"
            f'REQ-VIDEO-LAYOUT="{HLS_REQ_VIDEO_LAYOUT}"'
        ),
        media_playlist,
        "",
    ]
    return "\n".join(lines)


@app.function(
    image=nvenc_image,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    cpu=8,
    memory=(4 * 1024, 16 * 1024),
    # a single 2s segment encodes in seconds even at 4K — keep the
    # per-segment worker short so a stuck segment fails fast (the
    # orchestrator gathers and surfaces it)
    timeout=20 * 60,
    retries=modal.Retries(max_retries=2, initial_delay=5.0, backoff_coefficient=2.0),
)
@fail_fast
def _encode_hls_segment(
    job_id: str,
    sbs_path: str,
    seg_index: int,
    frame_range: tuple,
    crf: int,
    preset: str,
) -> dict:
    """Encode ONE HLS segment's frame range into a raw .hevc two-view
    MV-HEVC stream (written to the job cache volume). Reuses the SAME
    x265 multiview invocation as the single-file path
    (_x265_multiview_cmd), so the segments are byte-for-byte the same
    encoder configuration — just cut at IDR boundaries.

    The whole segment is ONE closed GOP (keyint == segment length), so
    it starts with an IDR carrying a fresh multiview VPS/SPS/PPS."""
    from app.common.debug import job_logger
    from app.common.storage import job_cache_dir
    from app.stages.media import probe_video

    jlog = job_logger(job_id)
    safe_reload(cache_volume)
    sbs = Path(sbs_path)
    if not sbs.exists():
        raise FileNotFoundError(sbs)

    probe = probe_video(sbs)
    eye_w, eye_h = probe["width"] // 2, probe["height"]
    fps_rational = probe["fps_rational"]
    first, last = int(frame_range[0]), int(frame_range[1])
    seg_frames = last - first
    # keyint == segment length → the whole segment is one closed GOP
    # (single leading IDR), which is exactly what HLS wants per segment.
    keyint = max(1, seg_frames)

    seg_dir = job_cache_dir(job_id) / "hls_segs"
    seg_dir.mkdir(parents=True, exist_ok=True)
    raw = seg_dir / f"seg{seg_index:05d}.hevc"

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        left_yuv = tmp_dir / "left.yuv"
        right_yuv = tmp_dir / "right.yuv"

        _decode_eyes_yuv(sbs, left_yuv, right_yuv, frame_range=(first, last))

        cfg = tmp_dir / "mv.cfg"
        cfg.write_text(
            f'--num-views 2\n--format 0\n--input "{left_yuv}"\n--input "{right_yuv}"\n'
        )
        enc = subprocess.run(
            _x265_multiview_cmd(
                cfg, raw, eye_w, eye_h, fps_rational, seg_frames,
                keyint, crf, preset,
            ),
            capture_output=True, text=True,
        )
        if enc.returncode != 0 or not raw.exists():
            raise RuntimeError(
                f"segment {seg_index} x265 encode failed: {enc.stderr[-1500:]}"
            )

    cache_volume.commit()
    jlog.info(
        f"✔ HLS seg {seg_index} [{first},{last}) "
        f"{raw.stat().st_size / 1e6:.2f} MB"
    )
    return {
        "seg_index": seg_index,
        "hevc_path": str(raw),
        "first": first,
        "last": last,
        "frames": seg_frames,
    }


@app.function(
    image=nvenc_image,
    volumes=PIPELINE_VOLUMES,
    secrets=[slack_secret],
    cpu=8,
    memory=(4 * 1024, 16 * 1024),
    # packaging is mux + remux, not encode; bounded by total length /
    # IO. Generous ceiling for long 4K clips.
    timeout=2 * 3600,
    retries=modal.Retries(max_retries=1, initial_delay=10.0),
)
@fail_fast
def encode_mvhevc_hls(
    job_id: str,
    sbs_path: str,
    crf: int = 23,
    preset: str = "medium",
    original_path: str | None = None,
    spatial: dict | None = None,
    max_workers: int = 4,
    segment_seconds: int = GOP_SECONDS,
) -> dict:
    """Apple-spatial MV-HEVC delivered as HLS (.m3u8 + fMP4 segments).

    PARALLEL: the SBS master is split into ``segment_seconds``-long
    closed-GOP frame ranges; each range is encoded by a fanned-out
    _encode_hls_segment Modal function (bounded by ``max_workers``),
    reusing the SAME proven x265 multiview command as the single-file
    .mov path. The per-segment .hevc streams are then concatenated into
    one MV-HEVC elementary stream and packaged by ffmpeg's hls muxer
    into fMP4 (init.mp4 + segNNN.m4s) + a media playlist, with a master
    playlist carrying REQ-VIDEO-LAYOUT="CH-STEREO".

    Returns ``{"mvhevc_hls": <master .m3u8 public URL>}``. The whole HLS
    directory is published under outputs/<job_id>/hls/.

    NOTE: complements (does not replace) encode_mvhevc_x265 — the .mov
    is the single-file "share to Photos" form; this is the streaming
    form. See docs/MVHEVC_HLS.md (incl. NEEDS DEVICE VALIDATION).
    """
    from app.common.debug import job_logger
    from app.common.errors import check_worker_result
    from app.stages.media import probe_video

    jlog = job_logger(job_id)
    safe_reload(cache_volume)
    sbs = Path(sbs_path)
    if not sbs.exists():
        raise FileNotFoundError(sbs)

    probe = probe_video(sbs)
    fps = probe["fps"]
    fps_rational = probe["fps_rational"]
    eye_w, eye_h = probe["width"] // 2, probe["height"]
    num_frames = probe["num_frames"]
    ranges = plan_hls_segments(num_frames, fps, segment_seconds)
    out_dir = job_output_dir(job_id)
    jlog.info(
        f"🎯 MV-HEVC HLS: {eye_w}x{eye_h}/eye, {num_frames}f @ {fps:.3f}fps "
        f"→ {len(ranges)} × {segment_seconds}s segment(s), crf={crf}, "
        f"preset={preset}, ≤{max_workers} concurrent"
    )

    with jobs.stage_timer(job_id, "encode_mvhevc_hls", crf=crf, preset=preset):
        # 1) FAN OUT per-segment encodes (mirror _parallel_stereo: spawn
        #    bounded by max_containers, then gather defensively).
        capped = _encode_hls_segment.with_options(max_containers=max_workers)
        handles = [
            capped.spawn(job_id, sbs_path, i, r, crf, preset)
            for i, r in enumerate(ranges)
        ]
        seg_results = []
        for h in handles:
            r = h.get()
            check_worker_result(r, "encode_mvhevc_hls[segment]")
            seg_results.append(r)
        seg_results.sort(key=lambda s: s["seg_index"])
        safe_reload(cache_volume)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_dir = Path(tmp)

            # 2) concat the per-segment elementary streams into one
            #    contiguous MV-HEVC stream. Closed GOPs + --repeat-headers
            #    make raw .hevc concatenation valid (every segment starts
            #    with its own VPS/SPS/PPS at an IDR).
            joined = tmp_dir / "video.hevc"
            with joined.open("wb") as out:
                for s in seg_results:
                    p = Path(s["hevc_path"])
                    if not p.exists():
                        raise RuntimeError(f"missing segment stream: {p}")
                    out.write(p.read_bytes())

            # 3) optional AAC audio from the pristine original (muxed
            #    into the fMP4 segments — the simpler valid HLS option)
            audio_args: list[str] = []
            original = Path(original_path) if original_path else None
            if original and original.exists():
                audio = tmp_dir / "audio.m4a"
                ok = subprocess.run(
                    ["ffmpeg8", "-y", "-loglevel", "error", "-i", str(original),
                     "-vn", "-c:a", "aac", str(audio)],
                    capture_output=True, text=True,
                ).returncode == 0 and audio.exists()
                if ok:
                    audio_args = ["-i", str(audio)]

            # 4) PACKAGE with ffmpeg's hls muxer → fMP4 (CMAF):
            #    init.mp4 (EXT-X-MAP) + segNNN.m4s + media.m3u8.
            #    -hls_segment_type fmp4 is REQUIRED (HEVC has no TS path).
            #    The closed 2s GOPs already align segments to IDRs.
            pkg = tmp_dir / "pkg"
            pkg.mkdir()
            media_m3u8 = pkg / "media.m3u8"
            map_inputs = ["-i", str(joined)] + audio_args
            map_args = ["-map", "0:v"] + (["-map", "1:a"] if audio_args else [])
            hls = subprocess.run(
                ["ffmpeg8", "-y", "-loglevel", "error",
                 "-r", fps_rational, *map_inputs,
                 *map_args,
                 "-c", "copy",
                 "-tag:v", "hvc1",
                 "-f", "hls",
                 "-hls_time", str(segment_seconds),
                 "-hls_playlist_type", "vod",
                 "-hls_segment_type", "fmp4",
                 "-hls_fmp4_init_filename", "init.mp4",
                 "-hls_segment_filename", str(pkg / "seg%05d.m4s"),
                 "-hls_list_size", "0",
                 str(media_m3u8)],
                capture_output=True, text=True,
            )
            if hls.returncode != 0 or not media_m3u8.exists():
                raise RuntimeError(f"HLS packaging failed: {hls.stderr[-2000:]}")

            # 5) probe the produced fMP4 for the exact CODECS string and
            #    a rough peak bandwidth for the master playlist.
            codecs = _hls_codecs_string(pkg / "init.mp4", bool(audio_args))
            total_bytes = sum(
                p.stat().st_size for p in pkg.glob("*.m4s")
            ) + (pkg / "init.mp4").stat().st_size
            duration = max(num_frames / fps, 1e-3)
            bandwidth = int(total_bytes * 8 / duration)

            # 6) write the MASTER playlist carrying the stereo signal.
            master = pkg / "master.m3u8"
            master.write_text(build_hls_master(
                media_playlist="media.m3u8",
                codecs=codecs,
                width=probe["width"] // 2,  # per-eye display resolution
                height=probe["height"],
                fps=fps,
                bandwidth=bandwidth,
                has_audio=bool(audio_args),
            ))

            # 7) PUBLISH the whole HLS directory under outputs/<job>/hls/
            hls_dir = out_dir / "hls"
            hls_dir.mkdir(parents=True, exist_ok=True)
            published = 0
            for f in sorted(pkg.iterdir()):
                if f.is_file():
                    (hls_dir / f.name).write_bytes(f.read_bytes())
                    published += 1

        # best-effort cleanup of per-segment intermediates on the cache
        try:
            seg_dir = Path(seg_results[0]["hevc_path"]).parent
            for f in seg_dir.glob("*.hevc"):
                f.unlink(missing_ok=True)
            cache_volume.commit()
        except Exception as exc:  # noqa: BLE001 — cleanup is non-fatal
            jlog.warning(f"HLS segment cleanup skipped: {exc}")

        master_url = public_url(hls_dir / "master.m3u8")
        jlog.info(
            f"🏁 MV-HEVC HLS published: {len(ranges)} segment(s), "
            f"{published} file(s), {total_bytes / 1e6:.1f} MB → {master_url}"
        )

    return {
        "mvhevc_hls": master_url,
        "encoder": "x265",
        "segments": len(ranges),
        "req_video_layout": HLS_REQ_VIDEO_LAYOUT,
        "audio": bool(audio_args),
    }


def _hls_codecs_string(init_mp4: Path, has_audio: bool) -> str:
    """Read the real HEVC codec parameter string from the fMP4 init
    segment so the master playlist's CODECS attribute matches the
    stream (e.g. ``hvc1.1.6.L153.B0``). Falls back to a reasonable
    Main-profile default if the probe can't resolve it."""
    probe = subprocess.run(
        ["ffprobe8", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=codec_tag_string,profile,level",
         "-of", "json", str(init_mp4)],
        capture_output=True, text=True,
    )
    video = "hvc1.1.6.L153.B0"  # Main@L5.1 fallback
    try:
        st = json.loads(probe.stdout)["streams"][0]
        tag = st.get("codec_tag_string") or "hvc1"
        lvl = st.get("level")
        if isinstance(lvl, int) and lvl > 0:
            video = f"{tag}.1.6.L{lvl}.B0"
    except Exception:  # noqa: BLE001 — fall back to the default string
        pass
    return f"mp4a.40.2,{video}" if has_audio else video
