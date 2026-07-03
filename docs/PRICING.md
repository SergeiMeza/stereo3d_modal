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

| GPU       | $/sec    | $/hr  | role in routing                                                   |
| --------- | -------- | ----- | ----------------------------------------------------------------- |
| L40S      | 0.000542 | $1.95 | cheapest; depth ≤2.5 working-MP, per-frame depth models, small stereo |
| H200      | 0.001097 | $3.95 | depth 2.5–6.5 working-MP, big stereo (>720p inpaint work res or >1440p splat) |
| B200      | 0.001736 | $6.25 | VRAM-ceiling tier, depth 6.5–8.5 working-MP only (cu128 image). NOT cost-competitive ≤H200: ~0.74× H200 throughput at 58% higher $/s |
| L4        | 0.000222 | $0.80 | `encode_mvhevc` NVENC path only (fixed-function; bigger GPUs add nothing) |
| A10G      | 0.000306 | $1.10 | image pipeline (DA2-Large + LAMA)                                 |
| A100-80GB | 0.000944 | $3.40 | **not in depth routing (reference only)** — H200 faster & ~cost-neutral; still pinned by the deprecated M2SVid stereo worker |
| A100 40GB | 0.000694 | $2.50 | **not in routing (reference only)**                               |
| H100      | 0.001097 | $3.95 | **not in routing** (same rate as H200; reference only)            |
| T4        | 0.000164 | $0.59 | **not in routing (reference only)**                               |

CPU-only stages (preprocess, encode_outputs, encode_mvhevc_x265) priced on
cpu+mem seconds, not GPU.

### Depth tier boundaries — working megapixels

The depth GPU is picked by **working megapixels**, not depth_res alone
(`_route_depth_gpu` in `app/pipelines/video.py`):

    work_mp = depth_res² × elongation / 1e6   (elongation = long/short ≥ 1)

L40S ≤ **2.5** MP < H200 ≤ **6.5** MP < B200 ≤ **8.5** MP; above 8.5 MP the
job fails fast. On a 16:9 source that's roughly depth_res ≤1184 → L40S,
≤1912 → H200; the same depth_res costs a different tier on a different
aspect (e.g. 2100 on 1:1 = 4.41 MP fits H200; 2100 on 2.39:1 = 7.84 MP
needs B200).

### Cost formula (`estimate_cost`, rates revision `2026-06-15`)

Per stage: `seconds × (gpu_rate + cpu_cores × $0.0000131 +
mem_gib_ceiling × $0.00000222)` — CPU is $0.0000131/core/s (~$0.047/hr),
memory $0.00000222/GiB/s (~$0.008/GiB/hr), billed at the function's
memory **limit** (conservative ceiling). Unknown GPUs are flagged
(`gpu_unpriced`), never silently $0. Every breakdown carries
`rates_revision` (`RATES_REVISION = "2026-06-15"`) so stale rates are
detectable.

## Per-frame cost — measured (V5bVtAej1hs, 4K source)

### A) Depth-res sweep — 60s @ 6fps = **360 frames**, inpaint=none, dual-res splat

> **HISTORICAL** (measured under the old `eff_size` routing with an A100
> tier). Routing is now working-MP based with A100 dropped: the d1442
> rows (3a/3b, 3.70 working-MP on this 16:9 source) would route to
> **H200** today. The measurements remain valid throughput/cost data for
> the GPU they actually ran on; only the *routing* column is outdated.

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

### C) Depth GPU tier — same workload, per-frame (30s clip, 360 frames)

The depth stage in isolation, to show the GPU-tier cost step. B200 only
runs above the H200 VRAM ceiling (>6.5 working-MP), so its row is at the
higher depth_res it exists to serve — it is NOT a cheaper way to do work
H200 already fits.

| GPU  | depth_res | working-MP | depth s | s/frame | $/frame (depth) | note |
| ---- | --------- | ---------- | ------- | ------- | --------------- | ---- |
| H200 | 1806      | 5.80       | 321.42  | 0.893   | 0.000980        | proven max for H200 |
| B200 | 2100      | 7.84       | 415.91  | 1.155   | 0.002006        | OOMs on H200; B200-only |

B200 depth runs ~2.05× the per-frame cost of H200's max — partly more
pixels (2100² vs 1806² = 1.35×), partly the 58%-higher $/s. At *equal*
resolution B200 would still lose: ~0.74× H200 throughput. Use B200 only
when the work won't fit H200 at all.

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
- Second data point (2026-07-03, job c51480d2c0aa — 4k stereo preview,
  depth reused, OOMed at 78% with chunk retries): dashboard billed
  **$14.31** vs ~$11.2 estimate-sum (~1.28×; retries inflate it —
  steady-state is ~1.2×). **Pricing doctrine**: gateway rate defaults
  target ≈2× BILLED (≈2.4× the in-source estimate), since billed is what
  we actually pay. High-preset stereo rates were recalibrated against
  this run; refine per-preset as clean billed/estimate pairs accumulate.
