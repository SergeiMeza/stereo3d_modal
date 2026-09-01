package pricing

import (
	"testing"
	"time"
)

func TestBatchCapTiers(t *testing.T) {
	r := defaults()
	cases := []struct {
		paid int64
		want int64
	}{
		{0, 5000}, {19999, 5000}, {20000, 15000}, {99999, 15000},
		{100000, 40000}, {500000, 100000}, {10_000_000, 100000},
	}
	for _, c := range cases {
		if got := r.BatchCap(c.paid); got != c.want {
			t.Errorf("BatchCap(%d) = %d, want %d", c.paid, got, c.want)
		}
	}
	// A Firestore doc with no tiers (or nonsense) still yields the base cap.
	empty := &Rates{}
	if got := empty.BatchCap(1_000_000); got != 5000 {
		t.Errorf("empty tiers: got %d, want base 5000", got)
	}
}

func TestNextBatchTier(t *testing.T) {
	r := defaults()
	if n := r.NextBatchTier(0); n == nil || n.MinPaidCents != 20000 {
		t.Errorf("next tier from 0: %+v", n)
	}
	if n := r.NextBatchTier(150000); n == nil || n.MinPaidCents != 500000 {
		t.Errorf("next tier from 150000: %+v", n)
	}
	if n := r.NextBatchTier(500000); n != nil {
		t.Errorf("top tier should have no next, got %+v", n)
	}
}

func TestBatchWindow(t *testing.T) {
	if w := defaults().BatchWindow(); w != 4*time.Hour {
		t.Errorf("default window %v", w)
	}
	if w := (&Rates{BatchWindowHours: 0.25}).BatchWindow(); w != 15*time.Minute {
		t.Errorf("fractional window %v", w)
	}
	if w := (&Rates{BatchWindowHours: -1}).BatchWindow(); w != 4*time.Hour {
		t.Errorf("negative window should fall back, got %v", w)
	}
}
