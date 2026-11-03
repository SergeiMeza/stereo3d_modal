"""output_bitrate_bps: encoder rate-control arguments (no actual encoding)
and the submit-time validation."""

import pytest

from app.stages.media import _format_cmd, _h264_rate_args, bitrate_vbv
from app.stages.mvhevc import _nvenc_rate_args, _x265_rate_args


def _arg(cmd: list[str], flag: str) -> str:
    return cmd[cmd.index(flag) + 1]


def test_vbv_is_one_and_a_half_and_two_times_the_target():
    assert bitrate_vbv(20_000_000) == (20_000_000, 30_000_000, 40_000_000)


def test_h264_default_keeps_crf_17():
    assert _h264_rate_args(None) == ["-crf", "17"]


def test_h264_bitrate_mode_in_bits_per_second():
    assert _h264_rate_args(20_000_000) == [
        "-b:v", "20000000", "-maxrate", "30000000", "-bufsize", "40000000",
    ]


@pytest.mark.parametrize("vf", [None, "scale=iw/2:ih", "stereo3d=sbsl:abl",
                                "stereo3d=sbsl:ab2l", "stereo3d=sbsl:arcd"])
def test_every_sbs_family_format_uses_the_target(vf):
    cmd = _format_cmd("/cache/sbs.mp4", "/tmp/out.mp4", vf, bitrate_bps=20_000_000)
    assert "-crf" not in cmd
    assert _arg(cmd, "-c:v") == "libx264"
    assert _arg(cmd, "-b:v") == "20000000"
    assert _arg(cmd, "-maxrate") == "30000000"
    assert _arg(cmd, "-bufsize") == "40000000"
    assert cmd[-1] == "/tmp/out.mp4"
    assert ("-vf" in cmd) == bool(vf)


def test_format_cmd_default_is_unchanged():
    audio = ["-i", "/cache/src.mp4", "-map", "0:v", "-map", "1:a?", "-c:a", "aac", "-shortest"]
    cmd = _format_cmd("/cache/sbs.mp4", "/tmp/half_sbs.mp4", "scale=iw/2:ih", audio)
    assert cmd == [
        "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "/cache/sbs.mp4",
        *audio, "-vf", "scale=iw/2:ih",
        "-c:v", "libx264", "-preset", "fast", "-crf", "17",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-y", "/tmp/half_sbs.mp4",
    ]


def test_x265_default_is_crf():
    assert _x265_rate_args(23) == ["--crf", "23"]
    assert _x265_rate_args(18, None) == ["--crf", "18"]


def test_x265_bitrate_split_per_view_in_kbits_and_wins_over_crf():
    # x265 multiview rate-controls each view on its own: a 20 Mbit/s TOTAL
    # is 10 Mbit/s per view, with the VBV caps split the same way
    args = _x265_rate_args(18, 20_000_000)
    assert args == ["--bitrate", "10000", "--vbv-maxrate", "15000", "--vbv-bufsize", "20000"]
    assert "--crf" not in args


def test_nvenc_default_is_constant_quality():
    assert _nvenc_rate_args(28) == ["-rc", "vbr", "-cq", "28"]


def test_nvenc_bitrate_mode():
    args = _nvenc_rate_args(28, 20_000_000)
    assert args == ["-rc", "vbr", "-b:v", "20000000", "-maxrate", "30000000",
                    "-bufsize", "40000000"]
    assert "-cq" not in args


# ------------------------------------------------------- submit validation

@pytest.mark.parametrize("value", [1_999_999, 300_000_001, 0, -5, 20e6, "20000000", True, [20_000_000]])
def test_submit_rejects_out_of_range_or_non_int(value):
    from fastapi import HTTPException

    from app.api.main import submit_video

    with pytest.raises(HTTPException) as exc:
        submit_video({"input_path": "inputs/x.mp4", "output_bitrate_bps": value})
    assert exc.value.status_code == 400
    assert "output_bitrate_bps" in exc.value.detail
