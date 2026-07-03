# Inpainting + depth backend comparison — 10s scene-cut clip (2026-06-13)

A–D: clip_10s_scenes_1080p.mp4, input_size 980. E–H: same clip at qhd preset
(2560×1440, input_size 1148). All: formats sbs+mvhevc (x265 spatial).

Geometry note: B and C are right-eye-only (left = original, FULL displacement);
A, D, H are symmetric both-eye (half displacement each) — both-eye vs single-eye
depth "feel" differs by design.

| run | res | inpaint | stereo_mode | depth | stereo stage | stage cost |
|---|---|---|---|---|---|---|
| A | 1080p | ProPainter | both | VDA | 384s L40S | ~$0.21 |
| B | 1080p | ProPainter | right | VDA | 231s L40S | ~$0.13 |
| C | 1080p | M2SVid | right (native) | VDA | 133s A100-80GB | ~$0.09 |
| D | 1080p | ProPainter | both | DA3-metric | (depth 103s vs VDA 88s) | — |
| E | qhd | M2SVid | right (native) | VDA | 139s A100-80GB | ~$0.10 |
| F | qhd | ProPainter | right | VDA | ~310s L40S | ~$0.17 |
| G | qhd | ProPainter | right | DA3 (fixed align) | 414s L40S | ~$0.23 |
| H | qhd | M2SVid | both (mirror trick) | VDA | 239s A100-80GB | ~$0.17 |

Frame-level findings:
- ProPainter (B): cleaner silhouettes; mild flow-fill smear in holes.
- M2SVid (C): ~3x faster; visible white "fuzz" hallucination along high-contrast
  disocclusion stripes (512-tier working res). Milder at qhd (E). Levers: higher
  work res, or the no_full_attention checkpoint variant.
- M2SVid both-eye (H): left eye synthesized via horizontal-mirror trick
  (left-reference model reused); verified genuinely synthesized (mean |diff| vs
  pristine = 12.9; the earlier stale-container run showed 0.89 = passthrough).
  Stereo cost ~2x single-eye (239s vs 133s), as expected.
- DA3 depth (G): needed two fixes — per-scene alignment anchored to the scene's
  FIRST frame with a scale guard (chained alignment collapsed to flat gray), and
  p0.5/p99.5 percentile normalization (min-max was crushed by outlier frames).
  Verified healthy after fix: t=9.5 std 19.8, range [36,186].
- DA3-metric (D): consistent cross-scene disparity (job-wide p1/p99 range), but
  a model failure on the end scene — closest dancer predicted as far (solid
  black), not a pipeline overflow. Relative mode immune.

DECISION (Sergei, 2026-06-13): depth model = **VDA only for now**. DA3/DA3-metric
endpoints stay available but unused; da3-metric is still used internally by the
adaptive depth-script profiler (analysis keyframes only — final depth is VDA).
Depth Pro stays on branch depth-pro-backend, unmerged.

TO JUDGE ON DEVICE (queued for Sergei):
1. A vs B vs C spatial .movs — temporal behavior of M2SVid (window seams every
   25 frames?) vs ProPainter; edge fuzz visibility in headset.
2. E vs F — at qhd, is M2SVid fuzz acceptable given the 2x speed/cost advantage?
3. H — both-eye M2SVid: symmetric depth feel + any mirror-trick artifacts in the
   left eye (text/logos would mirror-degrade most).
4. All should carry the spatial badge (x265 + vexu).
After this check: previews/ gets reorganized (v1 baseline vs adaptive v2/v3).
