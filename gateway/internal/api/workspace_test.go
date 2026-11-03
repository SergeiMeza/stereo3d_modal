package api

import (
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// S3D-40: runs and projects go to their own workspace; records without
// one read as the default; an unknown one is never routed elsewhere.
func TestWorkspaceRouting(t *testing.T) {
	def, defLL := modalapi.New("https://ws1--a", "", ""), modalapi.New("https://ws1--b", "", "")
	other := &Workspace{ID: "ws2", Modal: modalapi.New("https://ws2--a", "", "")}
	s := &Service{Modal: def, Lifelike: defLL, DefaultWorkspaceID: "ws1", ExtraWorkspaces: map[string]*Workspace{"ws2": other}}

	if s.modalFor(&store.Conversion{}) != def || s.modalFor(&store.Conversion{Method: store.MethodLifelike}) != defLL {
		t.Error("unset workspace is not the default")
	}
	if s.modalFor(&store.Conversion{Workspace: "ws1", Method: store.MethodLifelike}) != defLL {
		t.Error("default by id")
	}
	if s.modalFor(&store.Conversion{Workspace: "ws2"}) != other.Modal {
		t.Error("classic run in ws2")
	}
	if s.modalFor(&store.Conversion{Workspace: "ws2", Method: store.MethodLifelike}) != nil {
		t.Error("ws2 has no Lifelike: must not fall back to the default's")
	}
	if s.modalFor(&store.Conversion{Workspace: "gone"}) != nil {
		t.Error("unknown workspace routed somewhere")
	}
	if !s.lifelikeIn(&store.Project{}) || s.lifelikeIn(&store.Project{Workspace: "ws2"}) {
		t.Error("lifelikeIn")
	}
	if _, err := s.projectWorkspace(&store.Project{Workspace: "gone"}); err == nil {
		t.Error("unknown project workspace accepted")
	}
	if ws := s.assignWorkspace(); ws.ID != "ws1" || ws.Modal != def {
		t.Errorf("new projects go to the default today: %+v", ws)
	}
	if s.workspaceID("") != "ws1" || s.workspaceID("ws2") != "ws2" {
		t.Error("workspaceID")
	}
}
