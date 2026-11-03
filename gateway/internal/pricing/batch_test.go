package pricing

import (
	"context"
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
	if w := defaults().BatchWindow(); w != time.Hour {
		t.Errorf("new accounts: 1 h, got %v", w)
	}
	if w := (&Rates{BatchWindowHours: 0.25}).BatchWindow(); w != 15*time.Minute {
		t.Errorf("flat window override (the test env's 0.25 h): %v", w)
	}
	if w := (&Rates{BatchWindowHours: -1}).BatchWindow(); w != time.Hour {
		t.Errorf("negative window should fall back, got %v", w)
	}
}

// S3D-19: the window grows with the paid record, like the cap; a recent
// declined charge drops both to a new account's.
func TestBatchTierWindows(t *testing.T) {
	r := defaults()
	cases := []struct {
		paid   int64
		cap    int64
		window time.Duration
	}{
		{0, 5000, time.Hour}, {20000, 15000, 4 * time.Hour},
		{100000, 40000, 12 * time.Hour}, {500000, 100000, 24 * time.Hour},
	}
	for _, c := range cases {
		tier := r.BatchTierFor(c.paid, false)
		if tier.CapCents != c.cap || tier.Window() != c.window {
			t.Errorf("paid %d: %+v", c.paid, tier)
		}
		if failed := r.BatchTierFor(c.paid, true); failed.CapCents != 5000 || failed.Window() != time.Hour {
			t.Errorf("paid %d after a failed charge: %+v", c.paid, failed)
		}
	}
	// a flat batch_window_hours overrides every tier's window
	flat := defaults()
	flat.BatchWindowHours = 0.25
	if w := flat.BatchTierFor(600000, false).Window(); w != 15*time.Minute {
		t.Errorf("flat override: %v", w)
	}
	// config tiers written before window_hours keep the default windows
	old := &Rates{BatchTiers: []BatchTier{{MinPaidCents: 0, CapCents: 5000}, {MinPaidCents: 100000, CapCents: 40000}}}
	if w := old.BatchTierFor(150000, false).Window(); w != 12*time.Hour {
		t.Errorf("tier without window_hours: %v", w)
	}
	if (&Rates{}).FailureLookback() != 90*24*time.Hour {
		t.Error("failure lookback defaults to 90 days")
	}
}

func TestQuoteVideoOneMinuteFloor(t *testing.T) {
	r := defaults()
	s := &Service{cached: r, fetchedAt: time.Now()}
	short, err := s.QuoteVideo(context.Background(), VideoInputs{Preset: "1080p", BillableS: 3, FPS: 24, Width: 1920, Height: 1080, Inpaint: "migan"})
	if err != nil {
		t.Fatal(err)
	}
	minute, _ := s.QuoteVideo(context.Background(), VideoInputs{Preset: "1080p", BillableS: 60, FPS: 24, Width: 1920, Height: 1080, Inpaint: "migan"})
	if short.AmountCents != minute.AmountCents {
		t.Errorf("3s clip %d¢ should price like a 60s clip %d¢", short.AmountCents, minute.AmountCents)
	}
	if short.AmountCents != 225 {
		t.Errorf("1080p migan minute = %d¢, want 225", short.AmountCents)
	}
	if short.Breakdown["billed_seconds"] != 60.0 || short.Breakdown["billable_seconds"] != 3.0 {
		t.Errorf("breakdown %v", short.Breakdown)
	}
	two, _ := s.QuoteVideo(context.Background(), VideoInputs{Preset: "1080p", BillableS: 120, FPS: 24, Width: 1920, Height: 1080, Inpaint: "migan"})
	if two.AmountCents != 450 {
		t.Errorf("2 min above the floor = %d¢, want 450", two.AmountCents)
	}
}
