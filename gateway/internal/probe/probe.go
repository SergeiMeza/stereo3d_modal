// Package probe runs ffprobe against a signed GCS URL to get trusted media
// properties for quoting. ffprobe fetches only the container headers (moov
// atom) over HTTP, so this is cheap even for multi-GB sources.
package probe

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

type Result struct {
	DurationS float64
	Frames    int
	FPS       float64
	Width     int
	Height    int
}

const timeout = 30 * time.Second

// Video probes the first video stream of the object behind url.
func Video(ctx context.Context, url string) (*Result, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration",
		"-show_entries", "format=duration",
		"-of", "json",
		url,
	).Output()
	if err != nil {
		detail := ""
		if ee, ok := err.(*exec.ExitError); ok {
			detail = ": " + strings.TrimSpace(string(ee.Stderr))
		}
		return nil, fmt.Errorf("ffprobe failed%s", detail)
	}

	var parsed struct {
		Streams []struct {
			Width      int    `json:"width"`
			Height     int    `json:"height"`
			RFrameRate string `json:"r_frame_rate"`
			NBFrames   string `json:"nb_frames"`
			Duration   string `json:"duration"`
		} `json:"streams"`
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil || len(parsed.Streams) == 0 {
		return nil, fmt.Errorf("ffprobe: no video stream")
	}
	s := parsed.Streams[0]

	r := &Result{Width: s.Width, Height: s.Height}
	r.FPS = parseRate(s.RFrameRate)
	r.DurationS, _ = strconv.ParseFloat(s.Duration, 64)
	if r.DurationS == 0 {
		r.DurationS, _ = strconv.ParseFloat(parsed.Format.Duration, 64)
	}
	r.Frames, _ = strconv.Atoi(s.NBFrames)
	if r.Frames == 0 && r.FPS > 0 && r.DurationS > 0 {
		r.Frames = int(math.Round(r.DurationS * r.FPS))
	}
	if r.Width <= 0 || r.Height <= 0 || r.DurationS <= 0 {
		return nil, fmt.Errorf("ffprobe: incomplete metadata (w=%d h=%d dur=%.2f)", r.Width, r.Height, r.DurationS)
	}
	return r, nil
}

// Image probes a still image (dimensions only).
func Image(ctx context.Context, url string) (*Result, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, "ffprobe",
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=width,height",
		"-of", "json",
		url,
	).Output()
	if err != nil {
		return nil, fmt.Errorf("ffprobe failed on image")
	}
	var parsed struct {
		Streams []struct {
			Width  int `json:"width"`
			Height int `json:"height"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil || len(parsed.Streams) == 0 {
		return nil, fmt.Errorf("ffprobe: not a decodable image")
	}
	return &Result{Width: parsed.Streams[0].Width, Height: parsed.Streams[0].Height}, nil
}

func parseRate(rate string) float64 {
	num, den, found := strings.Cut(rate, "/")
	n, _ := strconv.ParseFloat(num, 64)
	if !found {
		return n
	}
	d, _ := strconv.ParseFloat(den, 64)
	if d == 0 {
		return 0
	}
	return n / d
}
