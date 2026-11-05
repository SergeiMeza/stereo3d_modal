package api

import (
	"context"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The balance block names the prepaid part alone (without the plan's
// usage credit), with its own freezes and expiry; the whole stays in
// balance_cents as before.
func TestBalancePrepaidPart(t *testing.T) {
	s, _ := e0Service(t)
	exp := time.Now().Add(300 * 24 * time.Hour).UTC().Truncate(time.Second)
	reset := time.Now().Add(20 * 24 * time.Hour)
	b := store.NewBalance("u1")
	b.Fifo = []store.FifoItem{
		{TopupID: "plan_in_1", RemainingCents: 40000, PlanCredit: true, ExpiresAt: &reset, FrozenCents: 1000},
		{TopupID: "t1", RemainingCents: 2500, FrozenCents: 500},
	}
	b.BalanceCents, b.FrozenCents, b.ExpiresAt = 42500, 1500, &exp
	out := s.balanceSummary(context.Background(), "u1", b)
	if out["balance_cents"] != int64(42500) || out["prepaid_cents"] != int64(2500) || out["plan_credit_cents"] != int64(40000) ||
		out["prepaid_frozen_cents"] != int64(500) || out["prepaid_expires_at"] != exp.Format(time.RFC3339) || out["frozen_cents"] != int64(1500) {
		t.Fatalf("summary %v", out)
	}
	// only plan credit: no prepaid expiry to show
	b.Fifo, b.BalanceCents, b.FrozenCents = b.Fifo[:1], 40000, 1000
	if out := s.balanceSummary(context.Background(), "u1", b); out["prepaid_cents"] != int64(0) || out["prepaid_expires_at"] != nil || out["prepaid_frozen_cents"] != int64(0) {
		t.Fatalf("plan credit only %v", out)
	}
}
