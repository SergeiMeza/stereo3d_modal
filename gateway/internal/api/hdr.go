package api

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/probe"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// HDR output (owner 2026-11-05): analysis reads the source's dynamic
// range; every Lifelike run of an HDR source gets HDR output, automatic
// and free (hdr_output on /convert). Hidden entirely while
// lifelike_hdr_output_enabled is off. Dolby Vision without a displayable
// base layer (dv_5) is refused whatever the switch.

// errDolbyVision5Text is the refusal of a dv_5 source, without HDR.
const errDolbyVision5Text = "This video uses a Dolby Vision format that can't be converted. " +
	"Export it again from your camera or editing app as a standard video, then upload that."

// Lifelike's refusal of a Dolby Vision source it can't show (profile 5,
// or 10 with compatibility 0), a failed job before any GPU work
// (LIFELIKE_API.md "HDR sources", a6128c6).
const (
	dolbyVisionErrorCode  = "source_dolby_vision_unsupported"
	dolbyVisionJobText    = "This Dolby Vision format isn't supported."
	dolbyVisionJobMessage = "This Dolby Vision format isn't supported. Export the video as HDR10 or SDR and try again."
)

// upperFirst capitalises a phrase's first letter.
func upperFirst(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}

// dynamicSource reads a source's dynamic range (a variable so tests can
// stand in for ffprobe); nil, nil without storage.
var dynamicSource = func(ctx context.Context, s *Service, p *store.Project) (*probe.DynamicRange, error) {
	if s.GCS == nil || p.Source.GCSKey == "" {
		return nil, nil
	}
	url, err := s.GCS.SignedGetURL(p.Source.GCSKey, 10*time.Minute)
	if err != nil {
		return nil, err
	}
	return probe.Dynamic(ctx, url)
}

// dynamicRangeOf is the source's dynamic range, nil when it couldn't be
// read (the project then has none, as before).
func (s *Service) dynamicRangeOf(ctx context.Context, p *store.Project) *probe.DynamicRange {
	d, err := dynamicSource(ctx, s, p)
	if err != nil {
		slog.WarnContext(ctx, "source dynamic range unread", "project_id", p.ID, "err", err)
		return nil
	}
	return d
}

// hdrSource: the project's video is HDR (HLG, PQ, or Dolby Vision 8 on an
// HLG/PQ base).
func hdrSource(p *store.Project) bool {
	if p.Probe == nil {
		return false
	}
	d := probe.DynamicRange{Range: p.Probe.DynamicRange, Base: p.Probe.DynamicRangeBase}
	return d.HDR()
}

// hdrOn: HDR output is switched on (the cached config, bounded).
func (s *Service) hdrOn(ctx context.Context) bool {
	if s.Pricing == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return s.Pricing.Rates(ctx).LifelikeHDROutputEnabled
}

// dolbyVision5: the project's source has no displayable base layer.
func dolbyVision5(p *store.Project) bool {
	return p.Probe != nil && p.Probe.DynamicRange == probe.RangeDV5
}
