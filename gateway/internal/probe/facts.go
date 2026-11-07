package probe

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// Facts is what the source details panel shows of a video file
// (owner 2026-11-07), read once at analysis by ffprobe (the container
// headers) and a scan of the moov box for the stereo boxes ffprobe 5.1
// doesn't report. Zero values are unknown. Location tags are never read.
type Facts struct {
	Container string  // mov | mp4 | m4v | ffprobe's first format name
	DurationS float64 // the container's
	Video     VideoFacts
	Audio     *AudioFacts // nil without sound
	Stereo    StereoFacts
	Make      string // camera, from the container's tags
	Model     string
}

type VideoFacts struct {
	Codec          string // hevc, h264, prores…
	Profile        string // Main, Main 10, High…
	BitDepth       int    // from the pixel format (yuv420p10le → 10)
	PixFmt         string
	BitRateBps     int64 // the stream's own (0 = the container doesn't say)
	ColorTransfer  string
	ColorPrimaries string
	Rotation       int // the display matrix's degrees (-90, 90, 180), 0 = none
}

type AudioFacts struct {
	Codec      string
	Channels   int
	SampleRate int
	BitRateBps int64
}

// StereoFacts: Spatial is an Apple spatial (MV-HEVC) source, Layout its
// packing (mvhevc | sbs | tb), From where it was read (vexu | st3d |
// side_data | tags).
type StereoFacts struct {
	Spatial bool
	Layout  string
	From    string
}

// ReadFacts reads a video's facts: ffprobe's -show_format -show_streams,
// then (size > 0) the moov box for vexu / st3d.
func ReadFacts(ctx context.Context, url string, size int64) (*Facts, error) {
	if err := acquire(ctx); err != nil {
		return nil, err
	}
	pctx, cancel := context.WithTimeout(ctx, timeout)
	out, err := command(pctx, "ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", url).Output()
	cancel()
	release()
	if err != nil {
		if pctx.Err() != nil {
			return nil, fmt.Errorf("ffprobe: %w", pctx.Err())
		}
		return nil, fmt.Errorf("ffprobe failed")
	}
	f, err := ParseFacts(out)
	if err != nil {
		return nil, err
	}
	if !f.Stereo.Spatial && f.Stereo.Layout == "" && size > 0 {
		sctx, scancel := context.WithTimeout(ctx, timeout)
		if moov, merr := fetchMoov(sctx, url, size); merr == nil {
			f.Stereo = StereoFromMoov(moov)
		}
		scancel()
	}
	return f, nil
}

// ParseFacts reads ffprobe's -show_format -show_streams JSON.
func ParseFacts(raw []byte) (*Facts, error) {
	var parsed struct {
		Streams []struct {
			CodecType      string            `json:"codec_type"`
			CodecName      string            `json:"codec_name"`
			Profile        string            `json:"profile"`
			PixFmt         string            `json:"pix_fmt"`
			BitsPerRaw     string            `json:"bits_per_raw_sample"`
			BitRate        string            `json:"bit_rate"`
			ColorTransfer  string            `json:"color_transfer"`
			ColorPrimaries string            `json:"color_primaries"`
			Channels       int               `json:"channels"`
			SampleRate     string            `json:"sample_rate"`
			Tags           map[string]string `json:"tags"`
			SideData       []map[string]any  `json:"side_data_list"`
		} `json:"streams"`
		Format struct {
			FormatName string            `json:"format_name"`
			Duration   string            `json:"duration"`
			Tags       map[string]string `json:"tags"`
		} `json:"format"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	f := &Facts{}
	f.DurationS, _ = strconv.ParseFloat(parsed.Format.Duration, 64)
	tags := map[string]string{}
	for k, v := range parsed.Format.Tags {
		tags[strings.ToLower(k)] = strings.TrimSpace(v)
	}
	f.Container = containerOf(tags["major_brand"], parsed.Format.FormatName)
	f.Make = firstTag(tags, "com.apple.quicktime.make", "com.android.manufacturer", "make")
	f.Model = firstTag(tags, "com.apple.quicktime.model", "com.android.model", "model")
	if tags["com.apple.quicktime.spatial.format-version"] != "" {
		f.Stereo = StereoFacts{Spatial: true, Layout: "mvhevc", From: "tags"}
	}
	seenVideo := false
	for _, st := range parsed.Streams {
		switch {
		case st.CodecType == "video" && !seenVideo:
			seenVideo = true
			v := VideoFacts{Codec: st.CodecName, Profile: st.Profile, PixFmt: st.PixFmt, BitRateBps: atoi64(st.BitRate),
				ColorTransfer: st.ColorTransfer, ColorPrimaries: st.ColorPrimaries, BitDepth: bitDepthOf(st.PixFmt, st.BitsPerRaw)}
			if r, err := strconv.Atoi(st.Tags["rotate"]); err == nil {
				v.Rotation = r
			}
			for _, sd := range st.SideData {
				typ, _ := sd["side_data_type"].(string)
				switch typ {
				case "Display Matrix":
					if r, ok := sd["rotation"].(float64); ok {
						v.Rotation = int(math.Round(r))
					}
				case "Stereo 3D":
					if s := stereoFromSideData(sd); s.Layout != "" {
						f.Stereo = s
					}
				}
			}
			f.Video = v
		case st.CodecType == "audio" && f.Audio == nil:
			sr, _ := strconv.Atoi(st.SampleRate)
			f.Audio = &AudioFacts{Codec: st.CodecName, Channels: st.Channels, SampleRate: sr, BitRateBps: atoi64(st.BitRate)}
		}
	}
	if !seenVideo {
		return nil, fmt.Errorf("ffprobe: no video stream")
	}
	return f, nil
}

// stereoFromSideData reads ffprobe's Stereo 3D side data (ffmpeg 7.1+
// reports MV-HEVC's vexu as view "packed" with type "unspecified").
func stereoFromSideData(sd map[string]any) StereoFacts {
	typ, _ := sd["type"].(string)
	view, _ := sd["view"].(string)
	switch strings.ToLower(typ) {
	case "side by side", "side by side (quincunx subsampling)":
		return StereoFacts{Layout: "sbs", From: "side_data"}
	case "top and bottom":
		return StereoFacts{Layout: "tb", From: "side_data"}
	}
	if strings.EqualFold(view, "packed") || strings.EqualFold(typ, "unspecified") {
		return StereoFacts{Spatial: true, Layout: "mvhevc", From: "side_data"}
	}
	return StereoFacts{}
}

func containerOf(brand, formatName string) string {
	switch strings.TrimSpace(brand) {
	case "qt":
		return "mov"
	case "M4V", "M4VH", "M4VP":
		return "m4v"
	case "":
	default:
		if strings.Contains(formatName, "mp4") {
			return "mp4"
		}
	}
	if i := strings.IndexByte(formatName, ','); i > 0 {
		return formatName[:i]
	}
	return formatName
}

func firstTag(tags map[string]string, keys ...string) string {
	for _, k := range keys {
		if v := tags[k]; v != "" {
			if len(v) > 80 {
				v = v[:80]
			}
			return v
		}
	}
	return ""
}

func atoi64(s string) int64 {
	v, err := strconv.ParseInt(s, 10, 64)
	if err != nil || v < 0 {
		return 0
	}
	return v
}

// bitDepthOf reads the depth from the pixel format (yuv420p10le → 10,
// p010le → 10, yuv420p and nv12 → 8), else bits_per_raw_sample.
func bitDepthOf(pixFmt, raw string) int {
	p := strings.TrimSuffix(strings.TrimSuffix(pixFmt, "le"), "be")
	switch {
	case p == "":
	case strings.HasPrefix(p, "nv"):
		return 8
	case strings.HasPrefix(p, "p0") && len(p) == 4: // p010, p012, p016
		n, _ := strconv.Atoi(p[1:])
		return n
	default:
		if m := pixDepth.FindStringSubmatch(p); m != nil {
			n, _ := strconv.Atoi(m[1])
			return n
		}
		return 8
	}
	if n, err := strconv.Atoi(raw); err == nil && n > 0 {
		return n
	}
	return 0
}

var pixDepth = regexp.MustCompile(`p(9|10|12|14|16)$`)

// StereoFromMoov finds the stereo boxes in a moov box: vexu (Apple's
// video extended usage, MV-HEVC spatial video) or st3d (Spherical Video
// V2's stereo mode: 1 top-bottom, 2 left-right).
func StereoFromMoov(moov []byte) StereoFacts {
	if bytes.Contains(moov, []byte("vexu")) {
		return StereoFacts{Spatial: true, Layout: "mvhevc", From: "vexu"}
	}
	// st3d: size(4) "st3d"(4) version+flags(4) stereo_mode(1); i is at "st3d"
	if i := bytes.Index(moov, []byte("st3d")); i >= 0 && i+8 < len(moov) {
		switch moov[i+8] {
		case 1:
			return StereoFacts{Layout: "tb", From: "st3d"}
		case 2:
			return StereoFacts{Layout: "sbs", From: "st3d"}
		}
	}
	return StereoFacts{}
}

// maxMoov caps the moov read (a long 120 fps file's index is a few MB).
const maxMoov = 32 << 20

// fetchMoov reads the moov box with range requests: walks the top-level
// boxes from the start (each header 8 or 16 bytes) until moov.
var fetchMoov = func(ctx context.Context, url string, size int64) ([]byte, error) {
	var off int64
	for i := 0; i < 64 && off+8 <= size; i++ {
		hdr, err := rangeGet(ctx, url, off, 16)
		if err != nil || len(hdr) < 8 {
			return nil, fmt.Errorf("box header at %d: %v", off, err)
		}
		boxSize := int64(binary.BigEndian.Uint32(hdr[:4]))
		typ := string(hdr[4:8])
		head := int64(8)
		switch boxSize {
		case 1:
			if len(hdr) < 16 {
				return nil, fmt.Errorf("short largesize")
			}
			boxSize, head = int64(binary.BigEndian.Uint64(hdr[8:16])), 16
		case 0:
			boxSize = size - off
		}
		if boxSize < head {
			return nil, fmt.Errorf("bad box %q", typ)
		}
		if typ == "moov" {
			if boxSize > maxMoov {
				boxSize = maxMoov
			}
			return rangeGet(ctx, url, off, boxSize)
		}
		off += boxSize
	}
	return nil, fmt.Errorf("no moov")
}

func rangeGet(ctx context.Context, url string, off, n int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", off, off+n-1))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent && resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("range %d", resp.StatusCode)
	}
	return io.ReadAll(io.LimitReader(resp.Body, n))
}
