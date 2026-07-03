# v7 Test Summary (2026-06-15)

Manual-review bundle for the v7 GPU validation. All jobs ran on **dev**
(`stereo-crafter-dev`, app `stereo3d-stg`).

## (a) Main features — smoke test (deployed from `main`)

Source: `2Vv-BfVoq4g.webm` (1080p, has letterbox bars), first 20 s.
Request: `preset=qhd, target_fps=12, to_sec=20, adaptive, depth-pro, propainter`.

| Job | What it tested | Result |
|-----|----------------|--------|
| `25283a70534f` | target_fps decimation + bars + reuse-register | ✅ preprocess.mp4 = 1920x800 (bars removed), **12000/1001 fps, 240 frames** (20s×12); published + registered |
| `e5e560d65f01` | content-addressed AUTO-REUSE (identical request) | ✅ logs: `♻️ preprocess auto-reuse HIT` + `♻️ scene-cut auto-reuse HIT (7 scenes)` — skipped preprocess + scene detect, **no job id passed**, Slack-notified |

Same preprocess key on both jobs (`preprocess:db2b36a02a49bf882cde3bce`)
→ key is deterministic. → files `job_25283a70534f.json`, `job_e5e560d65f01.json`.

Bug found + fixed during this step: stacked `@app.function` decorators
(deploy-blocking) — main commit `75c4451`, branch `a401237`.

## (b) Dual-resolution 4K splat — `v7-dualres-4k-splat` branch

Source: `ekr2nIex040.webm` (**3840x2160 / 4K**), first 12 s.
Request: `output_res=2160, inpaint_res=720, depth_res=1148, target_fps=12,
adaptive, depth-pro, propainter`.
Job: `96269ef2e213` → `job_96269ef2e213.json`.

| Concern | Check | Result |
|---------|-------|--------|
| #1 frame-count / AV sync | splat vs work frame counts | ✅ **splat 144f @ 3840x2160 == work 144f @ 1280x720** (work is a pure scale of splat) |
| depth GPU | runs on the cheap work tier | ✅ L40S @ input_size 1148 |
| dual-res engaged | worker got the splat surface | ✅ log `🪟 dual-res: splat@3840x2160, inpaint@1280x720` |
| #3 4K splat VRAM | GPU routing by splat pixels | ✅ `stereo GPU: H200 (splat_px=8294400)`, **no OOM** |
| end-to-end output | SBS dims + frames | ✅ **7680x2160, 144 frames** (= 2×3840 wide per eye = true 4K stereo) |
| splat reusable | published + registered | ✅ `preprocess_splat.mp4` + reuse entry (+splat) |
| #2 alignment / ghosting | visual frame inspection | ✅ see frames below — sharp 4K detail, clean depth edges, no doubling |

## Files in this bundle

- `ekr2_dualres_4k.mov` — the full **7680x2160 dual-res 4K SBS output** (82 MB).
- `frame72_sbs.png` — early frame (title card "APT."), shows L/R eye disparity.
- `frame130_left.png` / `frame130_right.png` — a depth-rich frame (2 subjects
  + amps + pink bg), left & right eye downscaled — compare the horizontal
  disparity between eyes.
- `frame130_edge_100pct.png` — a **100% (native-4K) crop** at a subject/
  background depth edge — inspect here for any ghosting or fill seams at full
  resolution.
- `frame130_full.png` — full 7680x2160 SBS frame 130.
- `job_*.json` — full job records (status, metadata, timings, outputs).

## How to review concern #2 yourself

Open `frame130_edge_100pct.png` (native 4K pixels). The dual-res claim is:
~95% of the frame is real warped 4K detail; only the disocclusion holes at
depth edges carry upscaled-from-720 fill. So: subject surfaces should be
crisp 4K; only thin regions right at the foreground/background boundary may
look slightly softer (the fill). There should be **no doubling/ghosting**
(which would indicate depth↔frame misalignment) and **no hard seams**.

## Merge status

ProPainter dual-res path: **GPU-verified, ready to merge to main.**
M2SVid dual-res path: implemented, **NOT yet 4K-tested** (fixed GPU, may
need a VRAM bump). Default path (no inpaint_res) is byte-identical to today.
