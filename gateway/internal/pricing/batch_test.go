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

// D15: web groups' default ladder.
func TestWebBatchTierDefaults(t *testing.T) {
	r := defaults()
	for _, c := range []struct {
		paid   int64
		cap    int64
		window time.Duration
	}{
		{0, 2500, time.Hour}, {4999, 2500, time.Hour}, {5000, 5000, 2 * time.Hour}, {19999, 5000, 2 * time.Hour},
		{20000, 15000, 6 * time.Hour}, {100000, 40000, 12 * time.Hour}, {500000, 100000, 24 * time.Hour}, {10_000_000, 100000, 24 * time.Hour},
	} {
		tier := r.WebBatchTierFor(c.paid, false)
		if tier.CapCents != c.cap || tier.Window() != c.window || r.TierFor(true, c.paid, false) != tier {
			t.Errorf("web paid %d: %+v", c.paid, tier)
		}
		if failed := r.WebBatchTierFor(c.paid, true); failed.CapCents != 2500 || failed.Window() != time.Hour {
			t.Errorf("web paid %d after a failed charge: %+v", c.paid, failed)
		}
	}
	if n := r.NextWebBatchTier(0); n == nil || n.MinPaidCents != 5000 || n.CapCents != 5000 {
		t.Errorf("next web tier from 0: %+v", n)
	}
	if n := r.NextWebBatchTier(500000); n != nil {
		t.Errorf("top web tier has no next: %+v", n)
	}
	if r.WebBatchCap(20000) != 15000 {
		t.Error("web cap at $200")
	}
	if p := DefaultsFor("prod"); len(p.WebBatchTiers) != 5 || p.WebBatchTiers[0].CapCents != 2500 {
		t.Errorf("prod default web tiers %+v", p.WebBatchTiers)
	}
}

// D15: the app's ladder is the shipped one, whatever the web's is
// (TierFor(false) == BatchTierFor, the old values).
func TestAppBatchTiersUnchangedByWebTiers(t *testing.T) {
	r := defaults()
	for _, c := range []struct {
		paid   int64
		cap    int64
		window time.Duration
	}{
		{0, 5000, time.Hour}, {5000, 5000, time.Hour}, {20000, 15000, 4 * time.Hour}, {100000, 40000, 12 * time.Hour}, {500000, 100000, 24 * time.Hour},
	} {
		if tier := r.TierFor(false, c.paid, false); tier.CapCents != c.cap || tier.Window() != c.window || tier != r.BatchTierFor(c.paid, false) {
			t.Errorf("app paid %d: %+v", c.paid, tier)
		}
	}
	if n := r.NextBatchTier(0); n == nil || n.MinPaidCents != 20000 {
		t.Errorf("app next tier from 0: %+v", n)
	}
}

// Overrides: web_batch_tiers changes only web groups; batch_tiers only
// app groups (as shipped); batch_window_hours every window of both.
func TestBatchTierOverrides(t *testing.T) {
	r := defaults()
	r.WebBatchTiers = []BatchTier{{MinPaidCents: 0, CapCents: 1000, WindowHours: 0.5}}
	if w := r.WebBatchTierFor(600000, false); w.CapCents != 1000 || w.Window() != 30*time.Minute {
		t.Errorf("web_batch_tiers override: %+v", w)
	}
	if a := r.BatchTierFor(600000, false); a.CapCents != 100000 || a.Window() != 24*time.Hour {
		t.Errorf("web_batch_tiers changed the app tier: %+v", a)
	}
	r = defaults()
	r.BatchTiers = []BatchTier{{MinPaidCents: 0, CapCents: 7000, WindowHours: 3}}
	if a := r.BatchTierFor(0, false); a.CapCents != 7000 || a.Window() != 3*time.Hour {
		t.Errorf("batch_tiers override (app): %+v", a)
	}
	if w := r.WebBatchTierFor(0, false); w.CapCents != 2500 || w.Window() != time.Hour {
		t.Errorf("batch_tiers changed the web tier: %+v", w)
	}
	r = defaults()
	r.BatchWindowHours = 0.25
	for _, paid := range []int64{0, 5000, 20000, 100000, 500000} {
		for _, web := range []bool{false, true} {
			for _, failed := range []bool{false, true} {
				if w := r.TierFor(web, paid, failed).Window(); w != 15*time.Minute {
					t.Errorf("batch_window_hours: web=%v paid %d failed=%v window %v", web, paid, failed, w)
				}
			}
		}
	}
	// An empty or broken web_batch_tiers doc still yields the web base.
	if w := (&Rates{}).WebBatchTierFor(1_000_000, false); w.CapCents != 2500 || w.Window() != time.Hour {
		t.Errorf("empty web tiers: %+v", w)
	}
}

// A config doc without web_batch_tiers keeps the code's web default (the
// doc is read over the defaults).
func TestWebBatchTiersAbsentFromConfigKeepDefault(t *testing.T) {
	loaded := *DefaultsFor("test")
	loaded.BatchWindowHours = 0.25 // what TEST's doc sets today
	if w := loaded.WebBatchTierFor(20000, false); w.CapCents != 15000 {
		t.Errorf("%+v", w)
	}
}
