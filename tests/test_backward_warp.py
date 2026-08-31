"""BackwardWarpStereo (gather warp) — the second stereo method.

Both failure modes here produce plausible-looking frames, so nothing is
eyeballed:

1. depth DIRECTION — a near object must shift RIGHT in the left eye and
   LEFT in the right eye (relative to the background). Inverted depth
   is the classic sign bug and is genuinely uncomfortable to view.
2. NO HOLES — a gather fills every output pixel by construction; only
   the edge band the warp shifts in from may hold the padding value.
3. SMEAR signature — at a depth edge the gather stretches a neighbouring
   pixel across the gap (runs of identical horizontal pixels). Presence
   proves displacement is happening; a zero-disparity warp of a
   per-column-unique image has no such runs at all.
4. PARITY with the app's ``depthWarpFilterV5`` kernel — a scalar numpy
   port of the Metal code (bilinear sample at ``x - disp_map``, black
   outside the extent) must agree with the grid_sample implementation.

Runs on CPU (no CUDA extension, unlike splat.py).
"""

import math

import numpy as np
import pytest
import torch

from app.stages.gather import BOTH, LEFT, RIGHT, BackwardWarpStereo, backward_warp
from app.stages.video_depth_models import DEFAULT_PLACEMENT
from app.stages.video_stereo import _validate_modes
from app.stages.warp_modes import WARP_BACKWARD, WARP_FORWARD, validate_warp

torch.manual_seed(0)


def _reach_px(disp: float, width: int, stereo_mode: str, placement=DEFAULT_PLACEMENT) -> int:
    """Widest possible pull distance in pixels (max_disp × max|placement|)
    — the edge band that may legitimately hold the padding value."""
    max_disp = disp * width * (0.5 if stereo_mode == BOTH else 1.0)
    return int(math.ceil(max_disp * max(abs(placement[0]), abs(placement[1])))) + 1


def _foreground_scene(h=120, w=320, box=(20, 100, 100, 220)):
    """Grey background at depth 0 (far) carrying a white marker stripe;
    a large mid-grey square at depth 1 (near) carrying a black marker
    stripe at its centre. Markers sit far from any depth edge, so their
    displacement is the pure per-region disparity. (A gather warp reads
    the SOURCE depth at the OUTPUT pixel, so a silhouette edge is
    truncated on one side and dragged into the background on the other
    — that edge artefact is the smear, tested separately — but texture
    INSIDE a uniform-depth region shifts cleanly.)
    Returns (image, depth, fg_marker_x, bg_marker_x)."""
    y0, y1, x0, x1 = box
    image = torch.full((1, 3, h, w), 0.6)
    image[:, :, y0:y1, x0:x1] = 0.4
    fg_x = (x0 + x1) // 2
    image[:, :, y0:y1, fg_x - 1 : fg_x + 1] = 0.0  # black stripe inside the square
    bg_x = 40
    image[:, :, :, bg_x - 1 : bg_x + 1] = 1.0  # white stripe in the background
    depth = torch.zeros(1, 1, h, w)
    depth[:, :, y0:y1, x0:x1] = 1.0
    return image, depth, fg_x, bg_x


def _centroid_x(mask: torch.Tensor) -> float:
    ys, xs = torch.nonzero(mask, as_tuple=True)
    return xs.float().mean().item()


# ----------------------------------------------------------- 1. direction


@pytest.mark.parametrize("stereo_mode", [BOTH, LEFT, RIGHT])
def test_near_object_shifts_right_in_left_eye_and_left_in_right_eye(stereo_mode):
    image, depth, fg_x, bg_x = _foreground_scene()
    disp = 0.05  # 5% of width → 16 px full, 8 px per eye in "both"
    left, right, l_occ, r_occ = BackwardWarpStereo()(
        image, depth, disp, stereo_mode=stereo_mode, placement=DEFAULT_PLACEMENT
    )
    assert l_occ is None and r_occ is None

    _, _, h, w = image.shape
    max_disp = disp * w * (0.5 if stereo_mode == BOTH else 1.0)
    # DEFAULT_PLACEMENT = (-1.0, 0.5): the near square (depth 1) sits at
    # +0.5 × max_disp (pop-out); the far background at -1.0 × max_disp.
    expected_fg = DEFAULT_PLACEMENT[1] * max_disp  # +8 px in "both"
    expected_bg = DEFAULT_PLACEMENT[0] * max_disp  # -16 px in "both"
    src_fg = fg_x - 0.5  # 2-px stripes: centroid between the two columns
    src_bg = bg_x - 0.5

    def shifts(eye):
        row = eye[0].mean(0)  # (H, W)
        # search windows exclude the black edge band (also < 0.05) and
        # the square's silhouette edges
        lo, hi = fg_x - 40, fg_x + 40
        fg = _centroid_x(row[h // 2 : h // 2 + 1, lo:hi] < 0.05) + lo - src_fg
        bg = _centroid_x(row[2:3] > 0.95) - src_bg  # row 2: outside the square
        return fg, bg

    if stereo_mode in (BOTH, LEFT):
        fg, bg = shifts(left)
        assert fg > 0 > bg, f"left eye: near must move RIGHT ({fg:+.2f}px), far LEFT ({bg:+.2f}px)"
        assert fg - bg > 0, "near object must shift right RELATIVE to the background"
        assert abs(fg - expected_fg) < 0.6 and abs(bg - expected_bg) < 0.6, (fg, bg)
    else:
        assert left is None
    if stereo_mode in (BOTH, RIGHT):
        fg, bg = shifts(right)
        assert fg < 0 < bg, f"right eye: near must move LEFT ({fg:+.2f}px), far RIGHT ({bg:+.2f}px)"
        assert fg - bg < 0, "near object must shift left RELATIVE to the background"
        assert abs(fg + expected_fg) < 0.6 and abs(bg + expected_bg) < 0.6, (fg, bg)
    else:
        assert right is None


def test_background_moves_opposite_to_foreground():
    """Behind-screen content (negative placement) moves the other way from
    pop-out content — i.e. the placement sign is honoured, not just the
    eye sign. Track a bright background marker at depth 0."""
    h, w = 64, 256
    image = torch.zeros(1, 3, h, w)
    image[:, :, :, 200:204] = 1.0  # marker column, far plane
    depth = torch.zeros(1, 1, h, w)
    disp = 0.05
    left, right, _, _ = BackwardWarpStereo()(image, depth, disp, stereo_mode=BOTH)
    max_disp = disp * w * 0.5
    expected_bg_shift = DEFAULT_PLACEMENT[0] * max_disp  # -1.0 × max_disp
    src_cx = 201.5
    l_shift = _centroid_x(left[0].mean(0) > 0.5) - src_cx
    r_shift = _centroid_x(right[0].mean(0) > 0.5) - src_cx
    assert l_shift < 0 and abs(l_shift - expected_bg_shift) < 1.0, (l_shift, expected_bg_shift)
    assert r_shift > 0 and abs(r_shift + expected_bg_shift) < 1.0, (r_shift, expected_bg_shift)


def test_zero_disparity_is_identity():
    image = torch.rand(1, 3, 48, 96)
    depth = torch.rand(1, 1, 48, 96)
    left, right, _, _ = BackwardWarpStereo()(image, depth, 0.0, stereo_mode=BOTH)
    assert torch.allclose(left, image, atol=1e-5)
    assert torch.allclose(right, image, atol=1e-5)


# ------------------------------------------------------------ 2. no holes


@pytest.mark.parametrize("stereo_mode", [BOTH, LEFT, RIGHT])
def test_every_interior_pixel_is_filled(stereo_mode):
    """A gather has no disocclusion holes: inside the frame (excluding the
    band at each edge the warp can pull in from) no pixel may equal the
    zero padding value. The image is strictly positive so 0 can only
    come from padding."""
    h, w = 90, 400
    image = 0.25 + 0.75 * torch.rand(1, 3, h, w)
    # harsh depth: random hard-edged blobs + noise → many discontinuities
    depth = (torch.rand(1, 1, h // 6, w // 6) > 0.5).float()
    depth = torch.nn.functional.interpolate(depth, size=(h, w), mode="nearest")
    depth = (depth + 0.2 * torch.rand(1, 1, h, w)).clamp(0, 1)
    disp = 0.03
    left, right, l_occ, r_occ = BackwardWarpStereo()(image, depth, disp, stereo_mode=stereo_mode)
    assert l_occ is None and r_occ is None, "a gather warp must not report occlusion masks"

    band = _reach_px(disp, w, stereo_mode)
    for eye in (left, right):
        if eye is None:
            continue
        interior = eye[:, :, :, band : w - band]
        assert interior.numel() > 0
        holes = (interior.amax(dim=1) == 0.0).sum().item()
        assert holes == 0, f"{holes} interior pixel(s) hold the padding value"


def test_edge_band_is_black_not_replicated():
    """The deliberate padding choice: the region shifted in from outside
    the frame is left as a black band (matches the app's Core Image
    sampler and the forward warp's inpaint='none' edges), not a smear of
    the edge column."""
    h, w = 32, 200
    image = torch.ones(1, 3, h, w)
    depth = torch.zeros(1, 1, h, w)  # everything at the far plane: uniform shift
    disp = 0.05
    left, right, _, _ = BackwardWarpStereo()(image, depth, disp, stereo_mode=BOTH)
    shift = 0.5 * disp * w * abs(DEFAULT_PLACEMENT[0])  # 5 px
    # left eye: far content moves LEFT → source read at x + 5 → the LAST
    # 5 columns fall outside the extent
    eps = 1e-5  # grid_sample normalisation round-off
    assert torch.all(left[:, :, :, w - int(shift) :] < eps)
    assert torch.all(left[:, :, :, : w - int(shift) - 1] > 1 - eps)
    # right eye: mirror
    assert torch.all(right[:, :, :, : int(shift)] < eps)
    assert torch.all(right[:, :, :, int(shift) + 1 :] > 1 - eps)


# -------------------------------------------------------------- 3. smear


def _longest_identical_run(row: np.ndarray) -> int:
    """Longest run of consecutive identical pixel values along a row
    (row: (W, C))."""
    same = np.all(row[1:] == row[:-1], axis=1)
    best = cur = 0
    for s in same:
        cur = cur + 1 if s else 0
        best = max(best, cur)
    return best + 1 if best else 1


def test_depth_edge_smears_a_neighbour_across_the_gap():
    """2560×1440 @ disparity 0.010 (the app's measured case). The image
    is unique per column so identical runs can only come from the warp
    stretching one source column across a depth-edge gap. A depth ramp
    whose slope makes x - disp(x) stationary is exactly that gap.
    Sanity: with zero disparity there are no runs at all."""
    h, w = 1440, 2560
    cols = torch.linspace(0, 1, w).view(1, 1, 1, w)
    image = torch.cat([cols, 1 - cols, (cols * 7) % 1], dim=1).expand(1, 3, h, w).contiguous()
    disp = 0.010
    max_disp = 0.5 * disp * w  # 12.8 px per eye
    gap = (DEFAULT_PLACEMENT[1] - DEFAULT_PLACEMENT[0]) * max_disp  # 19.2 px
    # depth ramps 0→1 over exactly `gap` px around x=1200: the source
    # coordinate is stationary across the ramp → one column stretched
    x0 = 1200
    ramp = ((torch.arange(w).float() - x0) / gap).clamp(0, 1)
    depth = ramp.view(1, 1, 1, w).expand(1, 1, h, w).contiguous()

    left, _, _, _ = BackwardWarpStereo()(image, depth, disp, stereo_mode=BOTH)
    row = (left[0, :, h // 2].permute(1, 0) * 255).round().to(torch.uint8).numpy()
    run = _longest_identical_run(row[100:-100])
    assert run >= int(gap) - 1, f"expected a ≥{int(gap) - 1}px smear at the depth edge, longest run {run}px"

    ident, _, _, _ = BackwardWarpStereo()(image, depth, 0.0, stereo_mode=BOTH)
    row0 = (ident[0, :, h // 2].permute(1, 0) * 255).round().to(torch.uint8).numpy()
    assert _longest_identical_run(row0[100:-100]) <= 2, "no displacement → no smear"


# ------------------------------------------------- 4. parity with the app


def _metal_v5_reference(image: np.ndarray, depth: np.ndarray, disp: float, far: float, near: float) -> np.ndarray:
    """Scalar port of depthWarpFilterV5 (CIKernels.metal): per output
    pixel, disp_map = max_disp * (depth*(near-far)+far), sample the
    source bilinearly at (x - disp_map, y); outside the extent → black.
    image (H, W, C) float, depth (H, W) float. Pixel centres at i+0.5 in
    Core Image space; sampling at integer-index offsets is equivalent."""
    h, w, c = image.shape
    out = np.zeros_like(image)
    max_disp = disp * w
    for y in range(h):
        for x in range(w):
            d = np.clip(depth[y, x], 0.0, 1.0)
            disp_map = max_disp * (d * (near - far) + far)
            xs = x - disp_map
            x0 = int(np.floor(xs))
            t = xs - x0
            px = np.zeros(c)
            for xi, wgt in ((x0, 1 - t), (x0 + 1, t)):
                if 0 <= xi < w and wgt > 0:
                    px += wgt * image[y, xi]
            out[y, x] = px
    return out


def test_matches_a_scalar_port_of_the_metal_kernel():
    h, w = 24, 64
    image = torch.rand(1, 3, h, w)
    depth = torch.rand(1, 1, h, w)
    disp, far, near = 0.06, DEFAULT_PLACEMENT[0], DEFAULT_PLACEMENT[1]

    left, right, _, _ = BackwardWarpStereo()(image, depth, disp, stereo_mode=BOTH, placement=(far, near))
    img_np = image[0].permute(1, 2, 0).numpy().astype(np.float64)
    dep_np = depth[0, 0].numpy().astype(np.float64)
    # the app calls the kernel with +shift/2 for the left eye and -shift/2
    # for the right eye in dual-eye mode (ImageEffectsService.swift)
    ref_left = _metal_v5_reference(img_np, dep_np, +disp / 2, far, near)
    ref_right = _metal_v5_reference(img_np, dep_np, -disp / 2, far, near)
    np.testing.assert_allclose(left[0].permute(1, 2, 0).numpy(), ref_left, atol=1e-5)
    np.testing.assert_allclose(right[0].permute(1, 2, 0).numpy(), ref_right, atol=1e-5)


# --------------------------------------------------------- interface


def test_accepts_uint8_and_runs_on_any_device():
    image = (torch.rand(2, 3, 20, 40) * 255).to(torch.uint8)
    depth = torch.rand(2, 1, 20, 40)
    left, right, _, _ = BackwardWarpStereo()(image, depth, 0.02)
    assert left.shape == right.shape == (2, 3, 20, 40)
    assert left.dtype == torch.float32 and 0.0 <= left.min() and left.max() <= 1.0


def test_backward_warp_primitive_subtracts_the_disparity():
    """out[x] = image[x - d]: a constant +3px map reads 3 px to the LEFT."""
    image = torch.arange(10.0).view(1, 1, 1, 10)
    out = backward_warp(image, torch.full((1, 1, 1, 10), 3.0))
    assert torch.allclose(out[0, 0, 0, 3:], image[0, 0, 0, :7], atol=1e-5)
    assert torch.all(out[0, 0, 0, :3].abs() < 1e-5)


# ----------------------------------------------------------- job params


def test_backward_warp_rejects_inpainting():
    validate_warp(WARP_FORWARD, "propainter")
    validate_warp(WARP_BACKWARD, "none")
    validate_warp(WARP_BACKWARD)  # still images: no inpaint knob
    with pytest.raises(ValueError, match="no occlusion masks"):
        validate_warp(WARP_BACKWARD, "propainter")
    with pytest.raises(ValueError, match="no occlusion masks"):
        validate_warp(WARP_BACKWARD, "m2svid")
    with pytest.raises(ValueError, match="unknown warp"):
        validate_warp("gather", "none")


def test_video_worker_validation_is_orthogonal_to_inpaint():
    _validate_modes("none", "both", WARP_BACKWARD)
    _validate_modes("propainter", "both", WARP_FORWARD)
    _validate_modes("none", "left", WARP_FORWARD)
    with pytest.raises(ValueError, match="no occlusion masks"):
        _validate_modes("propainter", "both", WARP_BACKWARD)
    with pytest.raises(ValueError, match="unknown inpaint"):
        _validate_modes("backward", "both", WARP_FORWARD)  # not overloaded onto inpaint


def test_migan_mode_validation():
    # migan is a FORWARD-warp fill: fine with forward, contradiction with
    # backward (a gather has no holes), unknown values still rejected
    _validate_modes("migan", "both", WARP_FORWARD)
    with pytest.raises(ValueError, match="no occlusion masks"):
        _validate_modes("migan", "both", WARP_BACKWARD)
    with pytest.raises(ValueError, match="unknown inpaint"):
        _validate_modes("lama", "both", WARP_FORWARD)


def test_migan_tiling_roundtrip():
    from app.stages.migan_runner import _tile, _untile
    x = torch.rand(3, 4, 1024, 1024)
    t = _tile(x)
    assert t.shape == (12, 4, 512, 512)
    # row-major tiles: tile 0 is the top-left quadrant
    assert torch.equal(t[0], x[0, :, :512, :512])
    assert torch.equal(t[3], x[0, :, 512:, 512:])
    assert torch.equal(_untile(t, 3), x)
