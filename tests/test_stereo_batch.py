"""ProPainter window sizing: the VRAM working set scales with window
frames × inpaint-res megapixels, budgeted PER GPU TIER. 30 frames at
2.79 MP OOMed a 140 GB H200 (job c51480d2c0aa, 2026-07-03); the 13-frame
fallback finished but ~doubled the propainter GPU-seconds (job
8aadc9e33449, $25.5 vs ~$12 projected), so the H200 tier budgets 65
MP·frames (~110 GB peak at the measured ~1.7 GB/MP·frame) while the L40S
tier keeps its proven 30-frames-at-720p point."""

from app.stages.video_stereo import _pick_batch_size


def test_720p_tier_keeps_the_full_window():
    # 1280x720 = 0.92 MP and the 2.39:1 720-tier (1721x720 = 1.24 MP) —
    # the benchmarked, L40S-proven operating points
    assert _pick_batch_size(3587, 0.92, vram_gb=45) == 30
    assert _pick_batch_size(3587, 1.24, vram_gb=45) == 30


def test_high_res_inpaint_shrinks_the_window_on_the_small_tier():
    # the OOM case: 4k preset on a 2.39:1 source → inpaint 2582x1080 = 2.79 MP
    n = _pick_batch_size(3587, 2.79, vram_gb=45)
    assert 8 <= n <= 14
    assert n * 2.79 <= 30 * 1.24 + 1e-6
    # 16:9 1080p inpaint (1920x1080 = 2.07 MP) also caps below 30
    assert _pick_batch_size(3587, 2.07, vram_gb=45) * 2.07 <= 30 * 1.24 + 1e-6


def test_h200_tier_runs_a_wide_window_at_4k():
    # the 8aadc9e33449 shape: 2.79 MP inpaint on the 140 GB tier — most of
    # the window comes back (per-window overhead ~doubled the cost at 13)
    n = _pick_batch_size(3587, 2.79, vram_gb=140)
    assert 20 <= n <= 24
    assert n * 2.79 <= 65.0 + 1e-6


def test_h200_tier_still_ceilinged_at_30():
    # qhd-class work (~2 MP) fits >30 frames in the H200 budget, but 30 is
    # the proven quality/behavior ceiling — never exceeded
    assert _pick_batch_size(3587, 2.0, vram_gb=140) == 30


def test_no_cuda_falls_back_to_the_small_tier():
    # coordinator/CI has no GPU: unknown VRAM must size conservatively
    assert _pick_batch_size(3587, 2.79) * 2.79 <= 30 * 1.24 + 1e-6


def test_never_leaves_a_single_frame_tail():
    for frames in (3587, 241, 61, 31, 25):
        for mp in (0.92, 2.07, 2.79):
            for vram in (45, 140):
                n = _pick_batch_size(frames, mp, vram_gb=vram)
                assert frames % n != 1, (frames, mp, vram, n)


def test_floor_is_eight_frames():
    # absurd resolution still yields a usable window
    assert _pick_batch_size(3587, 10.0, vram_gb=45) == 8
    assert _pick_batch_size(3587, 10.0, vram_gb=140) == 8
