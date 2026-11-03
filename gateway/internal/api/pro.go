package api

import (
	"context"
	"log/slog"
)

// isPro reports whether uid holds SVS Pro (S3D-67). Any doubt — no
// RevenueCat key, a timeout, an error — is "no": the run is charged list
// price and never blocked.
func (s *Service) isPro(ctx context.Context, uid string) bool {
	if !s.RevenueCat.Configured() {
		return false
	}
	st, err := s.RevenueCat.Pro(ctx, uid)
	if err != nil {
		slog.WarnContext(ctx, "pro check failed (list price)", "uid", uid, "err", err)
		return false
	}
	return st.Pro
}
