package api

import (
	"context"
	"log/slog"
	"path"
	"strings"
	"time"
	"unicode"

	"spatial-ai-labs/stereo3d-gateway/internal/probe"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Source details (owner 2026-11-07): what the project's source file is,
// for the web's Source panel and the console. The analysis' probe gives
// size, rate, frames and its bit rate; the gateway's own ffprobe at
// analysis adds the container, codec, profile, bit depth, colour,
// rotation, audio, stereo and camera (project.probe.details). Projects
// analyzed before have no details (no backfill): their panel shows what
// the probe has.

// factsSource reads a source's facts (a variable so tests stand in for
// ffprobe); nil, nil without storage.
var factsSource = func(ctx context.Context, s *Service, p *store.Project) (*probe.Facts, error) {
	if s.GCS == nil || p.Source.GCSKey == "" {
		return nil, nil
	}
	url, err := s.GCS.SignedGetURL(p.Source.GCSKey, 10*time.Minute)
	if err != nil {
		return nil, err
	}
	return probe.ReadFacts(ctx, url, p.Source.Bytes)
}

// sourceDetailsOf reads the facts at analysis, nil when unread (never
// fails the analysis).
func (s *Service) sourceDetailsOf(ctx context.Context, p *store.Project) *store.SourceDetails {
	f, err := factsSource(ctx, s, p)
	if err != nil {
		slog.WarnContext(ctx, "source details unread", "project_id", p.ID, "err", err)
		return nil
	}
	if f == nil {
		return nil
	}
	d := &store.SourceDetails{Container: f.Container, DurationS: f.DurationS, Codec: f.Video.Codec, Profile: f.Video.Profile,
		BitDepth: f.Video.BitDepth, PixFmt: f.Video.PixFmt, VideoBitRate: f.Video.BitRateBps, ColorTransfer: f.Video.ColorTransfer,
		ColorPrimaries: f.Video.ColorPrimaries, Rotation: f.Video.Rotation, Spatial: f.Stereo.Spatial, StereoLayout: f.Stereo.Layout,
		StereoFrom: f.Stereo.From, CameraMake: f.Make, CameraModel: f.Model}
	if a := f.Audio; a != nil {
		d.HasAudio, d.AudioCodec, d.AudioChannels, d.AudioRate, d.AudioBitRate = true, a.Codec, a.Channels, a.SampleRate, a.BitRateBps
	}
	return d
}

// cleanFilename keeps a device file name's last element, without control
// characters, at most 200 characters ("" when nothing is left).
func cleanFilename(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	name = path.Base(strings.TrimSpace(name))
	if name == "." || name == "/" {
		return ""
	}
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, name)
	if r := []rune(name); len(r) > 200 {
		name = string(r[:200])
	}
	return name
}

func nilIfZero[T int | int64 | float64](v T) any {
	if v == 0 {
		return nil
	}
	return v
}

// sourceDetailsJSON is project.source_details: file, video, source_crop,
// audio (null: none or unknown), stereo, camera (null: no tags), and
// details_read (false: analyzed before 2026-11-07 or unread, so codec,
// audio, stereo and camera are unknown rather than absent). color: the
// transfer and primaries are shown (viewers: only while HDR output is on,
// like dynamic_range; the console always).
func sourceDetailsJSON(p *store.Project, color bool) map[string]any {
	var pr store.Probe
	if p.Probe != nil {
		pr = *p.Probe
	}
	d := pr.Details
	read := d != nil
	if d == nil {
		d = &store.SourceDetails{}
	}
	ext := strings.TrimPrefix(strings.ToLower(path.Ext(p.Source.GCSKey)), ".")
	file := map[string]any{"name": nilIfEmpty(p.Source.Filename), "bytes": nilIfZero(p.Source.Bytes),
		"container": nilIfEmpty(firstNonEmpty(d.Container, ext)), "duration_s": nilIfZero(firstNonZero(pr.DurationS, d.DurationS))}
	bitrate := pr.BitRate
	if bitrate == 0 {
		bitrate = d.VideoBitRate
	}
	video := map[string]any{"width": nilIfZero(pr.Width), "height": nilIfZero(pr.Height), "fps": nilIfZero(pr.FPS),
		"fps_rational": nilIfEmpty(pr.FPSRational), "vfr": pr.VFR, "frames": nilIfZero(pr.NumFrames), "counted_frames": nilIfZero(pr.CountedFrames),
		"codec": nilIfEmpty(d.Codec), "profile": nilIfEmpty(d.Profile), "bit_depth": nilIfZero(d.BitDepth), "bitrate_bps": nilIfZero(bitrate),
		"color_transfer": nilIfEmpty(d.ColorTransfer), "color_primaries": nilIfEmpty(d.ColorPrimaries), "rotation": nil}
	if read {
		video["rotation"] = d.Rotation // 0 = upright, read
	}
	if !color {
		video["color_transfer"], video["color_primaries"] = nil, nil
	}
	out := map[string]any{"details_read": read, "file": file, "video": video, "source_crop": nilIfEmpty(p.Crop),
		"audio": nil, "stereo": nil, "camera": nil}
	if read {
		if d.HasAudio {
			out["audio"] = map[string]any{"codec": nilIfEmpty(d.AudioCodec), "channels": nilIfZero(d.AudioChannels),
				"sample_rate": nilIfZero(d.AudioRate), "bitrate_bps": nilIfZero(d.AudioBitRate)}
		}
		out["stereo"] = map[string]any{"spatial": d.Spatial, "layout": nilIfEmpty(d.StereoLayout)}
		if d.CameraMake != "" || d.CameraModel != "" {
			out["camera"] = map[string]any{"make": nilIfEmpty(d.CameraMake), "model": nilIfEmpty(d.CameraModel)}
		}
	}
	return out
}

func firstNonZero(vs ...float64) float64 {
	for _, v := range vs {
		if v != 0 {
			return v
		}
	}
	return 0
}

// adminSourceJSON is the console's run.source: {probe, source_bytes,
// has_bars, crop, remove_bars, dynamic_range, source_details}; nil
// without a project.
func (s *Service) adminSourceJSON(ctx context.Context, projectID string, cache map[string]*store.Project) map[string]any {
	if projectID == "" {
		return nil
	}
	p, ok := cache[projectID]
	if !ok {
		p, _ = s.Store.GetProject(ctx, projectID)
		if cache != nil {
			cache[projectID] = p
		}
	}
	if p == nil {
		return nil
	}
	var dr any
	if p.Probe != nil {
		dr = nilIfEmpty(p.Probe.DynamicRange)
	}
	var pr any
	if p.Probe != nil {
		pr = p.Probe
	}
	return map[string]any{"probe": pr, "source_bytes": p.Source.Bytes, "has_bars": hasBars(p), "crop": nilIfEmpty(p.Crop),
		"remove_bars": hasBars(p) && (p.RemoveBars == nil || *p.RemoveBars), "dynamic_range": dr, "source_details": sourceDetailsJSON(p, true)}
}
