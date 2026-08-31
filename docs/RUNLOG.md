# Conversion run log

Occasional real conversions, recorded to benchmark the service: quote vs
billed cost, ETA vs wall, and per-stage behavior. Append a row whenever a
notable run finishes (new mode, new preset, pricing/ETA calibration, a
surprise). Modal `billed $` is the workspace credits delta the owner reads
off the dashboard (includes cold starts + scale-down idle that stage
timers can't see); `est $` is the pipeline's per-stage estimate from the
job record. Notes carry what the row is evidence FOR.

Conventions: wall = submit→terminal from the job record; frames/fps are
the WORK video's; "cuts" is the scene count (this affects depth cost —
short scenes pad the 32-frame depth windows, and the 2026-08-31 reference
video is cut-heavier than typical at ~37 f/scene).

| date (UTC) | env | job | step / mode | preset | frames@fps · cuts | quoted | quoted ETA | wall | est $ | billed $ | margin | notes |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-08-31 | prod | 45e019479a24 | depth_preview | draft d980 | 4436@24 · 121 | $6.44¹ | — | 41 min² | $1.55 | $1.57 | 4.1× | depth chunks 210–307 s ×7 L40S; scene profiling 15 min wall (3¢); ~9 min L40S queue wait. Model frames 1.85× video (window padding, cut-heavy) |
| 2026-08-31 | prod | 73e91a7e50f5 | stereo_preview · stretched (backward+none) | 3k | 4436@24 · 121 | $10.82 | 20 min | 14.4 min | $1.50 | $2.10 | 5.2× | PRE-lite-tier: 7×H200 idled behind x264 at 4 fps + unused ProPainter loads (~$0.6 overhead). Motivated the L4 lite tier + ×0.4 |
| 2026-08-31 | prod | 8372fe01b005 | stereo_preview · filled-best (propainter) | 3k | 4436@24 · 121 | $15.97 | — | 25.8 min | $4.30 | $6.02 | 2.65× | 7×H200 555–737 s; ~$1.7 overhead (ProPainter cold starts + idle). 3k propainter sits BELOW the 3× margin target — rate nudge candidate |
| 2026-08-31 | stg | f68d4db5f06a | e2e · stretched on lite tier | 3k (10 s clip) | 240@24 | — | — | ~4 min | $0.17 | — | — | First L4+NVENC run: stereo 64 s (pre host-copy fix), HEVC 5760×1620 segments, worker ready 1.5 s |
| 2026-08-31 | stg | 2498e604f9b0 | e2e · stretched, instrumented | 3k (10 s clip) | 240@24 | — | — | ~3 min | — | — | — | Host-copy (.contiguous) fix: stereo 25 s, 14.5 fps steady (decode 19 / warp 20 / write 15 ms/f). The 4 fps everywhere was numpy's strided copy |
| 2026-09-01 | stg | f0b567dbd6ed | e2e · filled-fast (migan) | 3k (10 s clip) | 240@24 | — | — | ~4 min | — | — | — | First MI-GAN run: stereo 81 s on L4 (~$0.02), zero residual holes, clean frame |
| 2026-09-01 | prod | 4a1bca4762d1 | stereo_preview · filled-fast (migan) | 3k | 4436@24 · 121 | $11.48 | 23 min | _pending_ | _pending_ | _pending_ | _pending_ | First prod migan; ETA known-bad (price multiplier reused as ETA factor) — this row anchors the fix |

¹ includes the (since removed) $0.50 analyze credit. ² ~24 min of that was
scene profiling wall + GPU queue wait, not depth compute.

Related: docs/PRICING.md (cost levers + rate anchors), docs/BENCHMARKS.md
(synthetic matrix).
