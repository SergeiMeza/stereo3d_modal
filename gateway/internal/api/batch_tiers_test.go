package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// tierCustomer is a made-up account with lifetime collected spend paid.
func tierCustomer(t *testing.T, s *Service, f *offFake, paid int64) string {
	t.Helper()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_" + store.NewID(), ""})
	if _, err := s.Store.UpdateCustomer(context.Background(), uid, func(c *store.Customer) error {
		c.LifetimePaidCents, c.LifetimePaidSeeded = paid, true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return uid
}

// batchedStill batches a finished 5¢ still (below the charge minimum, so
// its group stays open) of a web project or of the app (project "").
func batchedStill(t *testing.T, s *Service, uid, project string) *store.Batch {
	t.Helper()
	ctx := context.Background()
	c := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateSucceeded, Kind: "image", ProjectID: project,
		Quote: store.Quote{AmountCents: 5, Currency: "usd"}}
	c.Stripe.Mode, c.Stripe.PIStatus = store.BillingModeAuto, store.PIChargePending
	if err := s.Store.CreateConversion(ctx, c); err != nil {
		t.Fatal(err)
	}
	if _, err := s.batchConversion(ctx, c); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Store.GetConversion(ctx, c.ID)
	b, err := s.Store.GetBatch(ctx, got.Stripe.BatchID)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func windowOf(b *store.Batch) time.Duration { return b.DueAt.Sub(b.OpenedAt).Round(time.Minute) }

// D15: a web group opens under the web ladder; an app group (no project:
// anything not clearly web) under the shipped one.
func TestBatchTiersWebVsApp(t *testing.T) {
	s, f := offService(t)
	for _, c := range []struct {
		paid              int64
		webCap, appCap    int64
		webWin, appWindow time.Duration
	}{
		{0, 2500, 5000, time.Hour, time.Hour},
		{6000, 5000, 5000, 2 * time.Hour, time.Hour},
		{25000, 15000, 15000, 6 * time.Hour, 4 * time.Hour},
		{150000, 40000, 40000, 12 * time.Hour, 12 * time.Hour},
	} {
		web := batchedStill(t, s, tierCustomer(t, s, f, c.paid), "proj_1")
		app := batchedStill(t, s, tierCustomer(t, s, f, c.paid), "")
		if web.CapCents != c.webCap || windowOf(web) != c.webWin {
			t.Errorf("web, paid %d: cap %d window %v", c.paid, web.CapCents, windowOf(web))
		}
		if app.CapCents != c.appCap || windowOf(app) != c.appWindow {
			t.Errorf("app, paid %d: cap %d window %v", c.paid, app.CapCents, windowOf(app))
		}
	}
}

// App regression: Billing's tier and the mobile limits' tier are the
// shipped ladder; the web's is in web_tier only. Hold thresholds agree.
func TestTierEntryAppUnchanged(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid := tierCustomer(t, s, f, 6000)
	cust, _ := s.Store.GetCustomer(ctx, uid)
	app := s.tierEntry(ctx, cust, false)
	next, _ := app["next_tier"].(map[string]any)
	if app["cap_cents"] != int64(5000) || app["window_hours"] != 1.0 || app["hold_threshold_cents"] != int64(10000) ||
		next["min_paid_cents"] != int64(20000) || next["cap_cents"] != int64(15000) {
		t.Fatalf("app tier %v", app)
	}
	status, err := s.billingStatus(ctx, &AuthedUser{UID: uid}, cust)
	if err != nil {
		t.Fatal(err)
	}
	tier, _ := status["tier"].(map[string]any)
	web, _ := status["web_tier"].(map[string]any)
	webNext, _ := web["next_tier"].(map[string]any)
	if tier["cap_cents"] != int64(5000) || tier["window_hours"] != 1.0 || web["cap_cents"] != int64(5000) || web["window_hours"] != 2.0 ||
		webNext["min_paid_cents"] != int64(20000) {
		t.Fatalf("billing tier %v web_tier %v", tier, web)
	}
	for _, paid := range []int64{0, 6000, 25000, 150000, 600000} {
		c := &store.Customer{LifetimePaidCents: paid}
		if s.holdThreshold(ctx, c, true) != s.holdThreshold(ctx, c, false) {
			t.Errorf("hold threshold differs at %d", paid)
		}
	}
}

// Rollover (a group too small to charge) extends by its own ladder's
// window: an app group by the shipped one.
func TestBatchRolloverWindowByKind(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	s.Cfg.ReconcileToken = "tok"
	web := batchedStill(t, s, tierCustomer(t, s, f, 6000), "proj_1")
	app := batchedStill(t, s, tierCustomer(t, s, f, 6000), "")
	past := time.Now().UTC().Add(-time.Minute)
	for _, id := range []string{web.ID, app.ID} {
		if _, err := s.Store.TransitionBatch(ctx, id, []string{store.BatchOpen}, func(bb *store.Batch) error { bb.DueAt = past; return nil }, nil, nil); err != nil {
			t.Fatal(err)
		}
	}
	r := httptest.NewRequest(http.MethodPost, "/internal/reconcile", nil)
	r.Header.Set("X-Reconcile-Token", "tok")
	s.HandleReconcile(httptest.NewRecorder(), r)
	gw, _ := s.Store.GetBatch(ctx, web.ID)
	ga, _ := s.Store.GetBatch(ctx, app.ID)
	now := time.Now()
	if d := gw.DueAt.Sub(now).Round(time.Minute); gw.State != store.BatchOpen || d != 2*time.Hour {
		t.Errorf("web rollover %s %v", gw.State, d)
	}
	if d := ga.DueAt.Sub(now).Round(time.Minute); ga.State != store.BatchOpen || d != time.Hour {
		t.Errorf("app rollover %s %v", ga.State, d)
	}
}

// batch_window_hours (TEST's 0.25) still sets every window, web and app.
func TestBatchWindowHoursOverridesBoth(t *testing.T) {
	s, f := offService(t)
	r := *s.Pricing.Rates(context.Background())
	r.BatchWindowHours = 0.25
	s.Pricing = pricing.NewStatic(&r)
	web := batchedStill(t, s, tierCustomer(t, s, f, 150000), "proj_1")
	app := batchedStill(t, s, tierCustomer(t, s, f, 150000), "")
	if windowOf(web) != 15*time.Minute || windowOf(app) != 15*time.Minute || web.CapCents != 40000 || app.CapCents != 40000 {
		t.Fatalf("web %v/%d app %v/%d", windowOf(web), web.CapCents, windowOf(app), app.CapCents)
	}
}
