# Pipeline benchmarks

Generated 2026-06-13 03:26 by scripts/benchmark_parallel.py.

Cost estimates: Modal on-demand GPU rates + ~2 CPU cores; excludes
cold starts and storage. Stage timings are recorded by the jobs themselves.

| kind        | input                            | depth size | inpaint    | status    | total s | est. $ |
| ----------- | -------------------------------- | ---------- | ---------- | --------- | ------- | ------ |
| video       | videos/clip_1s_480p.mp4          | 518        | none       | completed | 13.0    | 0.0052 |
| video       | videos/clip_1s_480p.mp4          | 518        | propainter | completed | 56.0    | 0.03   |
| video       | videos/clip_1s_720p.mp4          | 700        | propainter | completed | 40.1    | 0.0203 |
| video       | videos/clip_1s_1080p.mp4         | 980        | propainter | completed | 48.7    | 0.0244 |
| video       | videos/clip_1s_2160p.mp4         | 980        | propainter | completed | 94.7    | 0.0477 |
| video       | videos/clip_10s_scenes_480p.mp4  | 518        | propainter | completed | 280.0   | 0.1537 |
| video       | videos/clip_10s_scenes_1080p.mp4 | 980        | propainter | completed | 408.9   | 0.2224 |
| video       | videos/clip_10s_scenes_2160p.mp4 | 980        | propainter | completed | 544.8   | 0.2632 |
| video       | videos/letterbox_10s_1080p.mp4   | 980        | propainter | completed | 422.6   | 0.2312 |
| image-batch | 6 images                         | -          | -          | completed | 119.3   | 0.0396 |

## Per-stage timings

### video: videos/clip_1s_480p.mp4 (none, depth 518)

| stage              | seconds | gpu  | detail                                                        |
| ------------------ | ------- | ---- | ------------------------------------------------------------- |
| preprocess         | 0.283   | cpu  | {'crop': None, 'width': 854, 'height': 480, 'num_frames': 24} |
| video_depth        | 7.498   | L40S | {'input_size': 518}                                           |
| video_stereo[none] | 1.537   | L40S | {'frames': 24, 'width': 854, 'height': 480}                   |
| encode_outputs     | 3.727   | cpu  | {'formats': ['sbs', 'half_sbs', 'anaglyph']}                  |

### video: videos/clip_1s_480p.mp4 (propainter, depth 518)

| stage                    | seconds | gpu  | detail                                                        |
| ------------------------ | ------- | ---- | ------------------------------------------------------------- |
| preprocess               | 0.157   | cpu  | {'crop': None, 'width': 854, 'height': 480, 'num_frames': 24} |
| video_depth              | 7.545   | L40S | {'input_size': 518}                                           |
| video_stereo[propainter] | 45.037  | L40S | {'frames': 24, 'width': 854, 'height': 480}                   |
| encode_outputs           | 3.268   | cpu  | {'formats': ['sbs', 'half_sbs', 'anaglyph']}                  |

### video: videos/clip_1s_720p.mp4 (propainter, depth 700)

| stage                    | seconds | gpu  | detail                                                         |
| ------------------------ | ------- | ---- | -------------------------------------------------------------- |
| preprocess               | 0.07    | cpu  | {'crop': None, 'width': 1280, 'height': 720, 'num_frames': 24} |
| video_depth              | 9.823   | L40S | {'input_size': 700}                                            |
| video_stereo[propainter] | 25.749  | L40S | {'frames': 24, 'width': 1280, 'height': 720}                   |
| encode_outputs           | 4.492   | cpu  | {'formats': ['sbs', 'half_sbs', 'anaglyph']}                   |

### video: videos/clip_1s_1080p.mp4 (propainter, depth 980)

| stage                    | seconds | gpu  | detail                                                          |
| ------------------------ | ------- | ---- | --------------------------------------------------------------- |
| preprocess               | 0.214   | cpu  | {'crop': None, 'width': 1920, 'height': 1080, 'num_frames': 24} |
| video_depth              | 15.202  | L40S | {'input_size': 980}                                             |
| video_stereo[propainter] | 27.464  | L40S | {'frames': 24, 'width': 1920, 'height': 1080}                   |
| encode_outputs           | 5.818   | cpu  | {'formats': ['sbs', 'half_sbs', 'anaglyph']}                    |

### video: videos/clip_1s_2160p.mp4 (propainter, depth 980)

| stage                    | seconds | gpu  | detail                                                          |
| ------------------------ | ------- | ---- | --------------------------------------------------------------- |
| preprocess               | 0.282   | cpu  | {'crop': None, 'width': 3840, 'height': 2160, 'num_frames': 24} |
| video_depth              | 18.702  | L40S | {'input_size': 980}                                             |
| video_stereo[propainter] | 64.807  | L40S | {'frames': 24, 'width': 3840, 'height': 2160}                   |
| encode_outputs           | 10.94   | cpu  | {'formats': ['sbs', 'half_sbs', 'anaglyph']}                    |

### video: videos/clip_10s_scenes_480p.mp4 (propainter, depth 518)

| stage                    | seconds | gpu  | detail                                                         |
| ------------------------ | ------- | ---- | -------------------------------------------------------------- |
| preprocess               | 0.053   | cpu  | {'crop': None, 'width': 854, 'height': 480, 'num_frames': 240} |
| video_depth              | 22.422  | L40S | {'input_size': 518}                                            |
| video_stereo[propainter] | 247.825 | L40S | {'frames': 240, 'width': 854, 'height': 480}                   |
| encode_outputs           | 9.742   | cpu  | {'formats': ['sbs', 'half_sbs', 'anaglyph']}                   |

### video: videos/clip_10s_scenes_1080p.mp4 (propainter, depth 980)

| stage                    | seconds | gpu  | detail                                                           |
| ------------------------ | ------- | ---- | ---------------------------------------------------------------- |
| preprocess               | 0.091   | cpu  | {'crop': None, 'width': 1920, 'height': 1080, 'num_frames': 240} |
| video_depth              | 81.41   | L40S | {'input_size': 980}                                              |
| video_stereo[propainter] | 309.363 | L40S | {'frames': 240, 'width': 1920, 'height': 1080}                   |
| encode_outputs           | 17.987  | cpu  | {'formats': ['sbs', 'half_sbs', 'anaglyph']}                     |

### video: videos/clip_10s_scenes_2160p.mp4 (propainter, depth 980)

| stage                    | seconds | gpu  | detail                                                           |
| ------------------------ | ------- | ---- | ---------------------------------------------------------------- |
| preprocess               | 0.729   | cpu  | {'crop': None, 'width': 3840, 'height': 2160, 'num_frames': 240} |
| video_depth              | 88.443  | L40S | {'input_size': 980}                                              |
| video_stereo[propainter] | 371.081 | L40S | {'frames': 240, 'width': 3840, 'height': 2160}                   |
| encode_outputs           | 84.537  | cpu  | {'formats': ['sbs', 'half_sbs', 'anaglyph']}                     |

### video: videos/letterbox_10s_1080p.mp4 (propainter, depth 980)

| stage                    | seconds | gpu  | detail                                                                       |
| ------------------------ | ------- | ---- | ---------------------------------------------------------------------------- |
| preprocess               | 2.026   | cpu  | {'crop': '1920:832:0:124', 'width': 1920, 'height': 1080, 'num_frames': 239} |
| video_depth              | 93.545  | L40S | {'input_size': 980}                                                          |
| video_stereo[propainter] | 312.852 | L40S | {'frames': 239, 'width': 1920, 'height': 832}                                |
| encode_outputs           | 14.132  | cpu  | {'formats': ['sbs', 'half_sbs', 'anaglyph']}                                 |

### image-batch: 6 images (-, depth -)

| stage                        | seconds | gpu  | detail |
| ---------------------------- | ------- | ---- | ------ |
| image[001_Sg3XwuEpybU]       | 36.266  | A10G | {}     |
| image[004_qO-PIF84Vxg]       | 18.579  | A10G | {}     |
| image[007_5yAhL8ViUVg]       | 16.845  | A10G | {}     |
| image[013_5Vr_RVPfbMI]       | 13.905  | A10G | {}     |
| image[019_fliwkBbS7oM]       | 11.013  | A10G | {}     |
| image[letterbox_frame_2160p] | 22.73   | A10G | {}     |
