package api

import (
	"context"
	"net/http"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// New-account limits (spec v6 B14, S3D-64 amended by BL-08): an account
// with no saved reusable method and no successful payment keeps at most 3
// projects and 10 GB of uploads. Any successful payment, or a saved
// method, lifts them. Deleting a project frees room. Web projects only.
const (
	limitProjects = 3
	limitBytes    = int64(10) << 30
)

type accountLimits struct {
	Limited      bool
	ProjectsLeft int
	BytesLeft    int64
}

// Reached: no room for another project or upload.
func (l accountLimits) Reached() bool { return l.Limited && (l.ProjectsLeft <= 0 || l.BytesLeft <= 0) }

func (l accountLimits) JSON() map[string]any {
	if !l.Limited {
		return map[string]any{"limited": false, "reached": false}
	}
	return map[string]any{"limited": true, "reached": l.Reached(), "projects_left": max(l.ProjectsLeft, 0), "bytes_left": max(l.BytesLeft, 0),
		"max_projects": limitProjects, "max_bytes": limitBytes}
}

func limitsApply(c *store.Customer) bool {
	if c == nil {
		return true
	}
	return c.DefaultPaymentMethod == "" && len(c.PaidMethods) == 0 && c.LifetimePaidCents <= 0 && !c.PaidOnce
}

// limitsFor reads an account's B14 room.
func (s *Service) limitsFor(ctx context.Context, uid string) accountLimits {
	if s.Store == nil {
		return accountLimits{}
	}
	cust, _ := s.Store.GetCustomer(ctx, uid)
	if !limitsApply(cust) {
		return accountLimits{}
	}
	projects, err := s.Store.ListUserProjects(ctx, uid, 200)
	if err != nil {
		return accountLimits{} // never block on a read error
	}
	n, bytes := 0, int64(0)
	for _, p := range projects {
		if p.Deleted {
			continue
		}
		n++
		bytes += p.Source.Bytes
	}
	return accountLimits{Limited: true, ProjectsLeft: limitProjects - n, BytesLeft: limitBytes - bytes}
}

// errSaveMethodForMore is the 403 past the limits (P11).
func errSaveMethodForMore(l accountLimits) error {
	e := httpx.Err(http.StatusForbidden, "save_method_for_more",
		"make your first 3D video or save a payment method to keep more than 3 projects and 10 GB of uploads")
	e.Details = l.JSON()
	return e
}

// checkNewProjectRoom refuses a web project (or an upload of size bytes)
// past the limits.
func (s *Service) checkNewProjectRoom(ctx context.Context, uid string, bytes int64) error {
	l := s.limitsFor(ctx, uid)
	if !l.Limited {
		return nil
	}
	if l.ProjectsLeft <= 0 || bytes > l.BytesLeft {
		return errSaveMethodForMore(l)
	}
	return nil
}
