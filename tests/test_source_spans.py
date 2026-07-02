"""_annotate_source_spans: first_src/last_src on depth-script entries.

The web client works in SOURCE-frame space (frame doctrine): user cut
values are echoed verbatim, auto-detected work scenes are inverse-mapped
through the same trim+decimation model as _map_source_to_work.
"""

from app.pipelines.video import (
    _annotate_source_spans,
    _user_scene_boundaries,
    _work_to_source_frame,
)


def _pre(num_frames, fps=24.0, trim=None, fps_decimation=None, source_fps=None,
         source_num_frames=None):
    return {
        "probe": {"num_frames": num_frames, "fps": fps},
        "trim": trim,
        "fps_decimation": fps_decimation,
        "source_fps": source_fps or fps,
        "source_num_frames": source_num_frames,
    }


def _script_for(request, pre):
    """Entries shaped like the depth script over the resolved boundaries."""
    bounds = _user_scene_boundaries(request, pre)
    return [{"first": a, "last": b} for a, b in bounds]


def _spans(script):
    return [(e["first_src"], e["last_src"]) for e in script]


def test_plain_cuts_echo_verbatim():
    pre = _pre(200, source_num_frames=200)
    request = {"scene_cuts": [50, 120]}
    script = _script_for(request, pre)
    _annotate_source_spans(script, request, pre)
    assert _spans(script) == [(0, 50), (50, 120), (120, 200)]
    # work-space keys untouched
    assert [(e["first"], e["last"]) for e in script] == [(0, 50), (50, 120), (120, 200)]


def test_trim_names_the_true_source_scenes():
    # trim [100, 400): cuts 50/100 map at/before work 0, 400/500 past the
    # end → work boundaries [(0,50),(50,300)]. Work scene 0's content is
    # source [100,150) ⊂ source scene [100,150) (the cut at exactly the
    # trim start), so first_src=100/last_src=150; work scene 1 is source
    # scene [150,400) — the user's own numbers, never round-tripped.
    pre = _pre(300, trim=(100, 400), source_num_frames=600)
    request = {"scene_cuts": [50, 100, 150, 400, 500]}
    script = _script_for(request, pre)
    _annotate_source_spans(script, request, pre)
    assert _spans(script) == [(100, 150), (150, 400)]


def test_divisor_decimation_last_scene_ends_at_source_length():
    # 60→15 (divisor 4), cut 50 → work 13: spans echo the cut; the final
    # scene ends at the SOURCE clip length (400), which only
    # source_num_frames can supply (the work probe saw 100 frames).
    pre = _pre(100, fps=15.0, fps_decimation={"fps": 15.0, "divisor": 4},
               source_fps=60.0, source_num_frames=400)
    request = {"scene_cuts": [50]}
    script = _script_for(request, pre)
    _annotate_source_spans(script, request, pre)
    assert _spans(script) == [(0, 50), (50, 400)]


def test_missing_source_num_frames_falls_back_to_inverse_map():
    # older reuse-cache entries predate source_num_frames: no trim →
    # inverse-map the work end (100 work frames × divisor 4 = source 400,
    # exact up to the ≤3 dropped tail frames decimation can't recover)
    pre = _pre(100, fps=15.0, fps_decimation={"fps": 15.0, "divisor": 4},
               source_fps=60.0, source_num_frames=None)
    request = {"scene_cuts": [50]}
    script = _script_for(request, pre)
    _annotate_source_spans(script, request, pre)
    assert _spans(script) == [(0, 50), (50, 400)]


def test_missing_source_num_frames_with_trim_uses_trim_end():
    # the trim starts MID source scene [0,150): the surviving work scene 0
    # still names its true source scene (first_src=0 — a scene start is
    # 0 or a cut value, never the trim edge); the last scene's end falls
    # back to the trim end when source_num_frames is unavailable
    pre = _pre(300, trim=(100, 400), source_num_frames=None)
    request = {"scene_cuts": [150]}
    script = _script_for(request, pre)
    _annotate_source_spans(script, request, pre)
    assert _spans(script) == [(0, 150), (150, 400)]


def test_collapsed_cuts_keep_their_own_source_identity():
    # divisor 10: cuts 5 and 6 collapse onto work frame 1. The surviving
    # work scene starting at 1 holds kept frames from source 10 onward —
    # source scene [6, …) — so first_src=6; the collapsed [5,6) is the gap.
    pre = _pre(50, fps=6.0, fps_decimation={"fps": 6.0, "divisor": 10},
               source_fps=60.0, source_num_frames=500)
    request = {"scene_cuts": [5, 6]}
    script = _script_for(request, pre)
    _annotate_source_spans(script, request, pre)
    assert _spans(script) == [(0, 5), (6, 500)]


def test_auto_detected_scenes_inverse_map():
    # no scene_cuts (adaptive detection): trim start 100 + divisor 4 →
    # work w = source 100 + 4·w. Detected work scenes (0,30),(30,120):
    # first_src 100 / 220; final last_src = source_num_frames.
    pre = _pre(120, fps=15.0, trim=(100, 580),
               fps_decimation={"fps": 15.0, "divisor": 4}, source_fps=60.0,
               source_num_frames=700)
    request = {}
    script = [{"first": 0, "last": 30}, {"first": 30, "last": 120}]
    _annotate_source_spans(script, request, pre)
    assert _spans(script) == [(100, 220), (220, 700)]


def test_auto_detected_resample_inverse_rounds():
    # 24→10 resample: work 20 → round(20·24/10) = 48 — the inverse of the
    # forward round(48·10/24) = 20 pinned in test_scene_cuts
    pre = _pre(100, fps=10.0, fps_decimation={"fps": 10.0, "divisor": None},
               source_fps=24.0, source_num_frames=240)
    assert _work_to_source_frame(20, pre) == 48
    script = [{"first": 0, "last": 20}, {"first": 20, "last": 100}]
    _annotate_source_spans(script, {}, pre)
    assert _spans(script) == [(0, 48), (48, 240)]
