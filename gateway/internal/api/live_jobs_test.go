package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Owner 2026-11-07: analysis and shot-profiling progress reach an open
// stream with no GET — the stream's job watcher polls Modal and writes
// the progress (throttled) onto the project, and project.updated carries
// it; the watcher stops when the job ends or the stream closes.
func TestLiveJobProgressOverTheStream(t *testing.T) {
	prevPoll := liveJobPoll
	liveJobPoll = 100 * time.Millisecond
	t.Cleanup(func() { liveJobPoll = prevPoll })
	s, srv := eventsService(t, nil)
	ctx := context.Background()
	var mu sync.Mutex
	job := map[string]any{"job_id": "job_a", "status": "in_progress", "stage": "probe", "progress": 0.1,
		"progress_detail": map[string]any{"eta_seconds": 90}}
	profile := map[string]any{"job_id": "job_p", "status": "in_progress", "stage": "shots", "progress": 0.2}
	polls := 0
	modal := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		polls++
		if r.URL.Path == "/v1/jobs/job_p" {
			json.NewEncoder(w).Encode(profile)
			return
		}
		json.NewEncoder(w).Encode(job)
	}))
	t.Cleanup(modal.Close)
	s.Modal = modalapi.New(modal.URL, "", "")
	uid := "u" + store.NewID()
	p := &store.Project{ID: store.NewID(), UID: uid, Name: "Kyoto", Analyze: store.Analyze{State: store.AnalyzeRunning, JobID: "job_a"},
		Profile: &store.ProfileJob{JobID: "job_p", State: "running"}}
	if err := s.Store.CreateProject(ctx, p); err != nil {
		t.Fatal(err)
	}
	c := openStream(t, srv, uid, "", "")
	c.next("snapshot", 5*time.Second)
	// the watcher's first poll: progress 0.1 / 0.2 onto the project, then over the stream
	waitFor := func(want func(map[string]any) bool) map[string]any {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			_, d := c.next("project.updated", 5*time.Second)
			if pj, _ := d["project"].(map[string]any); pj != nil && want(pj) {
				return pj
			}
		}
		t.Fatal("no matching project.updated")
		return nil
	}
	pj := waitFor(func(pj map[string]any) bool {
		a, _ := pj["analyze"].(map[string]any)
		return a["progress"] == 0.1 && a["stage"] == "probe" && a["eta_seconds"] == float64(90)
	})
	if pr, _ := pj["profile"].(map[string]any); pr == nil {
		t.Fatalf("profile %v", pj["profile"])
	}
	// it moves: the stream follows, profile too
	mu.Lock()
	job["progress"], job["stage"] = 0.6, "scenes"
	profile["progress"] = 0.7
	mu.Unlock()
	waitFor(func(pj map[string]any) bool {
		a, _ := pj["analyze"].(map[string]any)
		pr, _ := pj["profile"].(map[string]any)
		return a["progress"] == 0.6 && a["stage"] == "scenes" && pr["progress"] == 0.7
	})
	if n := s.liveJobCount(); n != 1 {
		t.Fatalf("watchers %d", n)
	}
	// the stream closes: the watcher stops polling
	c.resp.Body.Close()
	deadline := time.Now().Add(3 * time.Second)
	for s.liveJobCount() != 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	if n := s.liveJobCount(); n != 0 {
		t.Fatalf("watchers after close %d", n)
	}
	mu.Lock()
	before := polls
	mu.Unlock()
	time.Sleep(4 * liveJobPoll)
	mu.Lock()
	after := polls
	mu.Unlock()
	if after != before {
		t.Fatalf("still polling after the stream closed: %d → %d", before, after)
	}
}

// The throttle: a small change within 5 s isn't written; a 5-point move
// or a new stage is; a job that isn't the project's running one never is.
func TestSetJobProgressThrottle(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	p := &store.Project{ID: store.NewID(), UID: "u1", Analyze: store.Analyze{State: store.AnalyzeRunning, JobID: "job_a"}}
	s.Store.CreateProject(ctx, p)
	now := time.Now()
	w := func(prog float64, stage string, at time.Time) bool {
		ok, err := s.Store.SetJobProgress(ctx, p.ID, store.JobAnalyze, "job_a", store.JobProgress{Progress: prog, Stage: stage}, at)
		if err != nil {
			t.Fatal(err)
		}
		return ok
	}
	if !w(0.10, "probe", now) || w(0.10, "probe", now.Add(time.Second)) || w(0.12, "probe", now.Add(2*time.Second)) {
		t.Fatal("first write, then same and small within 5 s")
	}
	if !w(0.12, "probe", now.Add(6*time.Second)) || !w(0.20, "probe", now.Add(7*time.Second)) || !w(0.21, "scenes", now.Add(8*time.Second)) {
		t.Fatal("after 5 s, a 5-point move, a new stage")
	}
	if ok, _ := s.Store.SetJobProgress(ctx, p.ID, store.JobAnalyze, "job_old", store.JobProgress{Progress: 0.9}, now.Add(time.Minute)); ok {
		t.Fatal("another job wrote")
	}
	got, _ := s.Store.GetProject(ctx, p.ID)
	if got.Analyze.Progress != 0.21 || got.Analyze.Stage != "scenes" || got.Analyze.ProgressAt == nil {
		t.Fatalf("%+v", got.Analyze)
	}
}
