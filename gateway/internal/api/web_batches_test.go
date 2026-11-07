package api

import (
	"context"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// offBatch puts finished runs (web when project != "") in a closed group
// ready to charge.
func offBatch(t *testing.T, s *Service, uid, project string, cents ...int64) *store.Batch {
	t.Helper()
	ctx := context.Background()
	var b *store.Batch
	for _, c := range cents {
		conv := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateSucceeded, Kind: "video", ProjectID: project,
			Quote: store.Quote{AmountCents: c, Currency: "usd"}}
		conv.Stripe.Mode, conv.Stripe.PIStatus = store.BillingModeAuto, store.PIChargePending
		if err := s.Store.CreateConversion(ctx, conv); err != nil {
			t.Fatal(err)
		}
		var err error
		if b, err = s.Store.BatchConversion(ctx, conv.ID, store.BatchItem{ConversionID: conv.ID, ProjectID: project, Kind: "video",
			AmountCents: c}, time.Hour, 100000); err != nil {
			t.Fatal(err)
		}
	}
	b, err := s.Store.CloseBatch(ctx, b.ID, "window")
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// B1: a web group whose default is a Link (allowed only under pmc_web)
// is charged under pmc_web and pays.
func TestWebBatchLinkUnderPMC(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_link", "needs_pmc"})
	b := offBatch(t, s, uid, "proj_1", 1000, 500)
	got, err := s.chargeBatch(ctx, b)
	if err != nil || got.State != store.BatchPaid || len(f.creates) != 1 || f.creates[0]["payment_method_configuration"] != "pmc_test" {
		t.Fatalf("%v %+v creates %v", err, got, f.creates)
	}
}

// D1: an app group (no web project) keeps its shipped request: no pmc_web,
// so the same Link default is refused and no backup is tried (unchanged).
func TestAppBatchUnchanged(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_link", "needs_pmc"}, [2]string{"pm_card", ""})
	b := offBatch(t, s, uid, "", 1000)
	got, _ := s.chargeBatch(ctx, b)
	if got.State != store.BatchFailed || !got.SoftDecline || len(f.creates) != 1 || f.creates[0]["payment_method_configuration"] != "" ||
		len(f.confirms) != 0 || f.creates[0]["key"] != "batch_test_"+b.ID {
		t.Fatalf("%+v creates %v confirms %v", got, f.creates, f.confirms)
	}
}

// B3/B2 on a web group: a refused default still tries the backup (its
// own key); refused everywhere, the group fails without a soft retry or
// the "didn't go through" mail.
func TestWebBatchRefusedDefault(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_bad", "config"}, [2]string{"pm_card", ""})
	b := offBatch(t, s, uid, "proj_1", 1200)
	got, err := s.chargeBatch(ctx, b)
	if err != nil || got.State != store.BatchPaid || len(f.creates) != 2 || f.creates[1]["key"] != "batch_test_"+b.ID+"_pm_card" {
		t.Fatalf("%v %+v creates %v", err, got, f.creates)
	}
	uid2, _ := offCustomer(t, s, f, [2]string{"pm_bad2", "config"})
	b2 := offBatch(t, s, uid2, "proj_2", 1200)
	got2, _ := s.chargeBatch(ctx, b2)
	if got2.State != store.BatchFailed || got2.SoftDecline {
		t.Fatalf("%+v", got2)
	}
	if mailed(s, "E2_"+b2.ID) {
		t.Fatal("E2 for a configuration error")
	}
}

// B6: the charge went through but its answer was lost; the default
// changed before the re-drive. The re-drive replays the recorded method:
// one charge, the group paid.
func TestWebBatchRedriveAfterDefaultChanged(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_old", ""}, [2]string{"pm_new", ""})
	b := offBatch(t, s, uid, "proj_1", 1500)
	f.keptAnswers = 1
	got, _ := s.chargeBatch(ctx, b)
	if got.State != store.BatchCharging || got.ChargePM != "pm_old" {
		t.Fatalf("after the lost answer %+v", got)
	}
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error { c.DefaultPaymentMethod = "pm_new"; return nil })
	got, err := s.chargeBatch(ctx, got)
	if err != nil || got.State != store.BatchPaid || f.succeeded() != 1 {
		t.Fatalf("%v %+v succeeded %d", err, got, f.succeeded())
	}
}

// B6, a group recorded before this fix (no charge method): the re-drive's
// request differs, Stripe answers idempotency_error, and the PaymentIntent
// the key made is found and adopted — not stuck charging, not charged
// again.
func TestWebBatchLegacyRedriveAdoptsCharge(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, cus := offCustomer(t, s, f, [2]string{"pm_old", ""}, [2]string{"pm_new", ""})
	b := offBatch(t, s, uid, "proj_1", 1500)
	// the old code's charge: the default at the time, no method recorded
	f.keptAnswers = 1
	if _, err := s.Stripe.ChargeSaved(cus, "pm_old", 1500, "usd", stripexJob(b)); err == nil {
		t.Fatal("expected the lost answer")
	}
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error { c.DefaultPaymentMethod = "pm_new"; return nil })
	got, err := s.chargeBatch(ctx, b)
	if err != nil || got.State != store.BatchPaid || got.PaymentIntentID != "pi_off_1" || f.succeeded() != 1 {
		t.Fatalf("%v %+v succeeded %d", err, got, f.succeeded())
	}
}

// 3DS's case (a): a web group the old code failed on a Link default
// (invalid_request read as a soft decline: failed, soft_decline, not yet
// retried, the debt owed). The 24 h retry runs under the web's rules and
// collects it once; another sweep charges nothing.
func TestOldFailedLinkBatchCollectedOnce(t *testing.T) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_link", "needs_pmc"})
	b := offBatch(t, s, uid, "proj_1", 1000)
	failedAt := time.Now().Add(-25 * time.Hour)
	if _, err := s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchCharging}, func(bb *store.Batch) error {
		bb.State, bb.FailedAt, bb.SoftDecline, bb.SettleError = store.BatchFailed, &failedAt, true, "charge: The PaymentMethod provided (link) is not allowed"
		return nil
	}, func(c *store.Conversion) error {
		c.Stripe.PIStatus = store.PIChargeFailed
		return nil
	}, nil); err != nil {
		t.Fatal(err)
	}
	if s.owedCents(ctx, uid) != 1000 {
		t.Fatal("not owed")
	}
	s.settleSweep(ctx)
	s.settleSweep(ctx)
	got, _ := s.Store.GetBatch(ctx, b.ID)
	if got.State != store.BatchPaid || f.succeeded() != 1 || s.owedCents(ctx, uid) != 0 || f.creates[0]["payment_method_configuration"] != "pmc_test" {
		t.Fatalf("%+v succeeded %d creates %v", got, f.succeeded(), f.creates)
	}
}

func stripexJob(b *store.Batch) stripex.Job {
	return stripex.Job{Web: true, BatchID: b.ID, UID: b.UID, PMC: "pmc_test", Description: batchDescription(b), Metadata: batchMetadata(b)}
}
