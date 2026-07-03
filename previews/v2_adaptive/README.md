# v2 adaptive depth-script previews — 1-minute clips with audio (2026-06-13)

First outputs of the adaptive per-shot depth script with the v2 "pro treatment"
(depth-matched cuts, comfort budget, dynamic-shot ramps). All qhd preset
(input_size 1148), ProPainter both-eye, VDA depth, audio muxed from source
(av_sync 8.3 ms on both), sbs + mvhevc (x265 spatial).

| clip | job | source | shots | notes |
|---|---|---|---|---|
| dance_60s | 06af91669111 | clip_60s_scenes_2160p (16:9) | 32 | depth 680s L40S, stereo 2382s L40S |
| letterbox_60s | af411d52f76d | letterbox_60s_2160p (2.31:1 after bar crop) | 34 | depth 975s A100-80GB (aspect-routed), stereo 2250s L40S |
| dance_10s (script only) | a91a5214699c | clip_10s_scenes_2160p | 6 | v1-vs-v2 diff reference |

Each *_depth_script.json is the per-shot decision log: shot class,
displacement, placement, salient screen disparity at both boundaries
(screen_disp_in/out), and an `adjustments` list naming every v2 intervention
(placement shifts to match cuts, clamp flags, displacement step/comfort
clamps). Dynamic shots carry per-keyframe ramps ("keyframes").

What v2 did on these clips:
- dance_60s: placement matched at ~20 of 31 cuts; the three wide shots got
  raised placements (e.g. (-0.71, 0.29)) so distant content stays near the
  convergence depth of the surrounding shots; one dynamic shot ramps
  standard→close_up params over 42 frames; close-up cuts at frames 354/423/657
  hit the shift clamp (large salient jumps — reduced, residual flagged).
- letterbox_60s: bars (3840:2160 → 3840:1664, crop 0:248) removed before
  profiling so they never pollute depth; 34 mostly close-up shots, placement
  matched at ~18 cuts, 4 clamp flags, 2 dynamic shots with ramps.

HEADSET CHECKLIST (v2-specific):
1. Cuts: does convergence feel continuous across scene cuts (vs the v1-era
   previews in compare/ where each cut re-centered the depth budget)?
2. Wide shots in dance_60s (frames 60-132, 1093-1180, 1226-1439): deeper but
   all-behind-screen — comfortable?
3. Close-ups: pop-out is capped (placement upper ≤ 0.1 or matched lower) —
   does the reduced pop-out read as safer or as flat?
4. Dynamic-shot ramps: any visible depth "breathing" inside shots 615-657
   (dance) where params interpolate?
5. Letterbox clip: any edge artifacts at the crop boundary; audio sync.

Baseline (fixed global displacement/placement) comparisons live in
previews/compare/ (A–H, 10s clips). v3 (Depth Pro profiler: true-meters
thresholds + FOV modifier) is implemented on branch adaptive-v3-fov, not yet
deployed — its A/B against these should reuse the same two 60s inputs.
