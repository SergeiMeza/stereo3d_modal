package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// fakeAnalyze serves analyze jobs from a table and counts re-runs.
type fakeAnalyze struct {
	mu       sync.Mutex
	jobs     map[string]map[string]any
	submits  int
	canceled []string
}

func (f *fakeAnalyze) server(t *testing.T) *modalapi.Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/analyze":
			f.submits++
			id := "rerun" + itoa(f.submits)
			f.jobs[id] = map[string]any{"job_id": id, "status": "in_progress", "stage": "proxy", "created_at": float64(time.Now().Unix())}
			json.NewEncoder(w).Encode(map[string]any{"job_id": id, "status": "pending"})
		case r.Method == http.MethodDelete:
			f.canceled = append(f.canceled, strings.TrimPrefix(r.URL.Path, "/v1/jobs/"))
			w.Write([]byte(`{}`))
		case strings.HasPrefix(r.URL.Path, "/v1/jobs/"):
			j, ok := f.jobs[strings.TrimPrefix(r.URL.Path, "/v1/jobs/")]
			if !ok {
				w.WriteHeader(404)
				w.Write([]byte(`{"detail":"unknown job"}`))
				return
			}
			json.NewEncoder(w).Encode(j)
		default:
			w.WriteHeader(404)
		}
	}))
	t.Cleanup(srv.Close)
	return modalapi.New(srv.URL, "", "")
}

// An analyze whose call ended without a result (failed, lost, past the
// hard cap, call history expired) runs once more under the same project,
// then fails; one still inside the cap keeps running (3DS 2026-11-05: a
// 6 s clip read "Thumbnails… 70%" for minutes).
func TestAnalyzeEndedRerunsThenFails(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	old := float64(time.Now().Add(-3 * time.Hour).Unix())
	recent := float64(time.Now().Add(-5 * time.Minute).Unix())
	for _, tc := range []struct {
		name  string
		job   map[string]any // nil = the record is gone (404)
		rerun bool
	}{
		{"failed", map[string]any{"status": "failed", "error": "ffmpeg crashed", "created_at": recent}, true},
		{"lost", nil, true},
		{"past the hard cap", map[string]any{"status": "in_progress", "stage": "thumbnails", "progress": 0.7, "created_at": old}, true},
		{"call history expired", map[string]any{"status": "in_progress", "created_at": recent,
			"error": "worker call history expired before completion was recorded"}, true},
		{"still running", map[string]any{"status": "in_progress", "stage": "thumbnails", "progress": 0.7, "created_at": recent}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := &fakeAnalyze{jobs: map[string]map[string]any{}}
			if tc.job != nil {
				tc.job["job_id"] = "j1"
				f.jobs["j1"] = tc.job
			}
			s.Modal = f.server(t)
			p := &store.Project{ID: store.NewID(), UID: "u" + store.NewID(), Method: store.MethodLifelike,
				Source:  store.Source{GCSKey: "stereo3d/test/users/u/p/source.mp4", Bytes: 1 << 20},
				Analyze: store.Analyze{State: store.AnalyzeRunning, JobID: "j1"}}
			if err := s.Store.CreateProject(ctx, p); err != nil {
				t.Fatal(err)
			}
			got, err := s.refreshAnalyze(ctx, p)
			if err != nil {
				t.Fatal(err)
			}
			if !tc.rerun {
				if got.Analyze.State != store.AnalyzeRunning || got.Analyze.JobID != "j1" || f.submits != 0 || got.Analyze.Progress != 0.7 {
					t.Fatalf("still running %+v submits %d", got.Analyze, f.submits)
				}
				return
			}
			if got.Analyze.State != store.AnalyzeRunning || got.Analyze.JobID != "rerun1" || got.Analyze.Retries != 1 || f.submits != 1 {
				t.Fatalf("re-run %+v submits %d", got.Analyze, f.submits)
			}
			// the re-run ends the same way: failed now, never stuck
			f.mu.Lock()
			f.jobs["rerun1"]["status"] = "failed"
			f.jobs["rerun1"]["error"] = "again"
			f.mu.Unlock()
			got, err = s.refreshAnalyze(ctx, got)
			if err != nil || got.Analyze.State != store.AnalyzeFailed || f.submits != 1 {
				t.Fatalf("second end %+v %v submits %d", got.Analyze, err, f.submits)
			}
		})
	}
}

func TestAnalyzeStuck(t *testing.T) {
	now := time.Now()
	if r := analyzeStuck(&modalapi.Job{Status: "in_progress", CreatedAt: float64(now.Add(-analyzeHardCap - time.Minute).Unix())}, now); r == "" {
		t.Fatal("past the cap")
	}
	if r := analyzeStuck(&modalapi.Job{Status: "in_progress", CreatedAt: float64(now.Add(-time.Hour).Unix())}, now); r != "" {
		t.Fatalf("inside the cap: %q", r)
	}
	if r := analyzeStuck(&modalapi.Job{Status: "in_progress"}, now); r != "" {
		t.Fatalf("no start time: %q", r)
	}
}
