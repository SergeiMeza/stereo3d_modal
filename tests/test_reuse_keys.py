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
    depth_lookup_keys,
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
    # the request's depth_res — both diverge from the shared derivation.
    # (The depth key hangs off the output-res-independent SOURCE identity,
    # not pp_key — see the preset-independence section below.)
    src_key = reuse.depth_source_key(
        _GATEWAY_BODY["input_path"], True, _GATEWAY_BODY["target_fps"], None)
    assert d_key == reuse.depth_key(src_key, "vda", 1960, "vitl")
    assert d_key != reuse.depth_key(src_key, "vda", old_pipeline_input_size, "vitl")


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


# ------------------------------------------------ passthrough depth identity

def test_depth_key_carries_the_passthrough_set():
    # passthrough scenes get BLACK depth (the AI pass is skipped), so a
    # different passthrough set is a different depth artifact
    plain = reuse.depth_key("pp:abc", "vda", 980, "vitl", scene_cuts=[100, 400])
    pt = reuse.depth_key("pp:abc", "vda", 980, "vitl", scene_cuts=[100, 400],
                         passthrough=[100])
    other = reuse.depth_key("pp:abc", "vda", 980, "vitl", scene_cuts=[100, 400],
                            passthrough=[400])
    assert plain != pt and pt != other


def test_depth_key_empty_passthrough_keeps_the_legacy_key():
    # no passthrough must hash identically to a pre-feature key so every
    # existing cached depth artifact stays reusable
    legacy = reuse.depth_key("pp:abc", "vda", 980, "vitl", scene_cuts=[100, 400])
    empty = reuse.depth_key("pp:abc", "vda", 980, "vitl", scene_cuts=[100, 400],
                            passthrough=None)
    assert legacy == empty


def test_request_passthrough_overrides_reach_the_depth_key():
    base = {**_GATEWAY_BODY, "scene_cuts": [100, 400]}
    plain = reuse_request_keys(dict(base))
    pt = reuse_request_keys({**base, "scene_overrides": [
        {"first": 100, "passthrough": True}]})
    # passthrough changes ONLY the depth artifact, not the work file
    assert pt[0] == plain[0] and pt[2] == plain[2]
    assert pt[1] != plain[1]
    # non-passthrough overrides (stereo styling) do NOT touch the depth key
    styled = reuse_request_keys({**base, "scene_overrides": [
        {"first": 100, "displacement": 0.02}]})
    assert styled[1] == plain[1]


# --------------------------------------------- preset-independent depth identity

def test_depth_key_is_preset_independent():
    # THE fb003da4da11 bug: the Depth page books preset draft
    # (target_height 1080); a 4k stereo/production run (target_height 2160)
    # must still reuse its depth artifact — the model resizes to input_size
    # either way and the stereo stage rescales depth to any work dims.
    common = {"input_path": "u/p1/source.mp4", "depth_res": 1596,
              "target_fps": 24, "scene_cuts": [266, 314]}
    draft = reuse_request_keys({**common, "preset": "draft"})
    four_k = reuse_request_keys({**common, "preset": "4k"})
    ten80 = reuse_request_keys({**common, "preset": "1080p"})
    # different work files (preprocess keys differ where target_height does)…
    assert draft[0] != four_k[0]
    # …but ONE depth artifact across every preset
    assert draft[1] == four_k[1] == ten80[1]


def test_depth_key_still_tracks_frame_content_and_count():
    common = {"input_path": "u/p1/source.mp4", "preset": "draft",
              "depth_res": 1596, "target_fps": 24}
    base = reuse_request_keys(dict(common))
    # fps decimation changes the frame COUNT → different depth
    assert reuse_request_keys({**common, "target_fps": 12})[1] != base[1]
    # crop changes the frame CONTENT → different depth
    assert reuse_request_keys({**common, "crop": "3840:1606:0:277"})[1] != base[1]
    # trim changes the frame set → different depth
    assert reuse_request_keys({**common, "from_frame": 10, "to_frame": 99})[1] != base[1]
    # resolution knob is still identity
    assert reuse_request_keys({**common, "depth_res": 980})[1] != base[1]


# ------------------------------------------------- passthrough lookup fallback

def test_depth_lookup_keys_fall_back_to_the_base_artifact():
    # a FULL depth artifact serves ANY passthrough set (the stereo stage
    # never reads passthrough scenes' depth), so the lookup tries the
    # exact key first and then the no-passthrough base key
    base = {**_GATEWAY_BODY, "scene_cuts": [100, 400]}
    plain_d = reuse_request_keys(dict(base))[1]
    pt_req = {**base, "scene_overrides": [{"first": 100, "passthrough": True}]}
    keys = depth_lookup_keys(pt_req)
    assert keys == [reuse_request_keys(pt_req)[1], plain_d]
    assert keys[0] != keys[1]


def test_depth_lookup_keys_without_passthrough_is_exact_only():
    # no widening in the other direction: a black-segmented artifact must
    # never serve a run that wants those scenes in 3D
    base = {**_GATEWAY_BODY, "scene_cuts": [100, 400]}
    assert depth_lookup_keys(dict(base)) == [reuse_request_keys(dict(base))[1]]


def test_warp_and_inpaint_never_touch_the_reuse_keys():
    # the stereo synthesis method (warp) and the fill pass (inpaint) change
    # only the SBS render, never the preprocess/depth/scenes artifacts — a
    # backward-warp production must hit the depth map a filled-edges
    # preview produced (and vice versa), or the depth discount never fires
    base = reuse_request_keys(dict(_GATEWAY_BODY))
    for extra in (
        {"warp": "backward", "inpaint": "none"},
        {"warp": "forward", "inpaint": "propainter"},
        {"inpaint": "none"},
    ):
        assert reuse_request_keys({**_GATEWAY_BODY, **extra}) == base, extra
