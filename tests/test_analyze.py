"""_strip_indices: evenly spaced filmstrip frame selection; the poster
frame skips black and flat frames."""

from pathlib import Path

from app.pipelines.analyze import _luma_stats, _pick_poster_frame, _strip_indices


def test_includes_first_and_last_frame():
    idx = _strip_indices(1000, 100)
    assert idx[0] == 0
    assert idx[-1] == 999


def test_count_capped_by_frames():
    assert _strip_indices(5, 100) == [0, 1, 2, 3, 4]


def test_single_frame_video():
    assert _strip_indices(1, 100) == [0]


def test_empty_video():
    assert _strip_indices(0, 100) == []


def test_strictly_increasing_and_in_range():
    for n, count in [(7, 3), (240, 100), (99999, 300), (100, 100)]:
        idx = _strip_indices(n, count)
        assert all(0 <= i < n for i in idx)
        assert all(b > a for a, b in zip(idx, idx[1:]))
        assert len(idx) <= count


def _stats(table):
    return lambda path: table.get(path.name)


def test_poster_skips_opening_black():
    # an end roll opening on black: black, near-black flat, then picture
    samples = [(0, Path("a")), (10, Path("b")), (20, Path("c")), (30, Path("d"))]
    table = {"a": (0.0, 0.0), "b": (0.02, 0.01), "c": (0.30, 0.20), "d": (0.5, 0.2)}
    assert _pick_poster_frame(samples, 100, _stats(table)) == 20


def test_poster_skips_bright_flat_frame():
    # a flat grey or white card isn't a picture either
    samples = [(0, Path("a")), (5, Path("b"))]
    table = {"a": (0.6, 0.005), "b": (0.4, 0.1)}
    assert _pick_poster_frame(samples, 50, _stats(table)) == 5


def test_poster_first_frame_when_fine():
    samples = [(0, Path("a")), (5, Path("b"))]
    assert _pick_poster_frame(samples, 50, _stats({"a": (0.4, 0.2), "b": (0.4, 0.2)})) == 0


def test_poster_falls_back_to_the_middle():
    samples = [(0, Path("a")), (5, Path("b")), (9, Path("missing"))]
    table = {"a": (0.0, 0.0), "b": (0.05, 0.0)}
    assert _pick_poster_frame(samples, 240, _stats(table)) == 120
    assert _pick_poster_frame([], 0, _stats({})) == 0


def test_luma_stats_reads_jpegs(tmp_path):
    import cv2
    import numpy as np

    black = tmp_path / "black.jpg"
    cv2.imwrite(str(black), np.zeros((90, 160), np.uint8))
    noise = tmp_path / "noise.jpg"
    cv2.imwrite(str(noise), np.random.default_rng(1).integers(0, 255, (90, 160), dtype=np.uint8))
    mean, std = _luma_stats(black)
    assert mean < 0.01 and std < 0.01
    mean, std = _luma_stats(noise)
    assert 0.3 < mean < 0.7 and std > 0.1
    assert _luma_stats(tmp_path / "nope.jpg") is None


def test_publish_copies_every_file(tmp_path):
    from app.pipelines.analyze import _publish

    src = tmp_path / "local"
    src.mkdir()
    files = []
    for i in range(40):
        f = src / f"strip_{i:05d}.jpg"
        f.write_bytes(bytes([i]) * 10)
        files.append(f)
    dest = tmp_path / "bucket" / "thumbs"
    _publish(files, dest)
    assert sorted(p.name for p in dest.iterdir()) == sorted(f.name for f in files)
    assert (dest / "strip_00007.jpg").read_bytes() == bytes([7]) * 10
