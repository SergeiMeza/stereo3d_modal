package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/probe"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Measured output rates (owner 2026-11-07): each finished output's
// video_kbps (and audio codec and kbps when there's audio), shown with the
// run as outputs_media. The worker's own figures come first (the Lifelike
// worker adds per-output video_kbps, audio_codec and audio_kbps measured
// from the finished file); where it reports none (older deploys, Classic,
// a later format), ffprobe reads the delivered file's index through a
// signed link. Never an estimate: a stream without its own rate gets the
// container's, labelled overall_kbps.

// workerMediaKeys are where the worker's per-output figures may sit: the
// output's own object, or metadata.<key>.<output name>.
var workerMediaKeys = []string{"outputs_media", "output_media", "media"}

type workerMedia struct {
	VideoKbps  *float64 `json:"video_kbps"`
	AudioCodec *string  `json:"audio_codec"`
	AudioKbps  *float64 `json:"audio_kbps"`
}

func (m workerMedia) usable() bool { return m.VideoKbps != nil && *m.VideoKbps > 0 }

func (m workerMedia) record() store.OutputMedia {
	out := store.OutputMedia{VideoKbps: *m.VideoKbps, Source: "worker"}
	if m.AudioCodec != nil {
		out.AudioCodec = *m.AudioCodec
	}
	if m.AudioKbps != nil {
		out.AudioKbps = *m.AudioKbps
	}
	return out
}

// workerOutputsMedia reads the worker's figures for the outputs kept.
func workerOutputsMedia(job *modalapi.Job, outputs map[string]string) map[string]store.OutputMedia {
	out := map[string]store.OutputMedia{}
	for name, raw := range job.Outputs {
		var m workerMedia
		if json.Unmarshal(raw, &m) == nil && m.usable() {
			if _, kept := outputs[name]; kept {
				out[name] = m.record()
			}
		}
	}
	var md map[string]json.RawMessage
	if len(job.Metadata) > 0 && json.Unmarshal(job.Metadata, &md) == nil {
		for _, k := range workerMediaKeys {
			var by map[string]workerMedia
			if raw, ok := md[k]; ok && json.Unmarshal(raw, &by) == nil {
				for name, m := range by {
					if _, kept := outputs[name]; kept && m.usable() {
						if _, have := out[name]; !have {
							out[name] = m.record()
						}
					}
				}
			}
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// mediaProbe reads one delivered file's rates, outputURL signs its link
// (tests replace both).
var (
	mediaProbe = probe.Media
	outputURL  = func(s *Service, key string) (string, error) { return s.GCS.SignedGetURL(key, 10*time.Minute) }
)

// fillOutputsMedia ffprobes the outputs a run has no figures for and
// stores them (at most 12 outputs, a minute in all). Never fails the run.
func (s *Service) fillOutputsMedia(ctx context.Context, convID string) {
	if s.Store == nil || s.GCS == nil {
		return
	}
	defer func() { // a best-effort step after the run settled: never take the caller down
		if r := recover(); r != nil {
			slog.ErrorContext(ctx, "output rates step failed", "conversion_id", convID, "panic", r)
		}
	}()
	ctx, cancel := context.WithTimeout(ctx, time.Minute)
	defer cancel()
	c, err := s.Store.GetConversion(ctx, convID)
	if err != nil || c.State != store.StateSucceeded || c.Sample {
		return
	}
	found := map[string]store.OutputMedia{}
	n := 0
	for name, key := range c.Outputs {
		if _, have := c.OutputsMedia[name]; have || n >= 12 {
			continue
		}
		n++
		url, err := outputURL(s, key)
		if err != nil {
			continue
		}
		r, err := mediaProbe(ctx, url)
		if err != nil {
			slog.WarnContext(ctx, "output rates unread", "conversion_id", convID, "output", name, "err", err)
			continue
		}
		m := store.OutputMedia{VideoKbps: r.VideoKbps, AudioCodec: r.AudioCodec, AudioKbps: r.AudioKbps, Source: "ffprobe"}
		if r.VideoKbps <= 0 {
			m.OverallKbps = r.OverallKbps // the container's rate, audio included: labelled, never passed off as video
		}
		found[name] = m
	}
	if len(found) == 0 {
		return
	}
	if _, err := s.Store.Transition(ctx, convID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		if x.OutputsMedia == nil {
			x.OutputsMedia = map[string]store.OutputMedia{}
		}
		for name, m := range found {
			if _, have := x.OutputsMedia[name]; !have {
				x.OutputsMedia[name] = m
			}
		}
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "output rates not stored", "conversion_id", convID, "err", err)
	}
}
