# v7: Dual-Resolution 4K Splat — Spec

**Branch:** `v7-dualres-4k-splat`
**Status:** IMPLEMENTED (steps 1-5) + GPU-VERIFIED ✅ (job 96269ef2e213 on
dev — ekr2 4K clip, output_res=2160 + inpaint_res=720 + target_fps=12):
- #1 frame-count/AV sync: splat 144f@3840x2160 == work 144f@1280x720 ✓
- #2 depth↔4K alignment: a depth-rich frame inspected — sharp 4K detail on
  subjects, clean depth edges, NO ghosting/doubling ✓
- #3 4K splat VRAM: routed to H200 by splat pixels (8.29M), no OOM ✓
- end-to-end: 7680x2160 SBS, 144f, completed; splat surface published
  (preprocess_splat.mp4) + registered for reuse ✓
- engaged correctly ("🪟 splat@3840x2160, inpaint@1280x720").
Default path (no inpaint_res) byte-identical (logic-traced). READY TO
MERGE. M2SVid 4K path implemented but NOT GPU-tested (fixed GPU, may need a
VRAM bump for 4K) — ProPainter is the verified path.

## Goal

Decouple the three pipeline resolutions so the expensive perceptual work
runs cheap while the output stays high-res:

- **depth** at depth_res (e.g. short-side 1148)
- **inpaint** (ProPainter / M2SVid fill) at inpaint_res (e.g. short-side 720)
- **splat + composite** at output_res (e.g. 4K / short-side 2160)

The forward-warp is a geometric horizontal pixel shift; disparity comes
from depth (low-frequency, fine at low res). So splatting the FULL-res
frame preserves all output-res detail in non-occluded regions (~95% of the
frame); only the disocclusion HOLES (<5%, at depth edges) carry
upscaled-from-inpaint-res fill. ProPainter/M2SVid never see the full frame
— only the holes, filled at inpaint_res, upscaled into the output-res warp.

Net: 4K output at a fraction of true-4K cost (depth+inpaint stay low-res).

## Resolution model

Three work surfaces, derived in preprocess + threaded through:

| name | resolution | used by |
|------|-----------|---------|
| `work_path` | inpaint tier (depth_res-ish; current behavior) | depth, ProPainter fill |
| `splat_path` | output_res (trimmed + fps-decimated, NOT downscaled to inpaint tier) | splat + composite |

Both come from the SAME trim + fps decimation, so they have IDENTICAL frame
counts (CONCERN #1 — non-negotiable for AV sync). `splat_path` is just
`work_path` at a higher scale; if output_res == work res, splat_path ==
work_path (no dual-res, byte-identical to today).

Trigger: dual-res engages when `output_res` (or the source, if no
downscale) is larger than the inpaint working res. Default path
(output == inpaint res) is UNCHANGED — existing runs stay byte-identical.

## Concerns + mitigations (from the design review)

1. **Frame-count invariant (AV sync).** splat_path and work_path MUST have
   the same frame count. Guaranteed by deriving BOTH from the same
   trim+fps-decimation in preprocess. The existing
   `stereo.num_frames == preprocess.num_frames` assert is kept and must use
   the splat_path frame count (the output frame count).
   → splat_path is SAVED + made reusable (preprocess_key extended; see Reuse).

2. **Depth ↔ frame spatial alignment.** Depth (computed at depth_res on
   work_path) must upscale to EXACTLY the splat frame's (H, W) and the same
   FOV/crop. work_path and splat_path share aspect+crop (same source, same
   crop, different scale), so upscaling depth to splat_path dims aligns
   pixel-for-pixel. The stereo worker's `to_source` resize must target
   splat-res, and depth upscales to splat-res. VERIFY on GPU (this is the
   test the feature branch exists for).

3. **VRAM / GPU routing.** 4K splat/composite buffers are ~4× larger.
   Route stereo GPU by output_res pixel count (H200 for 4K). Inpaint VRAM
   unchanged (stays inpaint_res). Per-batch 4K warp tensors are the new
   pressure → may need smaller batch_size at 4K.

4. **Compose with the rest of v7.** target_fps (4K work file decimated
   identically), orientation (4K portrait splat), the resolution knobs
   (output_res→splat, inpaint_res→fill), auto-reuse (preprocess key now
   implies work_path AND splat_path).

5. **M2SVid parity.** M2SVid has its own `_compose` with the same
   splat-at-source / fill-at-model-res structure. Apply dual-res there too
   if not too complex; else its own branch.

## Reuse

- preprocess_key already keys (input_path, remove_black_bars, output spec,
  target_fps, trim). Dual-res adds the splat_path as a SECOND published
  artifact (`outputs/<job>/splat.mp4`) under the same key (the work file is
  `preprocess.mp4`). Both reused together on a key hit.
- depth reuse unchanged (depth still computed on work_path at depth_res).

## Implementation order (commit at each)

1. **Spec** (this file). ✓
2. **preprocess dual-output**: produce splat_path (output_res) alongside
   work_path (inpaint res) when they differ; publish+register both.
3. **stereo worker (ProPainter)**: accept a separate splat video + splat
   dims; splat & composite at splat-res, downscale warp→inpaint-res for the
   fill, composite back at splat-res. Flag-gated; default path unchanged.
4. **pipeline wiring**: thread splat_path + output_res; H200 routing by
   output pixel count; frame-count assert on splat dims.
5. **M2SVid**: same treatment (or defer to its own branch).
6. **on-GPU verification**: a real 4K clip; check frame count, AV sync,
   alignment (no ghosting), VRAM. Only then merge to main.

## Default-path safety

When output_res ≤ inpaint res (no dual-res), splat_path is None and the
worker uses work_path for both splat and inpaint exactly as today → output
byte-identical to pre-v7. This is the regression guard.
