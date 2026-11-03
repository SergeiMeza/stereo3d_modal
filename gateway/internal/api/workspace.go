package api

import (
	"context"
	"fmt"
	"net/http"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Modal workspaces (S3D-40). A project lives in one Modal workspace,
// recorded at creation (store.Project.Workspace); its runs copy it
// (store.Conversion.Workspace). Every submit, status poll, reuse lookup
// and cancel of the project and its runs goes to that workspace's
// pipelines, and the GPU cap and queue are per workspace. Records
// without the field (made before) read as the default workspace. Today
// there is one workspace; more come from config (MODAL_WORKSPACES).

// Workspace is one workspace's pipeline clients. Lifelike nil = the
// method is off there.
type Workspace struct {
	ID       string
	Modal    *modalapi.Client
	Lifelike *modalapi.Client
}

// NewWorkspace builds a workspace's clients from its config.
func NewWorkspace(w config.Workspace) *Workspace {
	ws := &Workspace{ID: w.ID, Modal: modalapi.New(w.ModalBaseURL, w.ModalTokenID, w.ModalTokenSecret)}
	if w.LifelikeBaseURL != "" {
		ws.Lifelike = modalapi.New(w.LifelikeBaseURL, w.LifelikeTokenID, w.LifelikeTokenSecret)
	}
	return ws
}

// workspaceID is a record's workspace, the default when unset.
func (s *Service) workspaceID(id string) string {
	if id == "" {
		return s.DefaultWorkspaceID
	}
	return id
}

// workspace resolves an id ("" = default). ok false = a workspace the
// config no longer has: its work can't be reached, and is never routed
// elsewhere.
func (s *Service) workspace(id string) (*Workspace, bool) {
	if id == "" || id == s.DefaultWorkspaceID {
		return &Workspace{ID: s.DefaultWorkspaceID, Modal: s.Modal, Lifelike: s.Lifelike}, true
	}
	ws, ok := s.ExtraWorkspaces[id]
	return ws, ok
}

// projectWorkspace is a project's workspace; an unknown one answers an
// error for the request.
func (s *Service) projectWorkspace(p *store.Project) (*Workspace, error) {
	ws, ok := s.workspace(p.Workspace)
	if !ok {
		return nil, fmt.Errorf("project %s: workspace %q is not configured", p.ID, p.Workspace)
	}
	return ws, nil
}

// assignWorkspace picks the workspace for a new project: the default
// today (one workspace); with several, the place to balance by load.
func (s *Service) assignWorkspace() *Workspace {
	ws, _ := s.workspace("")
	return ws
}

func errWorkspaceUnavailable() error {
	return httpx.Err(http.StatusServiceUnavailable, "upstream_error",
		"this project's processing service is unavailable; try again later")
}

// projectJob polls one of a project's free jobs (analyze, profile) in
// the project's workspace.
func (s *Service) projectJob(ctx context.Context, p *store.Project, jobID string) (*modalapi.Job, error) {
	ws, err := s.projectWorkspace(p)
	if err != nil {
		return nil, err
	}
	return ws.Modal.GetJob(ctx, jobID)
}
