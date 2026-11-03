package api

import (
	"log/slog"
	"net/http"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
)

// ProStatus is GET /v1/pro and POST /v1/pro/refresh (S3D-68): whether the
// signed-in person holds Spatial Video Studio Pro, by the same rule the
// quotes use. known is false when RevenueCat couldn't tell (not configured,
// down); the page then shows the plans rather than claiming either way.
type ProStatus struct {
	Pro   bool   `json:"pro"`
	Via   string `json:"via,omitempty"`
	Known bool   `json:"known"`
}

func proStatusOf(st revenuecat.Status, err error) ProStatus {
	if err != nil {
		return ProStatus{}
	}
	return ProStatus{Pro: st.Pro, Via: st.Via, Known: true}
}

// HandleProStatus answers from the 10-minute cache.
func (s *Service) HandleProStatus(w http.ResponseWriter, r *http.Request, u *AuthedUser) {
	if !s.RevenueCat.Configured() {
		httpx.WriteOK(w, ProStatus{})
		return
	}
	st, err := s.RevenueCat.Pro(r.Context(), u.UID)
	if err != nil {
		slog.WarnContext(r.Context(), "pro status unknown", "uid", u.UID, "err", err)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, proStatusOf(st, err))
}

// HandleProRefresh asks RevenueCat again, skipping the cache: the web calls
// it right after a purchase so the next quote carries the Pro discount.
func (s *Service) HandleProRefresh(w http.ResponseWriter, r *http.Request, u *AuthedUser) {
	if !s.RevenueCat.Configured() {
		httpx.WriteOK(w, ProStatus{})
		return
	}
	st, err := s.RevenueCat.Fresh(r.Context(), u.UID)
	if err != nil {
		slog.WarnContext(r.Context(), "pro refresh failed", "uid", u.UID, "err", err)
	} else {
		slog.InfoContext(r.Context(), "pro refreshed", "uid", u.UID, "pro", st.Pro, "via", st.Via)
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, proStatusOf(st, err))
}
