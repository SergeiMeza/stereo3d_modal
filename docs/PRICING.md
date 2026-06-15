# Pipeline Pricing — measured cost reference

All figures are **in-source ESTIMATES** (per-stage `seconds × Modal $/s`,
from the cost-estimation feature), validated against billed hourly totals.
Estimates are the right unit for COMPARING runs; billed hour adds
cold-start + idle overhead (see "Estimate vs billed" below).

> **Per-frame is the standardized unit.** Cost scales with FRAME COUNT
> (= duration × fps), so always normalize by frames to compare across
> clips of different length/fps. `target_fps` is the single biggest cost
> lever — halving fps ≈ halves frames ≈ halves cost.

## Modal GPU rates ($/second) — `app/common/pricing.py`

| GPU       | $/sec    | $/hr  | notes                                                            |
| --------- | -------- | ----- | ---------------------------------------------------------------- |
| L40S      | 0.000542 | $1.95 | cheapest; depth ≤2.5 working-MP, small stereo                    |
| A100-80GB | 0.000944 | $3.40 | **dropped from routing** — H200 faster & ~cost-neutral           |
| H200      | 0.001097 | $3.95 | depth 2.5–6.5 MP, all 4K stereo/splat                            |
| H100      | 0.001097 | $3.95 | (same rate as H200)                                              |
| B200      | 0.001736 | $6.25 | VRAM ceiling tier — **not yet usable** (xformers sm_100 pending) |

CPU-only stages (preprocess, encode_outputs, encode_mvhevc_x265) priced on
cpu+mem seconds, not GPU.

## Per-frame cost — measured (V5bVtAej1hs, 4K source)

### A) Depth-res sweep — 60s @ 6fps = **360 frames**, inpaint=none, dual-res splat

| job | depth_res | output | $/frame  | $/1000-frames | total (360f) | depth GPU              |
| --- | --------- | ------ | -------- | ------------- | ------------ | ---------------------- |
| 1a  | 714       | 1440p  | 0.000267 | $0.27         | $0.096       | L40S                   |
| 1b  | 714       | 4K     | 0.000949 | $0.95         | $0.342       | L40S depth, H200 splat |
| 2a  | 1078      | 1440p  | 0.000771 | $0.77         | $0.277       | L40S                   |
| 2b  | 1078      | 4K     | 0.001181 | $1.18         | $0.425       | L40S depth, H200 splat |
| 3a  | 1442      | 1440p  | 0.001343 | $1.34         | $0.484       | A100 (old routing)     |
| 3b  | 1442      | 4K     | 0.001808 | $1.81         | $0.651       | A100 depth, H200 splat |
| 4a  | 1806      | 1440p  | 0.001295 | $1.30         | $0.466       | H200                   |
| 4b  | 1806      | 1800p  | 0.001641 | $1.64         | $0.591       | H200                   |
| 4c  | 1806      | 4K     | 0.001912 | $1.91         | $0.688       | H200                   |

### B) 4K in/out, **12 fps**, full 138s clip = **1663 frames**

| variant                   | depth    | $/frame  | $/1000-frames | total (1663f) |
| ------------------------- | -------- | -------- | ------------- | ------------- |
| d1078, inpaint=none       | computed | 0.001078 | $1.08         | $1.79         |
| d1806, inpaint=none       | computed | 0.001591 | $1.59         | $2.65         |
| d1078, **ProPainter**@720 | reused   | 0.001847 | $1.85         | $3.07         |
| d1806, **ProPainter**@720 | reused   | 0.001844 | $1.84         | $3.07         |

## What drives cost — the levers, biggest first

1. **Frame count (target_fps × duration)** — linear. 60→6fps decimation was
   the single biggest saver in every test. ALWAYS the first lever.
2. **inpaint model** — ProPainter adds ~**$0.0008/frame** over raw warp (its
   stereo stage ~$2.92 vs raw ~$0.85 on the 1663-frame clip; ~7 H200 chunks
   × ~280s). The quality premium (A/B: ProPainter 10 vs raw 9). M2SVid is
   deprecated (net-harmful per A/B test 1).
3. **depth_res** — depth is the dominant, fastest-scaling GPU stage. 1078→1806
   ~DOUBLED depth cost (more pixels + L40S→H200 tier jump). Per-frame, depth
   went ~$0.0008→$0.0016 for that bump on the full clip.
4. **output_res (4K splat)** — 4K splat/composite routes to H200 and adds a
   roughly fixed per-frame premium (~$0.0007/frame) over 1440p, fairly flat
   vs depth_res (the splat reads output-res frames + upscaled depth either
   way). See dual-res: depth+inpaint stay cheap, only the splat is 4K.

## Per-frame depends on length (fixed overhead amortization)

Note the SAME depth_res gives different $/frame between the 360-frame sweep
and the 1663-frame clip — because fixed per-job overhead (preprocess,
profile_scenes, cold-start, encode setup) amortizes over more frames on the
longer clip. So:

- **Short clips** carry MORE per-frame overhead — budget higher $/frame.
- **At scale (1000s of frames)**, $/frame converges toward the marginal
  (per-frame depth + stereo + encode) cost. Use the **full-clip B table**
  for production budgeting, the **sweep A table** for short previews.

## Reuse economics

`reuse_depth_from` / content-addressed auto-reuse makes the DEPTH stage
free on re-runs (the expensive part). ProPainter runs above reused $1078
and $1806 depth both cost ~$3.07 — i.e. **depth_res doesn't affect inpaint
cost once depth is reused**; only the inpaint+splat work remains. Tuning
iterations (same depth, vary inpaint/displacement) get the depth pass for
free.

## Inpaint-area ↔ cost link

Disocclusion hole area ∝ `displacement × (near − far)` per shot (the
disparity span across depth edges). ProPainter's per-chunk time scales with
fill area, so reducing holes reduces inpaint cost ~proportionally. Pulling
the far plane in on WIDE shots only (median>10m, ~no pop-out) cut the
V5b hole-area proxy ~10% at near-zero 3D-volume loss → ~10% off the ~$2.92
ProPainter stereo cost (~$0.30/run). See the v6 per-shot far-plane work.

## Estimate vs billed

- Per-job **estimates** = sum of `stage_seconds × rate` — per-variant, no
  API lag. Use for comparison.
- **Billed** (Modal `workspace_billing_report`) is HOURLY only (minute
  rejected), lags real-time (current hour often reads $0 until it closes),
  rate-limited (~2 calls/10s). One A/B run's hour billed $6.92 vs $4.02
  estimate-sum — the gap is cold-start + idle drain + a cancelled attempt.
  scaledown_window is 30s everywhere (cold-start vs idle tradeoff).
