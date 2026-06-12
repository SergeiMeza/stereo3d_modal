# Pipeline benchmarks

Generated 2026-06-13 03:02 by scripts/benchmark_parallel.py.

Cost estimates: Modal on-demand GPU rates + ~2 CPU cores; excludes
cold starts and storage. Stage timings are recorded by the jobs themselves.

| kind | input | depth size | inpaint | status | total s | est. $ |
|---|---|---|---|---|---|---|
| video | videos/clip_1s_480p.mp4 | 518 | none | completed | 11.1 | 0.0045 |
| video | videos/clip_1s_480p.mp4 | 518 | propainter | failed | 0.2 | 0.0 |
| video | videos/clip_1s_720p.mp4 | 700 | propainter | failed | 0.8 | 0.0004 |
| video | videos/clip_1s_1080p.mp4 | 980 | propainter | failed | 0.1 | 0.0 |
| video | videos/clip_1s_2160p.mp4 | 980 | propainter | failed | 0.1 | 0.0 |
| video | videos/clip_10s_scenes_480p.mp4 | 518 | propainter | failed | 0.4 | 0.0 |
| video | videos/clip_10s_scenes_1080p.mp4 | 980 | propainter | failed | 0.5 | 0.0 |
| video | videos/clip_10s_scenes_2160p.mp4 | 980 | propainter | failed | 0.9 | 0.0 |
| video | videos/letterbox_10s_1080p.mp4 | 980 | propainter | failed | 4.9 | 0.0016 |
| image-batch | 6 images | - | - | completed | 123.2 | 0.0409 |

## Per-stage timings

### video: videos/clip_1s_480p.mp4 (none, depth 518)

| stage | seconds | gpu | detail |
|---|---|---|---|
| preprocess | 0.059 | cpu | {'crop': None, 'width': 854, 'height': 480, 'num_frames': 24} |
| video_depth | 6.634 | L40S | {'input_size': 518} |
| video_stereo[none] | 1.104 | L40S | {'frames': 24, 'width': 854, 'height': 480} |
| encode_outputs | 3.256 | cpu | {'formats': ['sbs', 'half_sbs', 'anaglyph']} |

### video: videos/clip_1s_480p.mp4 (propainter, depth 518)

| stage | seconds | gpu | detail |
|---|---|---|---|
| preprocess | 0.154 | cpu | {'crop': None, 'width': 854, 'height': 480, 'num_frames': 24} |

### video: videos/clip_1s_720p.mp4 (propainter, depth 700)

| stage | seconds | gpu | detail |
|---|---|---|---|
| preprocess | 0.058 | cpu | {'crop': None, 'width': 1280, 'height': 720, 'num_frames': 24} |
| video_depth | 0.716 | L40S | {'input_size': 700} |

### video: videos/clip_1s_1080p.mp4 (propainter, depth 980)

| stage | seconds | gpu | detail |
|---|---|---|---|
| preprocess | 0.059 | cpu | {'crop': None, 'width': 1920, 'height': 1080, 'num_frames': 24} |

### video: videos/clip_1s_2160p.mp4 (propainter, depth 980)

| stage | seconds | gpu | detail |
|---|---|---|---|
| preprocess | 0.059 | cpu | {'crop': None, 'width': 3840, 'height': 2160, 'num_frames': 24} |

### video: videos/clip_10s_scenes_480p.mp4 (propainter, depth 518)

| stage | seconds | gpu | detail |
|---|---|---|---|
| preprocess | 0.399 | cpu | {'crop': None, 'width': 854, 'height': 480, 'num_frames': 240} |

### video: videos/clip_10s_scenes_1080p.mp4 (propainter, depth 980)

| stage | seconds | gpu | detail |
|---|---|---|---|
| preprocess | 0.52 | cpu | {'crop': None, 'width': 1920, 'height': 1080, 'num_frames': 240} |

### video: videos/clip_10s_scenes_2160p.mp4 (propainter, depth 980)

| stage | seconds | gpu | detail |
|---|---|---|---|
| preprocess | 0.936 | cpu | {'crop': None, 'width': 3840, 'height': 2160, 'num_frames': 240} |

### video: videos/letterbox_10s_1080p.mp4 (propainter, depth 980)

| stage | seconds | gpu | detail |
|---|---|---|---|
| preprocess | 2.15 | cpu | {'crop': '1920:832:0:124', 'width': 1920, 'height': 1080, 'num_frames': 239} |
| video_depth | 2.761 | L40S | {'input_size': 980} |

### image-batch: 6 images (-, depth -)

| stage | seconds | gpu | detail |
|---|---|---|---|
| image[001_Sg3XwuEpybU] | 37.448 | A10G | {} |
| image[004_qO-PIF84Vxg] | 18.825 | A10G | {} |
| image[007_5yAhL8ViUVg] | 17.802 | A10G | {} |
| image[013_5Vr_RVPfbMI] | 14.571 | A10G | {} |
| image[019_fliwkBbS7oM] | 12.062 | A10G | {} |
| image[letterbox_frame_2160p] | 22.538 | A10G | {} |
