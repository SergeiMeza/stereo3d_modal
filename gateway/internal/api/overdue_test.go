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
