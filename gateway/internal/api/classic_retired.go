package api

import (
	"context"
	"net/http"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Classic 3D is retired for new projects (owner 2026-11-04). Nobody can
// start a new Classic project, and a Classic project that never ran
// Classic can't start now: create, analyse, quote, profile and run answer
// 422 classic_retired. A project that already ran Classic keeps it (its
// files, downloads, plays and further Classic runs) and can switch to
// Lifelike 3D at any time (PATCH {method: "lifelike"}); its Classic
// outputs stay downloadable. The mobile one-shot route is not a project
// and is unchanged.

func errClassicRetired() *httpx.APIError {
	return httpx.Err(http.StatusUnprocessableEntity, "classic_retired", "Classic 3D is no longer available for new projects.")
}

// classicAllowed: the project already ran Classic (a run submitted or
// delivered), so it may go on with it.
func (s *Service) classicAllowed(ctx context.Context, p *store.Project) bool {
	if p.ClassicRan {
		return true
	}
	convs, err := s.Store.ListProjectConversions(ctx, p.ID, 200)
	if err != nil {
		return false
	}
	for _, c := range convs {
		if store.MethodOr(c.Method) == store.MethodClassic && (c.Modal.SubmittedAt != nil || c.State == store.StateSucceeded) {
			s.Store.UpdateProject(ctx, p.ID, func(pp *store.Project) error { pp.ClassicRan = true; return nil })
			return true
		}
	}
	return false
}

// requireClassicAllowed is the gate for Classic projects.
func (s *Service) requireClassicAllowed(ctx context.Context, p *store.Project) *httpx.APIError {
	if projectMethod(p) != store.MethodClassic || s.classicAllowed(ctx, p) {
		return nil
	}
	return errClassicRetired()
}
