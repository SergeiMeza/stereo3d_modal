"""depth_vis: browser-playable preview of the gray16 depth video —
ffmpeg command construction / scale decision only (no actual encoding).
"""

from app.stages.media import DEPTH_VIS_SHORT_SIDE, _depth_vis_cmd, _depth_vis_filter


def test_landscape_caps_the_short_side():
    assert _depth_vis_filter(1920, 1080) == "format=gray,scale=-2:720,format=yuv420p"


def test_portrait_caps_the_short_side():
    assert _depth_vis_filter(1080, 1920) == "format=gray,scale=720:-2,format=yuv420p"


def test_no_upscale_below_the_cap():
    # short side already ≤ 720: transcode only (gray16 → 8-bit yuv420p)
    assert _depth_vis_filter(1280, 720) == "format=gray,format=yuv420p"
    assert _depth_vis_filter(640, 360) == "format=gray,format=yuv420p"
    assert _depth_vis_filter(720, 720) == "format=gray,format=yuv420p"


def test_square_above_cap_scales():
    assert _depth_vis_filter(1442, 1442) == "format=gray,scale=-2:720,format=yuv420p"


def test_cap_default_matches_constant():
    assert DEPTH_VIS_SHORT_SIDE == 720


def test_cmd_is_a_single_cpu_h264_pass():
    cmd = _depth_vis_cmd("/cache/depth.mp4", "/tmp/depth_vis.mp4",
                         "format=gray,scale=-2:720,format=yuv420p")
    assert cmd[0] == "ffmpeg"
    # exactly one input (a single transcode), no audio, faststart preview
    assert cmd.count("-i") == 1
    assert cmd[cmd.index("-i") + 1] == "/cache/depth.mp4"
    assert cmd[-1] == "/tmp/depth_vis.mp4"
    assert "-an" in cmd
    assert cmd[cmd.index("-vf") + 1] == "format=gray,scale=-2:720,format=yuv420p"
    assert cmd[cmd.index("-c:v") + 1] == "libx264"
    assert cmd[cmd.index("-preset") + 1] == "veryfast"
    assert cmd[cmd.index("-crf") + 1] == "20"
    assert cmd[cmd.index("-pix_fmt") + 1] == "yuv420p"
    assert cmd[cmd.index("-movflags") + 1] == "+faststart"
