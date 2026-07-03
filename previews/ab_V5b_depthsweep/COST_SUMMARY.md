# A/B V5bVtAej1hs depth-res sweep — cost summary (in-source estimates)

**Total cost: $4.02 (estimated), $6.92 (real, $2.76 overhead)**

Source: V5bVtAej1hs first 60s @ 6fps, inpaint=none, adaptive depth-pro,
sbs+mvhevc, audio. Costs are ESTIMATES (timings × Modal pricing), not
billed (billing API lags real-time).

| job | depth_res | output_res | total $  | gpu $    | cpu $    | mem $    | sec     | by_gpu                                                   |
| --- | --------- | ---------- | -------- | -------- | -------- | -------- | ------- | -------------------------------------------------------- |
| 1a  | 714       | 1440       | 0.096012 | 0.046612 | 0.02133  | 0.02807  | 151.76  | L40S:$0.046612                                           |
| 1b  | 714       | 2160       | 0.341513 | 0.23059  | 0.03191  | 0.079013 | 349.443 | L40S:$0.056099, H200:$0.174491                           |
| 2a  | 1078      | 1440       | 0.27745  | 0.162071 | 0.027638 | 0.087741 | 351.952 | L40S:$0.162071                                           |
| 2b  | 1078      | 2160       | 0.424983 | 0.283516 | 0.036438 | 0.105029 | 436.067 | L40S:$0.103252, H200:$0.180264                           |
| 3a  | 1442      | 1440       | 0.483551 | 0.310594 | 0.036213 | 0.136744 | 516.628 | L40S:$0.062015, A100-SXM4-80GB:$0.248579                 |
| 3b  | 1442      | 2160       | 0.651013 | 0.442367 | 0.046588 | 0.162058 | 631.396 | L40S:$0.009263, A100-SXM4-80GB:$0.272827, H200:$0.160277 |
| 4a  | 1806      | 1440       | 0.466253 | 0.334138 | 0.02953  | 0.102585 | 401.604 | L40S:$0.050689, H200:$0.283449                           |
| 4b  | 1806      | 1800       | 0.59059  | 0.43646  | 0.035409 | 0.118721 | 465.871 | L40S:$0.009402, H200:$0.427058                           |
| 4c  | 1806      | 2160       | 0.688456 | 0.507777 | 0.042421 | 0.138258 | 555.542 | L40S:$0.009251, H200:$0.498526                           |

## Billing reconciliation (workspace-wide, billed ground truth)

| hour (UTC) | billed $                                         |
| ---------- | ------------------------------------------------ |
| 04:00      | $3.6656 (pre-run + cancelled concurrent attempt) |
| 05:00      | $6.9150 (the parallel A/B run lands here)        |

- **Sum of 9 per-job ESTIMATES: $4.02** (the comparable per-variant numbers).
- **Billed 05:00 hour: $6.92** — higher than the estimate sum because it ALSO
  includes: the earlier CANCELLED 9-job concurrent attempt (real GPU seconds
  before cancel), container cold-start/idle (scaledown_window), and the
  billing poller itself. Estimates count only each job's stage seconds, so
  estimate < billed is expected. Estimates are the right tool for COMPARING
  variants; billed hour is the all-in workspace total.
- Billing API lags real-time (the 05:00 hour read $0 mid-run, $6.92 after).
