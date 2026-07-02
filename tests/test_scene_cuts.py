"""_user_scene_boundaries: source-frame scene cuts → work-file boundaries.

This mapping is the single server-side implementation of the frame doctrine
(web/DESIGN.md): cuts are integer source-frame indices; trim and fps
decimation must land them on exact work frames.
"""

import pytest

from app.pipelines.video import (
    _map_source_to_work,
    _user_scene_boundaries,
    _work_to_source_frame,
)


def _pre(num_frames, fps=24.0, trim=None, fps_decimation=None, source_fps=None):
    return {
        "probe": {"num_frames": num_frames, "fps": fps},
        "trim": trim,
        "fps_decimation": fps_decimation,
        "source_fps": source_fps or fps,
    }


def test_no_cuts_returns_none():
    assert _user_scene_boundaries({}, _pre(100)) is None
    assert _user_scene_boundaries({"scene_cuts": None}, _pre(100)) is None


def test_plain_cuts_no_trim_no_decimation():
    got = _user_scene_boundaries({"scene_cuts": [50, 120]}, _pre(200))
    assert got == [(0, 50), (50, 120), (120, 200)]


def test_empty_cuts_yields_single_scene():
    got = _user_scene_boundaries({"scene_cuts": []}, _pre(200))
    assert got == [(0, 200)]


def test_trim_shifts_and_drops_out_of_window():
    # source trim [100, 400) → work frames [0, 300)
    pre = _pre(300, trim=(100, 400))
    got = _user_scene_boundaries({"scene_cuts": [50, 100, 150, 400, 500]}, pre)
    # 50 and 100 are at/before the window start (no cut at frame 0);
    # 400/500 are at/after the window end
    assert got == [(0, 50), (50, 300)]


def test_exact_divisor_decimation_ceils_to_next_kept_frame():
    # 60 → 15 fps: divisor 4 keeps source-relative frames 0,4,8,… A scene
    # starting at trimmed frame 50 begins at the first KEPT frame ≥ 50 →
    # work frame ceil(50/4) = 13.
    pre = _pre(100, fps=15.0, fps_decimation={"fps": 15.0, "divisor": 4}, source_fps=60.0)
    got = _user_scene_boundaries({"scene_cuts": [50]}, pre)
    assert got == [(0, 13), (13, 100)]


def test_divisor_decimation_on_kept_frame_is_identity():
    pre = _pre(100, fps=15.0, fps_decimation={"fps": 15.0, "divisor": 4}, source_fps=60.0)
    got = _user_scene_boundaries({"scene_cuts": [48]}, pre)  # 48/4 = 12 exactly
    assert got == [(0, 12), (12, 100)]


def test_trim_then_decimation_composes():
    # trim [100, 580), then 60→15 (divisor 4): source cut 150 → trimmed 50
    # → work ceil(50/4) = 13
    pre = _pre(120, fps=15.0, trim=(100, 580),
               fps_decimation={"fps": 15.0, "divisor": 4}, source_fps=60.0)
    got = _user_scene_boundaries({"scene_cuts": [150]}, pre)
    assert got == [(0, 13), (13, 120)]


def test_nearest_frame_resample_rounds():
    # 24 → 10 fps is not a near-divisor (24/2=12 is 20% off 10) → resample:
    # work frame = round(c' * 10/24); cut 48 → 20
    pre = _pre(100, fps=10.0, fps_decimation={"fps": 10.0, "divisor": None}, source_fps=24.0)
    got = _user_scene_boundaries({"scene_cuts": [48]}, pre)
    assert got == [(0, 20), (20, 100)]


def test_colliding_cuts_collapse():
    # divisor 10: cuts 5 and 6 both map to work frame 1 — keep one
    pre = _pre(50, fps=6.0, fps_decimation={"fps": 6.0, "divisor": 10}, source_fps=60.0)
    got = _user_scene_boundaries({"scene_cuts": [5, 6]}, pre)
    assert got == [(0, 1), (1, 50)]


def test_resample_without_source_fps_fails_loudly():
    # a resampled work file reused from a meta entry that predates
    # source_fps: falling back to the WORK probe's fps (= the TARGET rate)
    # would degenerate the mapping to identity — fail loudly instead, in
    # BOTH mapping directions
    pre = {
        "probe": {"num_frames": 100, "fps": 10.0},
        "trim": None,
        "fps_decimation": {"fps": 10.0, "divisor": None},
        "source_fps": None,
    }
    with pytest.raises(ValueError, match="source_fps"):
        _map_source_to_work(48, pre)
    with pytest.raises(ValueError, match="source_fps"):
        _work_to_source_frame(20, pre)


def test_divisor_decimation_without_source_fps_still_works():
    # divisor mode needs no fps — a stale meta entry must not break it
    pre = {
        "probe": {"num_frames": 100, "fps": 15.0},
        "trim": None,
        "fps_decimation": {"fps": 15.0, "divisor": 4},
        "source_fps": None,
    }
    assert _map_source_to_work(50, pre) == 13
    assert _work_to_source_frame(13, pre) == 52


def test_boundaries_partition_the_clip():
    # invariant: boundaries tile [0, num_frames) with no gaps/overlaps
    pre = _pre(977, fps=12.0, trim=(31, 4000),
               fps_decimation={"fps": 12.0, "divisor": 2}, source_fps=24.0)
    got = _user_scene_boundaries({"scene_cuts": [31, 100, 500, 1500, 3999, 9999]}, pre)
    assert got[0][0] == 0 and got[-1][1] == 977
    for (_, a_end), (b_start, _) in zip(got, got[1:]):
        assert a_end == b_start
    assert all(a < b for a, b in got)
