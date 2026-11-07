package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Classic 3D is retired for new projects: a new Classic project is 422
// classic_retired, so is a Classic project that never ran Classic; one
// that did keeps going; Lifelike projects are untouched.
func TestClassicRetired(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	rec := httptest.NewRecorder()
	s.HandleCreateProject(rec, httptest.NewRequest("POST", "/", strings.NewReader(`{"gcs_key":"x.mp4","method":"classic"}`)), &AuthedUser{UID: "u1"})
	if rec.Code != http.StatusUnprocessableEntity || !strings.Contains(rec.Body.String(), "classic_retired") {
		t.Fatalf("create classic: %d %s", rec.Code, rec.Body)
	}
	never := &store.Project{ID: store.NewID(), UID: "u1", Method: store.MethodClassic}
	s.Store.CreateProject(ctx, never)
	if err := s.requireClassicAllowed(ctx, never); err == nil || err.Code != "classic_retired" {
		t.Fatalf("never ran: %v", err)
	}
	ran := &store.Project{ID: store.NewID(), UID: "u1"} // "" = classic
	s.Store.CreateProject(ctx, ran)
	now := time.Now()
	old := &store.Conversion{ID: store.NewID(), UID: "u1", ProjectID: ran.ID, State: store.StateSucceeded, Kind: "video", Step: store.StepStereoPreview}
	old.Modal.SubmittedAt = &now
	s.Store.CreateConversion(ctx, old)
	if err := s.requireClassicAllowed(ctx, ran); err != nil {
		t.Fatalf("ran Classic: %v", err)
	}
	if p, _ := s.Store.GetProject(ctx, ran.ID); !p.ClassicRan {
		t.Fatal("remembered")
	}
	if err := s.requireClassicAllowed(ctx, &store.Project{ID: "x", Method: store.MethodLifelike}); err != nil {
		t.Fatal("lifelike untouched")
	}
	if pub := s.Pricing.Public(ctx); pub["classic_new_projects"] != false {
		t.Fatalf("pricing flag %v", pub["classic_new_projects"])
	}
}
