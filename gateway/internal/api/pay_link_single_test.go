package api

import (
	"context"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// REV-07 setup: a soft-declined reload (retry pending) whose E15 pay link
// was opened in the sheet (session cs_off_1 on top-up A).
func failedReloadWithPage(t *testing.T) (*Service, *offFake, string, string, string) {
	s, f := offService(t)
	ctx := context.Background()
	uid, _ := offCustomer(t, s, f, [2]string{"pm_1", "decline:generic_decline"})
	id := offReload(t, s, uid, 2000)
	s.runReload(ctx, id)
	tp, _ := s.Store.GetTopup(ctx, id)
	tok := tp.Retry.PayRequestID
	if code, out := payCall(t, s.HandlePayRequestCheckout, "POST", tok, `{"ui":"elements"}`); code != 200 || out["checkout"] == nil {
		t.Fatalf("checkout %d %v", code, out)
	}
	return s, f, uid, id, tok
}

func linkSession(t *testing.T, s *Service, tok string) (string, string) {
	pr, _ := s.Store.GetPayRequest(context.Background(), tok)
	return pr.TopupID, pr.CheckoutID
}

// Switching the page's ui expires the earlier session instead of leaving
// it payable; one paid meanwhile is the payment (credited once).
func TestPayLinkOneSessionAtATime(t *testing.T) {
	s, f, uid, _, tok := failedReloadWithPage(t)
	ctx := context.Background()
	topA, csA := linkSession(t, s, tok)
	if code, out := payCall(t, s.HandlePayRequestCheckout, "POST", tok, `{"ui":"hosted_page"}`); code != 200 || out["checkout"] == nil {
		t.Fatalf("hosted %d %v", code, out)
	}
	_, csB := linkSession(t, s, tok)
	if csB == csA || !contains(f.expired, csA) {
		t.Fatalf("the elements session %s stayed open (expired %v)", csA, f.expired)
	}
	if a, _ := s.Store.GetTopup(ctx, topA); a.State != store.TopupCanceled {
		t.Fatalf("top-up A %s", a.State)
	}
	// B paid in another tab; the page switches back: no new session, paid
	f.paySession(csB, 2000)
	code, out := payCall(t, s.HandlePayRequestCheckout, "POST", tok, `{"ui":"elements"}`)
	if code != 200 || out["state"] != "paid" {
		t.Fatalf("after B was paid %d %v", code, out)
	}
	if b, _ := s.Store.GetBalance(ctx, uid); b.BalanceCents != 2000 || len(f.refunds) != 0 {
		t.Fatalf("balance %d refunds %v", b.BalanceCents, f.refunds)
	}
}

// The reload's retry pays while the page's session is open (its wait
// over): the link closes and expires that session; the customer finishing
// it anyway (paid before the expiry landed) is refunded, not credited.
func TestPayLinkClosedByRetryExpiresAndRefunds(t *testing.T) {
	s, f, uid, id, tok := failedReloadWithPage(t)
	ctx := context.Background()
	topA, csA := linkSession(t, s, tok)
	// the session expires on Stripe's side for the test of the wait: the
	// retry waits while it is open
	f.outcome["pm_1"] = ""
	dueNow(t, s, id)
	s.reloadRetrySweep(ctx, time.Now())
	if tp, _ := s.Store.GetTopup(ctx, id); tp.State == store.TopupPaid || tp.Retry.State != store.RetryPending || !tp.Retry.NextAttemptAt.After(time.Now().Add(30*time.Minute)) {
		t.Fatalf("the retry charged while the customer was on the page: %+v %+v", tp.State, tp.Retry)
	}
	// the page's session runs out (as far as our record knows); the retry pays
	s.Store.UpdateTopup(ctx, topA, func(x *store.Topup) error {
		past := time.Now().Add(-time.Second)
		x.CurrentPayment.ExpiresAt = &past
		return nil
	})
	dueNow(t, s, id)
	s.reloadRetrySweep(ctx, time.Now())
	if tp, _ := s.Store.GetTopup(ctx, id); tp.State != store.TopupPaid {
		t.Fatalf("retry %+v", tp.Retry)
	}
	if pr, _ := s.Store.GetPayRequest(ctx, tok); pr.State != store.PayVoid || pr.DebtTopupID != id {
		t.Fatalf("link %+v", pr)
	}
	if !contains(f.expired, csA) {
		t.Fatalf("the page's session left open: expired %v", f.expired)
	}
	// the customer had paid it after all: refunded, not credited twice
	pi := f.paySession(csA, 2000)
	if err := s.applyTopupPayment(ctx, topA, stripexPaid(pi, 2000)); err != nil {
		t.Fatal(err)
	}
	if b, _ := s.Store.GetBalance(ctx, uid); b.BalanceCents != 2000 || !contains(f.refunds, pi) {
		t.Fatalf("balance %d refunds %v", b.BalanceCents, f.refunds)
	}
}

// While the retry holds the link's debt the page opens nothing (409
// payment_in_progress); once the page's payment holds it, the retry
// stands down.
func TestPayLinkAndRetryNeverBothCharge(t *testing.T) {
	s, f, uid, id, tok := failedReloadWithPage(t)
	ctx := context.Background()
	topA, csA := linkSession(t, s, tok)
	pi := f.paySession(csA, 2000)
	if err := s.applyTopupPayment(ctx, topA, stripexPaid(pi, 2000)); err != nil {
		t.Fatal(err)
	}
	f.outcome["pm_1"] = ""
	creates := len(f.creates)
	dueNow(t, s, id)
	s.reloadRetrySweep(ctx, time.Now())
	tp, _ := s.Store.GetTopup(ctx, id)
	if len(f.creates) != creates || tp.State == store.TopupPaid || tp.Retry.State != store.RetryCanceled {
		t.Fatalf("the retry charged after the page paid: %d creates, %+v", len(f.creates)-creates, tp.Retry)
	}
	if b, _ := s.Store.GetBalance(ctx, uid); b.BalanceCents != 2000 {
		t.Fatalf("balance %d", b.BalanceCents)
	}
	// the other way round: a retry holding the debt answers the page 409
	s2, _, _, _, tok2 := failedReloadWithPage(t)
	topB, _ := linkSession(t, s2, tok2)
	if ok, err := s2.claimTopupDebt(ctx, tok2, "t_retry"); !ok || err != nil {
		t.Fatalf("claim %v %v", ok, err)
	}
	if code, out := payCall(t, s2.HandlePayRequestCheckout, "POST", tok2, `{"ui":"hosted_page"}`); code != 409 || out["error"] != "payment_in_progress" {
		t.Fatalf("page during the retry %d %v", code, out)
	}
	if ok, _ := s2.claimTopupDebt(ctx, tok2, topB); ok {
		t.Fatal("two top-ups hold one debt")
	}
}
