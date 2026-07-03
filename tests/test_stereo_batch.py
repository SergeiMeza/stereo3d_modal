"""ProPainter window sizing: the VRAM working set scales with window
frames × inpaint-res megapixels, so the window must shrink as the inpaint
resolution grows (30 frames at 2.79 MP OOMed a 140 GB H200 — job
c51480d2c0aa, 2026-07-03) while the proven 30-frames-at-720p point keeps
its full window."""

from app.stages.video_stereo import _pick_batch_size


def test_720p_tier_keeps_the_full_window():
    # 1280x720 = 0.92 MP and the 2.39:1 720-tier (1721x720 = 1.24 MP) —
    # the benchmarked, L40S-proven operating points
    assert _pick_batch_size(3587, 0.92) == 30
    assert _pick_batch_size(3587, 1.24) == 30


def test_high_res_inpaint_shrinks_the_window():
    # the OOM case: 4k preset on a 2.39:1 source → inpaint 2582x1080 = 2.79 MP
    n = _pick_batch_size(3587, 2.79)
    assert 8 <= n <= 14
    assert n * 2.79 <= 30 * 1.24 + 1e-6
    # 16:9 1080p inpaint (1920x1080 = 2.07 MP) also caps below 30
    assert _pick_batch_size(3587, 2.07) * 2.07 <= 30 * 1.24 + 1e-6


def test_never_leaves_a_single_frame_tail():
    for frames in (3587, 241, 61, 31, 25):
        for mp in (0.92, 2.07, 2.79):
            n = _pick_batch_size(frames, mp)
            assert frames % n != 1, (frames, mp, n)


def test_floor_is_eight_frames():
    # absurd resolution still yields a usable window
    assert _pick_batch_size(3587, 10.0) == 8
