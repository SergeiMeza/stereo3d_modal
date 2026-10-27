package api

import (
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// A deleted web account kept a failed $3.33 batch nobody could settle
// (2026-10-27): deletion now waits until nothing collectable is owed.
func TestDeletionBlock(t *testing.T) {
	open := func(cents int64) *store.Batch { return &store.Batch{TotalCents: cents} }
	cases := []struct {
		name                         string
		active, unpaid, failedOrBusy int
		open                         *store.Batch
		want                         string
	}{
		{"nothing owed", 0, 0, 0, nil, ""},
		{"empty open batch", 0, 0, 0, open(0), ""},
		{"pending below the card minimum", 0, 0, 0, open(5), ""},
		{"pending the charge didn't collect", 0, 0, 0, open(333), deleteBlockOwed},
		{"failed charge", 0, 1, 0, nil, deleteBlockOwed},
		{"failed or in-flight batch", 0, 0, 1, nil, deleteBlockOwed},
		{"run still going", 1, 0, 0, nil, deleteBlockActive},
		{"run going and owing", 1, 1, 1, open(333), deleteBlockActive},
	}
	for _, tc := range cases {
		if got := deletionBlock(tc.active, tc.unpaid, tc.failedOrBusy, tc.open, 50); got != tc.want {
			t.Errorf("%s: got %q, want %q", tc.name, got, tc.want)
		}
	}
}
