package api

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Live job progress (owner 2026-11-07): a project's analyze and shot
// profiling report progress, stage and ETA only from the Modal job. While
// a live stream on this instance shows a project with one running, a
// watcher polls the job every liveJobPoll and writes its progress onto the
// project (throttled in SetJobProgress: at most every 5 s unless it moved
// 5 points), so project.updated carries it without any GET. One watcher
// per project per instance, however many streams show it; it stops when
// the last stream lets go or the job ends. Other instances' watchers write
// through the same throttle.

// liveJobPoll: how often a watched job is polled (a variable for tests).
var liveJobPoll = 5 * time.Second

type liveJobs struct {
	mu sync.Mutex
	w  map[string]*liveJob
}

type liveJob struct {
	refs int
	stop chan struct{}
}

// saveJobProgress writes a running job's progress (throttled); a failure
// only costs that update.
func (s *Service) saveJobProgress(ctx context.Context, projectID, kind, jobID string, jp store.JobProgress) {
	if s.Store == nil || jobID == "" {
		return
	}
	if _, err := s.Store.SetJobProgress(ctx, projectID, kind, jobID, jp, time.Now()); err != nil {
		slog.DebugContext(ctx, "job progress not written", "project_id", projectID, "job", kind, "err", err)
	}
}

// jobRunning: the project has an analyze or a shot profiling running.
func jobRunning(p *store.Project) bool {
	return p != nil && !p.Deleted && (p.Analyze.State == store.AnalyzeRunning || p.Profile != nil && p.Profile.State == "running")
}

// watchProjectJobs holds a watcher on projectID's running jobs; the
// returned release lets go of it (safe to call twice).
func (s *Service) watchProjectJobs(projectID string) (release func()) {
	s.liveJobsOnce.Do(func() { s.liveJobs = &liveJobs{w: map[string]*liveJob{}} })
	lj := s.liveJobs
	lj.mu.Lock()
	j := lj.w[projectID]
	if j == nil {
		j = &liveJob{stop: make(chan struct{})}
		lj.w[projectID] = j
		go s.runJobWatcher(projectID, j)
	}
	j.refs++
	lj.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			lj.mu.Lock()
			defer lj.mu.Unlock()
			j.refs--
			if j.refs == 0 && lj.w[projectID] == j {
				delete(lj.w, projectID)
				close(j.stop)
			}
		})
	}
}

func (s *Service) runJobWatcher(projectID string, j *liveJob) {
	t := time.NewTicker(liveJobPoll)
	defer t.Stop()
	done := func() { // the job ended: drop the entry so a new one can start
		s.liveJobs.mu.Lock()
		if s.liveJobs.w[projectID] == j {
			delete(s.liveJobs.w, projectID)
		}
		s.liveJobs.mu.Unlock()
	}
	for {
		select {
		case <-j.stop:
			return
		case <-t.C:
		}
		ctx, cancel := context.WithTimeout(context.Background(), modalCallTimeout)
		p, err := s.Store.GetProject(ctx, projectID)
		if err == nil && !jobRunning(p) {
			cancel()
			done()
			return
		}
		if err == nil && p.Analyze.State == store.AnalyzeRunning {
			if _, aerr := s.refreshAnalyze(ctx, p); aerr != nil {
				slog.DebugContext(ctx, "live analyze poll failed", "project_id", projectID, "err", aerr)
			}
		}
		if err == nil && p.Profile != nil && p.Profile.State == "running" {
			if _, perr := s.refreshProfile(ctx, p); perr != nil {
				slog.DebugContext(ctx, "live profile poll failed", "project_id", projectID, "err", perr)
			}
		}
		cancel()
	}
}

// liveJobCount: watchers running on this instance (tests, diagnostics).
func (s *Service) liveJobCount() int {
	if s.liveJobs == nil {
		return 0
	}
	s.liveJobs.mu.Lock()
	defer s.liveJobs.mu.Unlock()
	return len(s.liveJobs.w)
}
