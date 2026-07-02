"""Reuse cache-key fidelity: process_video_job and POST /v1/reuse/lookup
must derive keys from the SAME effective request (preset merge + v7
aliases via the shared normalize_video_request/reuse_request_keys), and
the depth key must carry the scene-boundary identity (per-scene depth
normalization resets at cuts, so different cut lists are different
artifacts).
"""

from app.common import reuse
from app.pipelines.video import (
    PRESETS,
    normalize_video_request,
    reuse_request_keys,
)


# ------------------------------------------------- depth_res / preset precedence

def test_explicit_depth_res_overrides_preset_input_size():
    # the money bug: every preset defines input_size, so an after-merge
    # depth_res alias could never fire — an explicit depth_res was
    # silently discarded and billed at the preset's resolution
    req = normalize_video_request(
        {"input_path": "x.mp4", "preset": "1080p", "depth_res": 1960})
    assert req["input_size"] == 1960
    assert req["target_height"] == 1080  # rest of the preset still applies


def test_preset_alone_supplies_its_input_size():
    req = normalize_video_request({"input_path": "x.mp4", "preset": "1080p"})
    assert req["input_size"] == PRESETS["1080p"]["input_size"]


def test_depth_res_without_preset_sets_input_size():
    req = normalize_video_request({"input_path": "x.mp4", "depth_res": 1960})
    assert req["input_size"] == 1960


def test_explicit_input_size_beats_depth_res():
    # with and without a preset: the alias only fills the internal field
    req = normalize_video_request(
        {"input_path": "x.mp4", "input_size": 700, "depth_res": 1960})
    assert req["input_size"] == 700
    req = normalize_video_request(
        {"input_path": "x.mp4", "preset": "1080p", "input_size": 700,
         "depth_res": 1960})
    assert req["input_size"] == 700


def test_normalize_does_not_mutate_and_is_idempotent():
    raw = {"input_path": "x.mp4", "preset": "4k", "depth_res": 1960}
    req = normalize_video_request(raw)
    assert raw == {"input_path": "x.mp4", "preset": "4k", "depth_res": 1960}
    assert normalize_video_request(req) == req


# --------------------------------------------------- lookup == pipeline keys

# a gateway-shaped submit body: preset + formats + target_fps + depth_res
_GATEWAY_BODY = {
    "input_path": "inputs/uploads/clip.mp4",
    "preset": "1080p",
    "formats": ["sbs", "mvhevc"],
    "target_fps": 24,
    "depth_res": 1960,
}


def test_lookup_keys_match_pipeline_keys_for_gateway_request():
    # the endpoint hashes the raw body; the pipeline normalizes first and
    # hashes the result — reuse_request_keys is idempotent over its own
    # normalization, so both call sites agree by construction
    endpoint_keys = reuse_request_keys(dict(_GATEWAY_BODY))
    pipeline_keys = reuse_request_keys(normalize_video_request(dict(_GATEWAY_BODY)))
    assert endpoint_keys == pipeline_keys


def test_shared_derivation_differs_from_the_old_raw_paths():
    # simulate what the two call sites hashed BEFORE the shared helper, to
    # show the fix matters. Old endpoint: raw body — target_height=None
    # (the preset never merged), input_size = depth_res or 980.
    old_endpoint_pp = reuse.preprocess_key(
        _GATEWAY_BODY["input_path"], True, None, None,
        _GATEWAY_BODY["target_fps"], None,
    )
    # old pipeline: preset merged but depth_res dead — input_size = preset's
    old_pipeline_input_size = PRESETS["1080p"]["input_size"]

    pp_key, d_key, _ = reuse_request_keys(dict(_GATEWAY_BODY))
    # the old endpoint's pp key (target_height=None) never matched the
    # pipeline's (preset target_height=1080)
    assert old_endpoint_pp != pp_key
    # and the old pipeline's depth key hashed the preset's input_size, not
    # the request's depth_res — both diverge from the shared derivation
    assert d_key == reuse.depth_key(pp_key, "vda", 1960, "vitl")
    assert d_key != reuse.depth_key(pp_key, "vda", old_pipeline_input_size, "vitl")


def test_trim_fields_feed_the_preprocess_key():
    with_trim = reuse_request_keys(
        {**_GATEWAY_BODY, "from_frame": 10, "to_frame": 200})
    assert with_trim != reuse_request_keys(dict(_GATEWAY_BODY))


# ------------------------------------------------ scene-boundary depth identity

def test_depth_key_differs_across_user_cut_lists():
    # per-scene alignment/normalization resets at cuts: a depth rendered
    # with cuts [100, 400] is NOT the artifact for cuts [250]
    a = reuse.depth_key("pp:abc", "vda", 980, "vitl", scene_cuts=[100, 400])
    b = reuse.depth_key("pp:abc", "vda", 980, "vitl", scene_cuts=[250])
    assert a != b


def test_depth_key_same_cuts_same_key():
    a = reuse.depth_key("pp:abc", "vda", 980, "vitl", scene_cuts=[100, 400])
    b = reuse.depth_key("pp:abc", "vda", 980, "vitl", scene_cuts=[100, 400])
    assert a == b


def test_depth_key_auto_differs_from_empty_user_cuts():
    # scene_cuts: [] is a USER decision (one scene, no resets at detected
    # cuts) — not the same artifact as auto-detected scenes
    auto = reuse.depth_key("pp:abc", "vda", 980, "vitl", scene_cuts=None)
    user_empty = reuse.depth_key("pp:abc", "vda", 980, "vitl", scene_cuts=[])
    assert auto != user_empty


def test_request_scene_cuts_reach_the_depth_key():
    plain = reuse_request_keys(dict(_GATEWAY_BODY))
    with_cuts = reuse_request_keys({**_GATEWAY_BODY, "scene_cuts": [100, 400]})
    # same preprocess/scenes keys (cuts don't change the work file)…
    assert with_cuts[0] == plain[0] and with_cuts[2] == plain[2]
    # …but a different depth key (normalization boundaries differ)
    assert with_cuts[1] != plain[1]
