# v3 previews — Depth Pro profiler (FOV-informed, true-meters) — 2026-06-13

Adaptive depth script with the **v3 profiler** (`"profiler": "depth-pro"`):
classifies shots in TRUE metric meters (close <3 m / wide >11 m) and uses
the per-shot mean horizontal FOV as a classification modifier (long lens
<30° biases close-up; wide lens >60° biases wide). Otherwise the same v2
pro-treatment (depth-matched cuts, comfort caps, ramps).

Main depth pass = VDA (the production default); Depth Pro runs only as the
3-keyframe-per-shot profiler. qhd preset, ProPainter both-eye, audio,
sbs + mvhevc (x265 spatial).

| clip | job | shots | classes | FOV range |
|---|---|---|---|---|
| dance_60s_depthpro | 904d19740753 | 33 | 11 wide / 19 std / 3 dyn | 40–62° |
| letterbox_60s_depthpro | fe0303a7eef8 | 34 | 1 wide / 20 close / 9 std / 4 dyn | 19–70° (med 32°) |

The FOV modifier is visibly working: the letterbox clip's long-lens
close-ups (~20–30°) are correctly called close_up even past the 3 m metric
cut (portrait compression), while its few wide-FOV shots (>60°) read as
standard/wide. This is the classification accuracy that made v3 beat v2 in
the headset.

**Device verdict (Sergei):** v3 > v2 (better classification at the source).
auto_comfort confirmed a no-op at the default 0.02 budget on v3 output
(see ../v3_autocomfort/) — v3 already lands disparities in-budget.

Compare against:
- `../v2_adaptive/` — same clips, v2 (da3-metric) profiler + the depth_scale=0.75 + M2SVid variants
- `../v3_autocomfort/` — 10s clip, auto_comfort off vs on (identical output, comfort_scale=1.0)

Note: letterbox_60s first depth attempt (job 9d759002879a) hung silently in
the depth pass (~94 min no progress) and was cancelled + resubmitted as
fe0303a7eef8 — motivated the ShotProfiler decouple (branch
profiler-decouple) and the heartbeat-watchdog follow-up.
