# MV-HEVC over HLS (segmented spatial video)

`"mvhevc_hls"` is the **second** spatial output format, alongside the
existing single-file `"mvhevc"` `.mov`. It produces an HLS deliverable —
a `.m3u8` master playlist over closed-GOP fMP4 segments — that
visionOS / Safari can **stream** and recognize as stereoscopic MV-HEVC.

It does **not** replace the single-file `.mov`: that remains the
"share to Photos" form (one contiguous bitstream + `vexu`/MP4Box mux).
HLS is the natural **segmented** form, which is what makes the encode
**fan out** for long / 4K clips.

> **NEEDS ON-DEVICE VALIDATION.** The playlist/segment shape below is
> assembled with ffmpeg's `hls` muxer (Apple's `mediafilesegmenter` is
> macOS-only and is **not** in `nvenc_image`). It has **not** been
> played on visionOS / Safari. See the validation checklist at the end.

---

## Apple's HLS spatial-video requirements (research)

Confirmed June 2026 from Apple's own documentation and forum threads
that quote `mediafilesegmenter`/`variantplaylistcreator` output.

### 1. Stereo signal: `REQ-VIDEO-LAYOUT="CH-STEREO"`

The **master (multivariant)** playlist's `EXT-X-STREAM-INF` (and
`EXT-X-I-FRAME-STREAM-INF`, when present) carries the attribute:

```
REQ-VIDEO-LAYOUT="CH-STEREO"
```

`CH-STEREO` is the **video channel specifier** for two-eye stereo. For
flat (rectilinear) spatial video — which this pipeline produces — the
bare value `"CH-STEREO"` is correct. For immersive / 180 / 360 content
a **projection** specifier is appended, e.g.
`"CH-STEREO/PROJ-EQUI"` (equirectangular), `"CH-STEREO/PROJ-PRIM"`,
`"CH-STEREO/PROJ-FISH"` (fisheye). We do not project, so no `PROJ-*`.

The master playlist must declare **`#EXT-X-VERSION:12`**. A master that
comes out as `EXT-X-VERSION:7` is the symptom of an **old** HLS tool
that silently dropped the stereo tag (forum thread 748094).

Working master example (from Apple forum thread 743503, lightly
trimmed):

```
#EXTM3U
#EXT-X-VERSION:12
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-STREAM-INF:BANDWIDTH=46965192,VIDEO-RANGE=SDR,CODECS="mp4a.40.2,hvc1.1.60000000.L153.B0",RESOLUTION=2200x2200,FRAME-RATE=30.000,CLOSED-CAPTIONS=NONE,REQ-VIDEO-LAYOUT="CH-STEREO"
prog_index.m3u8
```

### 2. Segment format: fMP4 / CMAF (not MPEG-TS)

HEVC is **not** allowed in MPEG-TS in modern HLS — segments must be
**fMP4 / CMAF**. The media playlist uses an `EXT-X-MAP` init segment +
`.m4s` media segments:

```
#EXTM3U
#EXT-X-TARGETDURATION:4
#EXT-X-VERSION:7
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXT-X-INDEPENDENT-SEGMENTS
#EXT-X-MAP:URI="init.mp4"
#EXTINF:2.000,
seg00000.m4s
...
```

### 3. Per-segment headers: same two-layer stream cut at IDRs

Each segment is just the **same** two-layer MV-HEVC elementary stream
cut at an IDR boundary — there is **no** per-segment `vexu` injection.
The stereo signal lives in two places:

- the **multiview VPS / SPS / PPS** at the head of every segment (inside
  the `.m4s`), and
- `REQ-VIDEO-LAYOUT="CH-STEREO"` in the **playlist**.

The existing x265 invocation already guarantees the per-segment headers:
closed 2 s GOPs (`--keyint == --min-keyint`, `--no-open-gop`,
`--no-scenecut`) + **`--repeat-headers`** put a fresh multiview
VPS/SPS/PPS on every IDR. We reuse that exact command (see "Shared x265
helper" below), so each segment is independently decodable **and** keeps
the multiview VPS Apple's classifier keys on.

### 4. Audio

Simplest correct option, matching the existing `.mov` path: extract AAC
from the pristine original and **mux it into the same fMP4 segments**
(a single muxed A/V rendition). The forum's working master lists
`CODECS="mp4a.40.2,hvc1..."` on a single `EXT-X-STREAM-INF`, confirming
muxed audio is accepted. A separate `EXT-X-MEDIA` audio rendition is
also valid but unnecessary here.

### Sources

- Apple Developer Forums **thread 743503** — "Stereo video HLS"
  (complete working master + media playlist pair):
  <https://developer.apple.com/forums/thread/743503>
- Apple Developer Forums **thread 748094** — "How to encode MV-HEVC
  spatial videos using HLS tool correctly?" (`REQ-VIDEO-LAYOUT`,
  `EXT-X-VERSION:12`, HLS tools 1.22+):
  <https://developer.apple.com/forums/thread/748094>
- "What's new in HTTP Live Streaming" (WWDC 2025):
  <https://developer.apple.com/streaming/Whats-new-HLS.pdf>
- "Deliver video content for spatial experiences" (WWDC23, 10071):
  <https://developer.apple.com/videos/play/wwdc2023/10071/>

---

## Segment / parallel design

`encode_mvhevc_hls(job_id, sbs_path, crf, preset, original_path,
spatial, max_workers, segment_seconds=2)` in `app/stages/mvhevc.py`:

1. **Segment** the SBS master into `segment_seconds * fps` frame ranges
   (`plan_hls_segments`), rounded the same way as the x265 keyint so
   every boundary lands on an IDR. The ranges tile `[0, num_frames)`
   exactly; the last segment absorbs the remainder.
2. **Fan out** per-segment encodes across Modal workers (mirrors
   `_parallel_stereo` in `app/pipelines/video.py`): a per-segment
   `_encode_hls_segment` Modal function is `spawn`ed for each range,
   bounded by `max_workers` via `with_options(max_containers=...)`, then
   gathered defensively (each result is run through
   `check_worker_result`, so one bad segment fails the whole format with
   a clear error). Each segment is one closed GOP (`keyint == segment
   length`) → a single leading IDR.

   **Why Modal fan-out, not an in-container thread pool:** true
   horizontal scale (a 5-min 4 K clip is ~150 independent 2 s encodes —
   a thread pool is capped at one container's cores; fan-out scales to
   the workspace GPU/CPU ceiling) and it matches the rest of the
   pipeline's fan-out pattern. Per-segment workers get a **short**
   timeout (20 min) so a stuck segment fails fast.
3. **Concatenate + package** in one packaging container: the per-segment
   `.hevc` elementary streams are byte-concatenated (valid because each
   starts with its own VPS/SPS/PPS at an IDR), AAC audio is muxed in,
   and ffmpeg's `hls` muxer produces `init.mp4` + `seg*.m4s` +
   `media.m3u8` (`-hls_segment_type fmp4`, `-hls_time 2`,
   `-hls_playlist_type vod`). The **master** playlist
   (`build_hls_master`) is written with `REQ-VIDEO-LAYOUT="CH-STEREO"`
   and the real `CODECS` string probed from the init segment.
4. **Publish** the whole directory to `outputs/<job_id>/hls/` and return
   the master playlist URL as `outputs["mvhevc_hls"]`.

### Shared x265 helper

The x265 multiview command (the hard-won flags) lives in exactly **one**
place — `_x265_multiview_cmd()` in `app/stages/mvhevc.py`. Both the
single-file `.mov` path (`encode_mvhevc_x265`) and the per-segment HLS
encode (`_encode_hls_segment`) call it, so there is no second divergent
x265 command. `_decode_eyes_yuv()` (with an optional `frame_range`) is
the shared SBS→two-eye-yuv decode.

## Packaging tool

ffmpeg's **`hls` muxer** with `-hls_segment_type fmp4`, already present
in `nvenc_image` (the BtbN ffmpeg 8.1 build). **No image change.**
Apple's `mediafilesegmenter` / `variantplaylistcreator` (the canonical
tools) are macOS-only and are **not** available on Linux/Modal — this
is the reason on-device validation is required (ffmpeg's fMP4 layout may
differ subtly from Apple's). GPAC's `MP4Box -dash` with an HLS profile
is an alternative also in the image if ffmpeg's output proves
insufficient.

## Publish layout

```
outputs/<job_id>/
  mvhevc.mov            # single-file form (unchanged, if requested)
  hls/
    master.m3u8         # REQ-VIDEO-LAYOUT="CH-STEREO", EXT-X-VERSION:12
    media.m3u8          # EXT-X-MAP:URI="init.mp4", .m4s list
    init.mp4            # fMP4 init segment (EXT-X-MAP)
    seg00000.m4s ...    # closed-GOP fMP4 media segments
```

`outputs["mvhevc_hls"]` is the public URL of `hls/master.m3u8`.

---

## NEEDS DEVICE VALIDATION

None of the following can be checked offline (no x265 / visionOS here);
they are validated by code review + this checklist, not execution:

1. **Playback** — does visionOS (Vision Pro) / Safari play
   `hls/master.m3u8` at all?
2. **Stereo recognition** — is it recognized as **stereoscopic** (both
   eyes shown), i.e. does `REQ-VIDEO-LAYOUT="CH-STEREO"` + the
   per-segment multiview VPS satisfy Apple's classifier through the
   ffmpeg-produced fMP4? (The single-file `.mov` path earns the Photos
   spatial badge via x265's VPS; the open question is whether ffmpeg's
   fMP4 packaging preserves that VPS multiview signaling intact.)
3. **`mediastreamvalidator`** — run Apple's validator (macOS) on the
   published playlist; it should report no errors and confirm the stereo
   layout. If it complains, the fallback is to package with GPAC
   `MP4Box -dash` (also in `nvenc_image`) or to run Apple's
   `mediafilesegmenter` on macOS as a post-step.
4. **Audio sync** — confirm muxed AAC stays in sync across segment
   boundaries.
5. **CODECS string** — confirm the probed `hvc1.*` string in the master
   matches what the player expects (we derive it from the init segment;
   a mismatch can make Safari refuse the variant).
