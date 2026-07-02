"""scene_overrides pipeline mechanics: source→work targeting through the
ONE trim+decimation mapping, override application onto a final depth
script, and the non-adaptive synthesis path.

Frame doctrine: an override that doesn't land on a resolved scene start
FAILS the job (never snapped); a scene entirely outside the trim window
is dropped WITH a warning (same handling as a trimmed-out cut).
"""

import pytest

from app.pipelines.video import (
    _apply_scene_overrides,
    _resolve_scene_overrides,
    _synthesize_scene_params,
    _user_scene_boundaries,
)
from app.stages.video_depth_models import DEFAULT_PLACEMENT, SHOT_PARAMS


def _pre(num_frames, fps=24.0, trim=None, fps_decimation=None, source_fps=None,
         source_num_frames=None):
    return {
        "probe": {"num_frames": num_frames, "fps": fps},
        "trim": trim,
        "fps_decimation": fps_decimation,
        "source_fps": source_fps or fps,
        "source_num_frames": source_num_frames,
    }


class _Jlog:
    """Captures warnings/infos so tests can assert the drop-with-warning
    contract (the doctrine's one allowed drop)."""

    def __init__(self):
        self.warnings, self.infos = [], []

    def warning(self, msg):
        self.warnings.append(msg)

    def info(self, msg):
        self.infos.append(msg)


def _resolve(request, pre):
    jlog = _Jlog()
    boundaries = _user_scene_boundaries(request, pre) or [(0, pre["probe"]["num_frames"])]
    return _resolve_scene_overrides(request, pre, boundaries, jlog), jlog


# ------------------------------------------------------- source→work targeting

def test_plain_targeting_no_trim_no_decimation():
    request = {
        "scene_cuts": [50, 120],
        "scene_overrides": [
            {"first": 0, "displacement": 0.012},
            {"first": 120, "shot_type": "wide"},
        ],
    }
    resolved, jlog = _resolve(request, _pre(200))
    assert resolved == {0: {"displacement": 0.012}, 120: {"shot_type": "wide"}}
    assert jlog.warnings == []


def test_divisor_decimation_targets_the_ceiled_work_start():
    # 60 → 15 fps (divisor 4): cut 50 → work ceil(50/4) = 13, the same
    # boundary math test_scene_cuts pins — the override must land on it
    pre = _pre(100, fps=15.0, fps_decimation={"fps": 15.0, "divisor": 4}, source_fps=60.0)
    request = {"scene_cuts": [50],
               "scene_overrides": [{"first": 50, "displacement": 0.01}]}
    resolved, _ = _resolve(request, pre)
    assert resolved == {13: {"displacement": 0.01}}


def test_trim_then_decimation_composes():
    # trim [100, 580) then divisor 4: source 150 → trimmed 50 → work 13
    pre = _pre(120, fps=15.0, trim=(100, 580),
               fps_decimation={"fps": 15.0, "divisor": 4}, source_fps=60.0)
    request = {"scene_cuts": [150],
               "scene_overrides": [{"first": 150, "shot_type": "close_up"}]}
    resolved, _ = _resolve(request, pre)
    assert resolved == {13: {"shot_type": "close_up"}}


def test_nearest_frame_resample_targets_the_rounded_work_start():
    # 24 → 10 fps resample: cut 48 → round(48·10/24) = 20
    pre = _pre(100, fps=10.0, fps_decimation={"fps": 10.0, "divisor": None},
               source_fps=24.0)
    request = {"scene_cuts": [48],
               "scene_overrides": [{"first": 48, "placement": [-1.0, 0.2]}]}
    resolved, _ = _resolve(request, pre)
    assert resolved == {20: {"placement": [-1.0, 0.2]}}


def test_unmatched_first_fails_loudly():
    # adaptive auto-detect path: no scene_cuts, boundaries from detection —
    # an override that doesn't hit a detected start must fail, never snap
    pre = _pre(100)
    jlog = _Jlog()
    with pytest.raises(ValueError, match="not a resolved scene start"):
        _resolve_scene_overrides(
            {"scene_overrides": [{"first": 40, "displacement": 0.01}]},
            pre, [(0, 30), (30, 100)], jlog,
        )
    # while an exact detected start resolves fine
    resolved = _resolve_scene_overrides(
        {"scene_overrides": [{"first": 30, "displacement": 0.01}]},
        pre, [(0, 30), (30, 100)], _Jlog(),
    )
    assert resolved == {30: {"displacement": 0.01}}


def test_trimmed_out_scene_drops_with_warning():
    # trim [100, 400): source scenes [0,50) and [400,500) are entirely
    # outside the window; [50,150) survives as work scene 0 (its start was
    # trimmed mid-scene) and [150,400) as work scene 1
    pre = _pre(300, trim=(100, 400))
    request = {
        "scene_cuts": [50, 150, 400, 500],
        "scene_overrides": [
            {"first": 0, "displacement": 0.01},     # scene [0,50) — gone
            {"first": 50, "displacement": 0.011},   # tail survives → work 0
            {"first": 150, "displacement": 0.012},  # → work 50
            {"first": 400, "displacement": 0.013},  # at/after trim end — gone
        ],
    }
    resolved, jlog = _resolve(request, pre)
    assert resolved == {0: {"displacement": 0.011}, 50: {"displacement": 0.012}}
    assert len(jlog.warnings) == 2
    assert all("outside the trim window" in w for w in jlog.warnings)


def test_cut_past_clip_end_drops_with_warning():
    # a cut past the clip end is dropped by the boundary mapping; the
    # matching override is dropped the same way (with a warning)
    pre = _pre(100)
    request = {"scene_cuts": [50, 500],
               "scene_overrides": [{"first": 500, "displacement": 0.01}]}
    resolved, jlog = _resolve(request, pre)
    assert resolved == {}
    assert len(jlog.warnings) == 1 and "maps past the work clip" in jlog.warnings[0]


def test_decimation_collapsed_scene_override_drops_with_warning():
    # the verified silent-wrong-scene case: cuts [51, 52] under divisor 2 —
    # scene [51, 52) keeps NO work frames (work frame ceil(51/2) = 26 shows
    # source frame 52's content), so its override must be DROPPED with a
    # warning, never applied to the next scene
    pre = _pre(52, fps=12.0, fps_decimation={"fps": 12.0, "divisor": 2},
               source_fps=24.0)
    request = {"scene_cuts": [51, 52],
               "scene_overrides": [{"first": 51, "displacement": 0.02}]}
    resolved, jlog = _resolve(request, pre)
    assert resolved == {}
    assert len(jlog.warnings) == 1 and "keeps no work frames" in jlog.warnings[0]


def test_decimation_collapse_next_scenes_override_still_applies():
    # same collapse, but the override on the SURVIVING scene (52 owns work
    # frame 26) resolves normally — only the collapsed scene's is dropped
    pre = _pre(52, fps=12.0, fps_decimation={"fps": 12.0, "divisor": 2},
               source_fps=24.0)
    request = {
        "scene_cuts": [51, 52],
        "scene_overrides": [{"first": 51, "displacement": 0.01},
                            {"first": 52, "displacement": 0.02}],
    }
    resolved, jlog = _resolve(request, pre)
    assert resolved == {26: {"displacement": 0.02}}
    assert len(jlog.warnings) == 1 and "keeps no work frames" in jlog.warnings[0]


def test_multiframe_scene_under_decimation_still_applies():
    # a scene that KEEPS work frames under decimation is not collapse-dropped:
    # cuts [50, 60] divisor 2 → scene [50, 60) spans work [25, 30)
    pre = _pre(50, fps=12.0, fps_decimation={"fps": 12.0, "divisor": 2},
               source_fps=24.0)
    request = {"scene_cuts": [50, 60],
               "scene_overrides": [{"first": 50, "displacement": 0.01}]}
    resolved, jlog = _resolve(request, pre)
    assert resolved == {25: {"displacement": 0.01}}
    assert jlog.warnings == []


def test_duplicate_first_later_override_wins_with_warning():
    # defensive branch: two overrides targeting the SAME resolved work
    # scene (API validation forbids duplicate firsts, but the pipeline
    # keeps the loud later-wins policy for direct callers)
    request = {
        "scene_cuts": [50],
        "scene_overrides": [{"first": 50, "displacement": 0.01},
                            {"first": 50, "displacement": 0.02}],
    }
    resolved, jlog = _resolve(request, _pre(100))
    assert resolved == {50: {"displacement": 0.02}}
    assert len(jlog.warnings) == 1 and "later entry wins" in jlog.warnings[0]


# --------------------------------------------------------- override application

def _adaptive_script():
    """A profiler-shaped script (post smoothing/comfort), incl. a dynamic
    shot with a keyframe ramp."""
    return [
        {"first": 0, "last": 100, "shot_type": "dynamic",
         "displacement": 0.009, "placement": [-1.0, 0.1],
         "median": 4.2, "near_fraction": 0.2,
         "screen_disp_in": -0.001, "screen_disp_out": 0.0005,
         "keyframes": [
             {"index": 0, "displacement": 0.010, "placement": [-1.0, 0.3]},
             {"index": 99, "displacement": 0.007, "placement": [-1.0, -0.1]},
         ]},
        {"first": 100, "last": 220, "shot_type": "standard",
         "displacement": 0.010, "placement": [-1.0, 0.3],
         "median": 6.0, "near_fraction": 0.05,
         "screen_disp_in": -0.002, "screen_disp_out": -0.002},
    ]


def test_flat_displacement_drops_keyframes():
    script = _adaptive_script()
    _apply_scene_overrides(script, {0: {"displacement": 0.012}}, 1.0, _Jlog())
    assert script[0]["displacement"] == 0.012
    assert "keyframes" not in script[0]  # ramp would win in the stereo lookup
    assert script[0]["override"] == {"displacement": 0.012}
    # untouched shot stays byte-identical
    assert "override" not in script[1] and script[1]["displacement"] == 0.010


def test_shot_type_rederives_from_shot_params_times_depth_scale():
    script = _adaptive_script()
    _apply_scene_overrides(script, {100: {"shot_type": "close_up"}}, 0.8, _Jlog())
    assert script[1]["shot_type"] == "close_up"
    # same scaling the profiler applies: SHOT_PARAMS displacement × scale
    assert script[1]["displacement"] == round(
        SHOT_PARAMS["close_up"]["displacement"] * 0.8, 6)
    assert script[1]["placement"] == list(SHOT_PARAMS["close_up"]["placement"])


def test_explicit_placement_wins_over_derived():
    script = _adaptive_script()
    _apply_scene_overrides(
        script, {100: {"shot_type": "wide", "placement": [-1.2, 0.0]}}, 1.0, _Jlog())
    assert script[1]["displacement"] == SHOT_PARAMS["wide"]["displacement"]
    assert script[1]["placement"] == [-1.2, 0.0]


def test_displacement_wins_over_shot_type_derivation():
    script = _adaptive_script()
    _apply_scene_overrides(
        script, {0: {"shot_type": "wide", "displacement": 0.005}}, 1.0, _Jlog())
    assert script[0]["displacement"] == 0.005  # flat manual value
    assert script[0]["placement"] == list(SHOT_PARAMS["wide"]["placement"])
    assert "keyframes" not in script[0]


def test_unmatched_resolved_start_is_a_programming_error():
    with pytest.raises(RuntimeError, match="absent from"):
        _apply_scene_overrides(
            _adaptive_script(), {7: {"displacement": 0.01}}, 1.0, _Jlog())


# ------------------------------------------------------ non-adaptive synthesis

def test_synthesis_flat_defaults_then_overrides():
    ranges = [(0, 50), (50, 120), (120, 200)]
    script = _synthesize_scene_params(ranges, 0.0125)
    assert [(e["first"], e["last"]) for e in script] == ranges
    for e in script:
        assert e["displacement"] == 0.0125
        assert e["placement"] == list(DEFAULT_PLACEMENT)
        assert "keyframes" not in e
    _apply_scene_overrides(script, {50: {"displacement": 0.008}}, 1.0, _Jlog())
    assert script[1]["displacement"] == 0.008
    assert script[0]["displacement"] == script[2]["displacement"] == 0.0125


def test_synthesis_non_overridden_scene_matches_plain_render():
    # overriding ONE scene must not restyle the others: non-overridden
    # scenes keep (request displacement, DEFAULT_PLACEMENT) — exactly what
    # a plain non-adaptive render uses (NOT the adaptive 'standard' bucket,
    # whose placement (-1.0, 0.3) differs from DEFAULT_PLACEMENT (-1.0, 0.5))
    script = _synthesize_scene_params([(0, 50), (50, 200)], 0.0125)
    _apply_scene_overrides(script, {50: {"shot_type": "wide"}}, 1.0, _Jlog())
    assert script[0]["displacement"] == 0.0125
    assert script[0]["placement"] == list(DEFAULT_PLACEMENT)
    assert "override" not in script[0]
    # the overridden scene changed as requested
    assert script[1]["placement"] == list(SHOT_PARAMS["wide"]["placement"])
