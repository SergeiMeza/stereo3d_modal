package probe

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Counted is a source's frame count taken from the file itself rather
// than the stream header's claims, for pricing variable-frame-rate
// sources (a file can state 30 fps and carry bursts well above it).
type Counted struct {
	Frames    int     // video packets in the file
	DurationS float64 // the stream's (else the container's) duration
	StatedFPS float64 // r_frame_rate
	AvgFPS    float64 // avg_frame_rate
	Method    string  // "index" (MP4/MOV sample table) | "packets" (-count_packets)
}

// FPS is the counted rate: frames over the duration.
func (c *Counted) FPS() float64 {
	if c == nil || c.Frames <= 0 || c.DurationS <= 0 {
		return 0
	}
	return float64(c.Frames) / c.DurationS
}

// countTimeout bounds the packet count: it reads the whole file.
const countTimeout = 90 * time.Second

// Count counts the video frames of the object behind url. MP4/MOV list
// every sample in their index (nb_frames is that count, and reading the
// packets returns the same entries, or fewer for a truncated file), so
// the index is read; other containers have no such index and their
// packets are counted with -count_packets, which reads the whole file
// (no decoding).
func Count(ctx context.Context, url string) (*Counted, error) {
	head, err := run(ctx, timeout, url, "-show_entries", "stream=nb_frames,r_frame_rate,avg_frame_rate,duration",
		"-show_entries", "format=duration,format_name")
	if err != nil {
		return nil, err
	}
	c := &Counted{StatedFPS: parseRate(head.stream.RFrameRate), AvgFPS: parseRate(head.stream.AvgFrameRate)}
	c.DurationS, _ = strconv.ParseFloat(head.stream.Duration, 64)
	if c.DurationS <= 0 {
		c.DurationS, _ = strconv.ParseFloat(head.format.Duration, 64)
	}
	// format_name is "mov,mp4,m4a,3gp,3g2,mj2" for the whole family
	if n, _ := strconv.Atoi(head.stream.NBFrames); n > 0 && strings.Contains(head.format.FormatName, "mov") {
		c.Frames, c.Method = n, "index"
		return c, nil
	}
	full, err := run(ctx, countTimeout, url, "-count_packets", "-show_entries", "stream=nb_read_packets")
	if err != nil {
		return nil, err
	}
	c.Frames, _ = strconv.Atoi(full.stream.NBReadPackets)
	c.Method = "packets"
	if c.Frames <= 0 {
		return nil, fmt.Errorf("ffprobe: no video packets counted")
	}
	return c, nil
}

type probeOut struct {
	stream struct {
		RFrameRate    string `json:"r_frame_rate"`
		AvgFrameRate  string `json:"avg_frame_rate"`
		NBFrames      string `json:"nb_frames"`
		NBReadPackets string `json:"nb_read_packets"`
		Duration      string `json:"duration"`
	}
	format struct {
		Duration   string `json:"duration"`
		FormatName string `json:"format_name"`
	}
}

func run(ctx context.Context, limit time.Duration, url string, args ...string) (*probeOut, error) {
	if err := acquire(ctx); err != nil {
		return nil, err
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, limit)
	defer cancel()
	argv := append([]string{"-v", "error", "-select_streams", "v:0"}, args...)
	argv = append(argv, "-of", "json", url)
	out, err := command(ctx, "ffprobe", argv...).Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("ffprobe: %w", ctx.Err())
		}
		return nil, fmt.Errorf("ffprobe failed")
	}
	var parsed struct {
		Streams []json.RawMessage `json:"streams"`
		Format  json.RawMessage   `json:"format"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil || len(parsed.Streams) == 0 {
		return nil, fmt.Errorf("ffprobe: no video stream")
	}
	var p probeOut
	if err := json.Unmarshal(parsed.Streams[0], &p.stream); err != nil {
		return nil, fmt.Errorf("ffprobe: %w", err)
	}
	if len(parsed.Format) > 0 {
		_ = json.Unmarshal(parsed.Format, &p.format)
	}
	return &p, nil
}
