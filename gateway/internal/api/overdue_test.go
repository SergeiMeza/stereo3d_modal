package api

import (
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func TestOverdueAfter(t *testing.T) {
	cases := []struct {
		expected int64
		want     time.Duration
	}{
		{0, 45 * time.Minute},              // no estimate
		{60, time.Minute + 15*time.Minute}, // short run: 15 min of slack
		{30 * 60, time.Hour},               // estimate doubled
		{3 * 3600, 4 * time.Hour},          // long run: an hour of slack
	}
	for _, tc := range cases {
		if got := overdueAfter(tc.expected); got != tc.want {
			t.Errorf("expected %ds: got %s, want %s", tc.expected, got, tc.want)
		}
	}
}

// 2026-10-27: a 5-minute depth run sat at "Profiling scenes" for hours.
func TestIsOverdue(t *testing.T) {
	now := time.Now()
	submitted := now.Add(-3 * time.Hour)
	run := func(state string) *store.Conversion {
		c := &store.Conversion{State: state, CreatedAt: submitted}
		c.Modal.SubmittedAt = &submitted
		c.Support.ExpectedSeconds = 300
		return c
	}
	if !isOverdue(run(store.StateProcessing), now) {
		t.Error("processing for 3 h on a 5 min estimate should be overdue")
	}
	if !isOverdue(run(store.StatePaid), now) {
		t.Error("waiting 3 h for submission should be overdue")
	}
	if isOverdue(run(store.StateCreated), now) {
		t.Error("waiting for the user's bank is not overdue")
	}
	if isOverdue(run(store.StateSucceeded), now) {
		t.Error("a finished run is never overdue")
	}
	fresh := run(store.StateProcessing)
	recent := now.Add(-10 * time.Minute)
	fresh.Modal.SubmittedAt = &recent
	if isOverdue(fresh, now) {
		t.Error("10 min into a 5 min estimate is still within the slack")
	}
}

// Once Lifelike reports a live eta_seconds it is the run's time left;
// until then the run's own estimate less the time it ran (not the GPU
// wait), at least a minute.
func TestRunETA(t *testing.T) {
	now := time.Now()
	started := now.Add(-200 * time.Second)
	c := &store.Conversion{State: store.StateProcessing, Support: store.Support{ExpectedSeconds: 701},
		Modal: store.Modal{SubmittedAt: &started}}
	if eta, src := runETA(c, now); eta != 501 || src != "estimate" {
		t.Fatalf("estimate %d %s", eta, src)
	}
	c.Modal.QueuedS = 100 // waited for a GPU: not counted as running
	if eta, _ := runETA(c, now); eta != 601 {
		t.Fatalf("after a GPU wait %d", eta)
	}
	c.Modal.WaitingForGPU = true
	if eta, _ := runETA(c, now); eta != 701 {
		t.Fatalf("waiting %d", eta)
	}
	c.Modal.WaitingForGPU, c.Modal.ETASeconds = false, 900 // live, even when longer
	if eta, src := runETA(c, now); eta != 900 || src != "live" {
		t.Fatalf("live %d %s", eta, src)
	}
	c.Modal.ETASeconds, c.Modal.QueuedS = 0, 0
	long := now.Add(-2 * time.Hour)
	c.Modal.SubmittedAt = &long
	if eta, _ := runETA(c, now); eta != etaFloorSeconds {
		t.Fatalf("past the estimate %d", eta)
	}
	if eta, src := runETA(&store.Conversion{State: store.StateSucceeded}, now); eta != 0 || src != "" {
		t.Fatalf("ended %d %s", eta, src)
	}
}
