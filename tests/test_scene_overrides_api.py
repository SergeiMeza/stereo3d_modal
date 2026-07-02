"""_validate_scene_overrides: submit-time validation of scene_overrides.

Frame doctrine: a per-scene decision is validated hard at the API (422)
so a malformed override never reaches the pipeline, where the only
remaining outcome is a loud job failure.
"""

import pytest
from fastapi import HTTPException

from app.api.main import _validate_scene_overrides


def _rejects(overrides, scene_cuts=None, match=""):
    with pytest.raises(HTTPException) as exc:
        _validate_scene_overrides(overrides, scene_cuts)
    assert exc.value.status_code == 422
    assert match in exc.value.detail
    return exc.value.detail


# ------------------------------------------------------------- accepts

def test_valid_matrix_passes():
    _validate_scene_overrides(
        [
            {"first": 0, "displacement": 0.012},
            {"first": 266, "shot_type": "dynamic"},
            {"first": 980, "displacement": 0.008, "shot_type": "close_up"},
        ],
        scene_cuts=[266, 980],
    )


def test_valid_placement_and_no_scene_cuts():
    # without scene_cuts the membership check can't run at the API (the
    # scene starts are only known after detection) — pipeline enforces it
    _validate_scene_overrides(
        [{"first": 0, "placement": [-1.0, 0.5]},
         {"first": 42, "placement": [-1.5, 1.5], "shot_type": "wide"}],
        scene_cuts=None,
    )


def test_empty_list_is_a_noop():
    _validate_scene_overrides([], scene_cuts=None)


# ------------------------------------------------------------- rejects

def test_not_a_list():
    _rejects({"first": 0}, match="list of objects")
    _rejects([{"first": 0, "displacement": 0.01}, "nope"], match="list of objects")


def test_unknown_key():
    _rejects([{"first": 0, "displacement": 0.01, "displ": 0.02}],
             match="unknown key")


def test_first_required_and_typed():
    _rejects([{"displacement": 0.01}], match="first must be a non-negative int")
    _rejects([{"first": -1, "displacement": 0.01}], match="non-negative")
    _rejects([{"first": 1.5, "displacement": 0.01}], match="non-negative")
    _rejects([{"first": True, "displacement": 0.01}], match="non-negative")


def test_first_strictly_increasing():
    _rejects([{"first": 10, "displacement": 0.01},
              {"first": 10, "shot_type": "wide"}], match="strictly increasing")
    _rejects([{"first": 20, "displacement": 0.01},
              {"first": 5, "shot_type": "wide"}], match="strictly increasing")


def test_first_must_be_a_scene_start_when_cuts_given():
    _rejects([{"first": 100, "displacement": 0.01}], scene_cuts=[266, 980],
             match="not a scene start")
    # 0 is always the first scene's start
    _validate_scene_overrides([{"first": 0, "displacement": 0.01}],
                              scene_cuts=[266])


def test_empty_entry_needs_an_override_field():
    _rejects([{"first": 0}], match="at least one of")


def test_displacement_range():
    _rejects([{"first": 0, "displacement": 0.0}], match="(0, 0.1]")
    _rejects([{"first": 0, "displacement": 0.11}], match="(0, 0.1]")
    _rejects([{"first": 0, "displacement": "x"}], match="(0, 0.1]")
    _rejects([{"first": 0, "displacement": True}], match="(0, 0.1]")


def test_shot_type_enum():
    _rejects([{"first": 0, "shot_type": "closeup"}], match="shot_type")
    for st in ("close_up", "standard", "dynamic", "wide"):
        _validate_scene_overrides([{"first": 0, "shot_type": st}], None)


def test_placement_shape_and_bounds():
    _rejects([{"first": 0, "placement": [-1.0]}], match="placement")
    _rejects([{"first": 0, "placement": [-1.0, 0.5, 0.6]}], match="placement")
    _rejects([{"first": 0, "placement": [0.5, -1.0]}], match="far < near")
    _rejects([{"first": 0, "placement": [0.5, 0.5]}], match="far < near")
    _rejects([{"first": 0, "placement": [-1.6, 0.5]}], match="[-1.5, 1.5]")
    _rejects([{"first": 0, "placement": [-1.0, 1.6]}], match="[-1.5, 1.5]")
    _rejects([{"first": 0, "placement": [-1.0, "hi"]}], match="placement")
