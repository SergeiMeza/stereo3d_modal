# v4 tuning notes (in progress — user collecting feedback)

Status: NOT YET IMPLEMENTED. v3 batch still running. Apply v4 after v3 lands
and user finishes their notes.

## Note 1 — wide shots: continuous displacement ramp-down by depth (2026-06-14)

**Observation (user):** first shot of the dance video (frames [0,129)) — dancers
fill ≤50% of frame height against a flat red wall. Classified `wide`,
median **14.9m**, displacement **0.007** (current v2/v3 wide value). The disparity
is **too large** → big disocclusion holes → ProPainter inpainting fails (smeared
faces, lost detail on zoom). Screenshot: left eye, faces lose key detail.

**Diagnosis:**
- It's **displacement** (hole size), NOT placement/plane. Bigger displacement =
  bigger holes = more inpainting = more failures. Plane only redistributes.
- The `wide` bucket is **too coarse**: dance wides span median **11m–26m**, all
  lumped at one displacement (0.007). An 11m wide (figures visible) and a 26m
  wide (tiny specks) have opposite disocclusion needs. Far figures against plain
  backgrounds starve the inpainter most.
- Insight: for FAR shots, MORE distance should mean LESS displacement (far figures
  read as far with little parallax anyway; and holes can't be filled).

**Decision (user chose "continuous ramp-down"):** within the `wide` class, scale
displacement DOWN as median depth increases — no new bucket, smooth, no cutoff.
Proposed formula:
```
wide_disp = clamp(0.008 - (median_m - 11)/15 * 0.004, 0.004, 0.008)
# 11m->0.008, 15m->0.0069, 20m->0.0056, 26m->0.0040
```

**OPEN CAVEAT (flag to user):** at 14.9m the formula gives 0.0069 ≈ the current
0.007 — i.e. it barely changes the EXACT shot the user complained about; it mostly
helps farther (20m+) shots. So either (a) make the ramp steeper / start the
ceiling lower (e.g. base 0.006, so 15m→~0.005), or (b) confirm whether 0.007 is
the problem at 15m or whether the real culprit is flat-background starvation
(→ disocclusion-aware displacement, "Proposal D"). NEED USER INPUT on how much to
cut at the 15m point specifically.

**Implementation location:** `app/stages/video_depth_models.py` — currently
`SHOT_PARAMS["wide"]` is a fixed dict. Ramp needs the per-shot `median_depth`
(meters, from depth-pro profiler) at the point displacement is assigned in
`_build_depth_script` / classification. Only applies when units=="meters"
(depth-pro profiler); da3-metric units have no true meters.

## Reminder: v4 testing should REUSE DEPTH (tuning doesn't change depth maps).
Depth-source jobs: dance 9b8755a938c6, webm2 01afb4997eb2, K9 d9ac72b5bed4,
awkky d1b7ba2c02b5. Run STAGGERED/sequential (CUDA-init thundering herd — see
stereo3d-hard-won-fixes memory).

## Note 2 — dynamic shots over-displace at a far end (2026-06-14)

**User question:** "for dynamic shots displacement is 0.0085 — if the shot ends
really far, will it still have that disparity?"

**Finding:** The top-level `displacement` (0.0085) is a FALLBACK; the `keyframes`
array is what actually drives stereo (worker interpolates displacement/placement
between keyframes by frame index). BUT each keyframe is classified by the same
per-keyframe `_classify_keyframe` → it gets a COARSE bucket value (wide=0.007 flat,
standard=0.009 flat) regardless of *how* far that keyframe is. So:
- A dynamic shot that pushes to far DOES taper *if* keyframes land in different
  buckets — but within a bucket it's flat.
- A keyframe at 25m gets the same wide-0.007 as a keyframe at 11m → same
  "wide bucket too coarse" problem, now INSIDE the dynamic ramp.
- Observed: dance dynamic shot [677,743) has all 3 keyframes identical (0.009),
  so its "ramp" is actually flat — labeled dynamic by depth-SPREAD but keyframes
  didn't diverge in class.

**Implication for v4:** the continuous wide depth-ramp-down (Note 1) MUST be applied
PER-KEYFRAME, not just to static wide shots. Make the ramp-down a shared function
of median_depth used by BOTH (a) wide static shots and (b) every dynamic keyframe.
Then a dynamic shot ending far will smoothly taper its displacement down at the far
end instead of holding a coarse bucket value.

## v4 direction (confirmed by user, 2026-06-14):
- NOT the v3 bump-up (wrong direction for far shots).
- Tune v2 DOWN for mid/wide, AND add the continuous wide ramp-down (Note 1),
  applied per-keyframe for dynamic shots (Note 2).
- Still TBD: exact mid/standard target (v2 is 0.009 → lower to ~0.007?) and how
  steep/low the wide ramp bottoms (the 15m caveat in Note 1).
