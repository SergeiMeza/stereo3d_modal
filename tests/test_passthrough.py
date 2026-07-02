"""Per-scene passthrough: ship a scene as 2D (both eyes = untouched source,
no warp/inpaint) — end credits, logos, etc.

Passthrough is a STEREO-stage decision only: depth is still computed for
those frames, so content-addressed depth reuse keys are untouched and a
cached depth artifact stays valid when passthrough flags change.
"""

import pytest
from fastapi import HTTPException

from app.api.main import _validate_scene_overrides
from app.pipelines.video import _apply_scene_overrides
from app.stages.video_stereo import _passthrough_lookup, _split_passthrough_runs


class _Log:
    def info(self, *_): ...
    def warning(self, *_): ...


# ---------------------------------------------------- API validation

def test_validate_accepts_passthrough_only_entry():
    _validate_scene_overrides([{"first": 0, "passthrough": True}], None)
    _validate_scene_overrides(
        [{"first": 240, "passthrough": True}], [240, 900]
    )


def test_validate_rejects_passthrough_with_depth_knobs():
    for extra in (
        {"displacement": 0.01},
        {"shot_type": "wide"},
        {"placement": [-1.0, 0.5]},
    ):
        with pytest.raises(HTTPException) as exc:
            _validate_scene_overrides(
                [{"first": 0, "passthrough": True, **extra}], None
            )
        assert exc.value.status_code == 422
        assert "cannot be combined" in exc.value.detail


def test_validate_rejects_non_bool_passthrough():
    with pytest.raises(HTTPException) as exc:
        _validate_scene_overrides([{"first": 0, "passthrough": 1}], None)
    assert "boolean" in exc.value.detail


# ------------------------------------------------- script application

def _script():
    return [
        {"first": 0, "last": 240, "shot_type": "standard",
         "displacement": 0.01, "placement": [-1.0, 0.3]},
        {"first": 240, "last": 900, "shot_type": "dynamic",
         "displacement": 0.009, "placement": [-1.0, 0.3],
         "keyframes": [{"index": 240, "displacement": 0.008, "placement": [-1.0, 0.3]},
                       {"index": 899, "displacement": 0.01, "placement": [-1.0, 0.3]}]},
    ]


def test_apply_marks_passthrough_and_drops_keyframes():
    script = _script()
    _apply_scene_overrides(script, {240: {"passthrough": True}}, 1.0, _Log())
    assert script[1]["passthrough"] is True
    assert "keyframes" not in script[1]
    assert "passthrough" not in script[0]
    # the untouched shot keeps its numbers
    assert script[0]["displacement"] == 0.01


def test_apply_explicit_false_is_a_no_op():
    script = _script()
    _apply_scene_overrides(script, {240: {"passthrough": False}}, 1.0, _Log())
    assert "passthrough" not in script[1]
    assert "keyframes" in script[1]  # ramp must survive a no-op


def test_apply_false_with_real_override_still_applies_it():
    script = _script()
    _apply_scene_overrides(
        script, {240: {"passthrough": False, "displacement": 0.012}}, 1.0, _Log()
    )
    assert script[1]["displacement"] == 0.012
    assert "passthrough" not in script[1]


# ------------------------------------------------- stereo-stage lookup

def test_passthrough_lookup_none_when_unflagged():
    assert _passthrough_lookup(_script()) is None


def test_passthrough_lookup_predicate():
    script = _script()
    script[1]["passthrough"] = True
    at = _passthrough_lookup(script)
    assert at is not None
    assert at(239) is False
    assert at(240) is True
    assert at(899) is True
    assert at(900) is False  # half-open


def test_split_runs_covers_range_exactly():
    script = _script()
    script[1]["passthrough"] = True
    at = _passthrough_lookup(script)
    runs = _split_passthrough_runs(230, 250, at)
    assert runs == [(230, 240, False), (240, 250, True)]
    # tiles exactly, no gaps or overlap
    assert runs[0][0] == 230 and runs[-1][1] == 250


def test_split_runs_constant_batch_is_single_run():
    script = _script()
    script[0]["passthrough"] = True
    at = _passthrough_lookup(script)
    assert _split_passthrough_runs(10, 20, at) == [(10, 20, True)]
    assert _split_passthrough_runs(500, 510, at) == [(500, 510, False)]
