# full_batch_v4 — continuous displacement ramp by depth

Displacement is now a continuous function of median depth (meters): 2m→0.010, 5m→0.008, 11m→0.006, 20m→0.0045 floor. Applied per-shot AND per dynamic-keyframe. Class sets placement only. Fixes far-shot over-displacement (dance first shot 14.9m: was 0.007 flat → now ~0.0053).

Depth REUSED from the v2 depth-source jobs (tuning doesn't change depth).
Per-video .yaml has the full per-shot ramp + displacement_range.

Videos present: ['K9_full_v4.mov', 'awkky_full_v4.mov', 'dance_full_v4.mov', 'webm2_full_v4.mov']
