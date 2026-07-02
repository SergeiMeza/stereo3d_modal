"""_strip_indices: evenly spaced filmstrip frame selection."""

from app.pipelines.analyze import _strip_indices


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
