package api

import (
	"context"
	"log/slog"
	"net/http"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/probe"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// HDR output (owner 2026-11-05): analysis reads the source's dynamic
// range; HDR sources may ask Lifelike for HDR output (hdr: true), an
// add-on included in every plan. Hidden entirely while
// lifelike_hdr_output_enabled is off. Dolby Vision without a displayable
// base layer (dv_5) is refused whatever the switch.

// errDolbyVision5Text is the refusal of a dv_5 source, without HDR.
const errDolbyVision5Text = "This video uses a Dolby Vision format that can't be converted. " +
	"Export it again from your camera or editing app as a standard video, then upload that."

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

// hdrRequestError: why a run can't ask for HDR output (422), nil when it
// can. Hidden while switched off; only Lifelike, only from an HDR source.
func (s *Service) hdrRequestError(ctx context.Context, p *store.Project) *httpx.APIError {
	switch {
	case !s.hdrOn(ctx):
		return httpx.Err(http.StatusUnprocessableEntity, "feature_unavailable", "hdr isn't available")
	case projectMethod(p) != store.MethodLifelike:
		return httpx.Err(http.StatusUnprocessableEntity, "hdr_unavailable", "HDR output is only for Lifelike 3D.")
	case !hdrSource(p):
		return httpx.Err(http.StatusUnprocessableEntity, "hdr_unavailable", "This video isn't HDR, so it can't get HDR output.")
	}
	return nil
}
