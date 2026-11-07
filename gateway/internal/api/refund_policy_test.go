package api

import (
	"context"
	"net/http"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Refund policy (owner 2026-11-08): "users can ask for refunds and we
// reserve the right to give one on a case by case basis". A deletion
// forfeits the unspent cash balance (forfeit_on_deletion) instead of
// opening a closure case; old closure cases are still decided.

func forfeitEntries(t *testing.T, s *Service, uid string) []store.Entry {
	t.Helper()
	entries, err := s.Store.ListEntriesBetween(context.Background(), uid, time.Now().Add(-time.Hour), time.Now().Add(time.Hour))
	if err != nil {
		t.Fatal(err)
	}
	var out []store.Entry
	for _, e := range entries {
		if e.Kind == store.EntryForfeitOnDeletion {
			out = append(out, e)
		}
	}
	return out
}

// legacyClosureCase is a closure case as the gateway opened it before the
// policy, with the account waiting for it (DeletionPending).
func legacyClosureCase(t *testing.T, s *Service, uid string, keepSignIn bool) *store.Case {
	t.Helper()
	ctx := context.Background()
	b, _ := s.Store.GetBalance(ctx, uid)
	cs, err := s.openCase(ctx, &store.Case{UID: uid, Type: store.CaseBalanceRefund, Reason: ReasonClosure, Source: "system",
		Status: store.CaseOpen, CustomerVisible: true, CustomerText: "account deletion", RequestedCents: b.CashCents(), Mode: "manual"},
		"customer", "account deletion")
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	if _, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		c.DeletionPending, c.DeletionCaseID, c.DeletionRequestedAt, c.DeletionKeepSignIn = true, cs.ID, &now, keepSignIn
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return cs
}

// A deletion with a cash balance completes: forfeit_on_deletion with the
// amount and its FIFO top-ups (oldest first), no case, no 409, and the
// revenue report's by_method.forfeited_cents carries it.
func TestDeletionForfeitsCashBalance(t *testing.T) {
	f := deletionFixture(t)
	ctx := context.Background()
	t1 := paidTopup(t, f.s, f.uid, 1500)
	t2 := paidTopup(t, f.s, f.uid, 1000)
	// an admin credit (non-cash) is not forfeited as cash
	f.s.Store.BalanceTx(ctx, f.uid, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryAdjustment, Cents: 300, Note: "goodwill"}}, nil
	})
	code, out := deleteAccount(f, `{}`, false)
	if code != http.StatusAccepted || out["pending_deletion"] != true || out["error"] != nil {
		t.Fatalf("request %d %v", code, out)
	}
	if b, _ := f.s.Store.GetBalance(ctx, f.uid); b.CashCents() != 2500 || len(forfeitEntries(t, f.s, f.uid)) != 0 {
		t.Fatal("forfeited at the request: a cancel must keep the balance")
	}
	due(t, f)
	if n := f.s.deletionScheduleSweep(ctx); n["deletions_deleted"] != 1 {
		t.Fatalf("sweep %v", n)
	}
	if c, _ := f.s.Store.GetCustomer(ctx, f.uid); !c.AccountDeleted || c.DeletionPending {
		t.Fatalf("customer %+v", c)
	}
	es := forfeitEntries(t, f.s, f.uid)
	if len(es) != 1 || es[0].Cents != 2500 || len(es[0].FifoUsed) != 2 ||
		es[0].FifoUsed[0] != (store.FifoUse{TopupID: t1.ID, Cents: 1500}) || es[0].FifoUsed[1] != (store.FifoUse{TopupID: t2.ID, Cents: 1000}) {
		t.Fatalf("forfeit entries %+v", es)
	}
	if b, _ := f.s.Store.GetBalance(ctx, f.uid); b.CashCents() != 0 {
		t.Fatalf("cash left %d", b.CashCents())
	}
	if cases, _ := f.s.Store.ListUserCases(ctx, f.uid, 10); len(cases) != 0 {
		t.Fatalf("a case was opened: %+v", cases)
	}
	if d, _ := f.s.Store.GetAccountDeletion(ctx, f.uid); d.Outcome != store.DeletionOutcomeDeleted {
		t.Fatalf("outcome %q", d.Outcome)
	}
	// a second pass (a retry) forfeits nothing more
	if err := f.s.forfeitOnDeletion(ctx, f.uid); err != nil || len(forfeitEntries(t, f.s, f.uid)) != 1 {
		t.Fatalf("again: %v", err)
	}
	today := time.Now().UTC().Truncate(24 * time.Hour)
	days, err := f.s.buildRevenue(ctx, today, today.AddDate(0, 0, 1), time.Now())
	if err != nil || len(days) != 1 || days[0].ByMethod["forfeited_cents"] != 2500 ||
		days[0].ByMethod["balance_cents"] != 0 || days[0].Refunds != 0 {
		t.Fatalf("revenue %v %+v", err, days[0].ByMethod)
	}
}

// POST never answers 409 balance_remaining; balance_confirmed and
// balanceConfirmed (any type) are accepted and ignored.
func TestDeletionIgnoresBalanceConfirmed(t *testing.T) {
	for _, body := range []string{`{}`, `{"balance_confirmed":true}`, `{"balance_confirmed":false}`,
		`{"balanceConfirmed":true}`, `{"balanceConfirmed":"yes"}`} {
		t.Run(body, func(t *testing.T) {
			f := deletionFixture(t)
			paidTopup(t, f.s, f.uid, 2000)
			code, out := deleteAccount(f, body, false)
			if code != http.StatusAccepted || out["state"] != "pending_deletion" || out["pending_deletion"] != true {
				t.Fatalf("scheduled %d %v", code, out)
			}
			f2 := deletionFixture(t)
			paidTopup(t, f2.s, f2.uid, 2000)
			if code, out := deleteAccountNow(f2, body); code != http.StatusOK || out["deleted"] != true {
				t.Fatalf("now %d %v", code, out)
			}
			if es := forfeitEntries(t, f2.s, f2.uid); len(es) != 1 || es[0].Cents != 2000 {
				t.Fatalf("forfeit %+v", es)
			}
		})
	}
}

// GET /v1/account/delete keeps every field it had; cash_balance_cents is
// unchanged, balance_confirmation_needed is always false, and
// balance_lost_cents (additive) is what the deletion forfeits.
func TestDeletePreviewShape(t *testing.T) {
	f := deletionFixture(t)
	paidTopup(t, f.s, f.uid, 2000)
	code, out := callAs(f, f.s.HandleDeletePreview, http.MethodGet, ``, false)
	if code != 200 {
		t.Fatalf("%d %v", code, out)
	}
	for _, k := range []string{"can_delete", "block", "plan_state", "active_runs", "dues_cents", "balance_cents",
		"cash_balance_cents", "plan_credit_cents", "balance_confirmation_needed", "waits_for_refund_case",
		"deletion_pending", "pending_deletion", "delete_after", "delete_delay_hours", "balance_lost_cents"} {
		if _, ok := out[k]; !ok {
			t.Errorf("missing %q", k)
		}
	}
	if out["cash_balance_cents"] != float64(2000) || out["balance_cents"] != float64(2000) || out["balance_lost_cents"] != float64(2000) ||
		out["balance_confirmation_needed"] != false || out["waits_for_refund_case"] != false || out["can_delete"] != true || out["block"] != nil {
		t.Fatalf("preview %v", out)
	}
}

// A 202 from POST always says pending_deletion, the legacy wait for a
// closure case included.
func TestDeletionLegacyPendingAnswer(t *testing.T) {
	f := deletionFixture(t)
	paidTopup(t, f.s, f.uid, 2000)
	cs := legacyClosureCase(t, f.s, f.uid, false)
	for _, call := range []func() (int, map[string]any){
		func() (int, map[string]any) { return deleteAccount(f, `{}`, false) },
		func() (int, map[string]any) { return deleteAccountNow(f, `{}`) },
	} {
		code, out := call()
		if code != http.StatusAccepted || out["pending_deletion"] != true || out["state"] != "pending_deletion" ||
			out["deletion_pending"] != true || out["case_id"] != cs.ID || out["deleted"] != false {
			t.Fatalf("legacy %d %v", code, out)
		}
	}
	if _, out := callAs(f, f.s.HandleDeletePreview, http.MethodGet, ``, false); out["waits_for_refund_case"] != true ||
		out["balance_confirmation_needed"] != false {
		t.Fatalf("preview %v", out)
	}
}

// No closure case is opened any more (the deletion, support's open case);
// a customer's withdrawal request still is.
func TestNoClosureCaseCreation(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	tp := paidTopup(t, s, uid, 2000)
	if cs, err := s.requestBalanceRefund(ctx, uid, ReasonClosure, "", "support", "owner@x", "close"); err == nil || cs != nil {
		t.Fatalf("closure case opened: %+v", cs)
	}
	if cs, err := s.requestBalanceRefund(ctx, uid, ReasonTopupWithdraw, tp.ID, SourceCustomer, SourceCustomer, "please"); err != nil ||
		cs.Reason != ReasonTopupWithdraw || cs.RequestedCents != 2000 {
		t.Fatalf("withdrawal: %v %+v", err, cs)
	}
}

// Legacy closure cases stay actionable: the maximum is the unspent cash
// (at most what is available), approve pays it and the waiting deletion
// finishes (svs-backend's callback via refund_case); deny finishes it too,
// the cash forfeited.
func TestLegacyClosureCaseDecisions(t *testing.T) {
	t.Run("approve", func(t *testing.T) {
		f, stub := handoffFixture(t)
		ctx := context.Background()
		paidTopup(t, f.s, f.uid, 2000)
		cs := legacyClosureCase(t, f.s, f.uid, true)
		if _, max := f.s.perRun(ctx, cs); max != 2000 {
			t.Fatalf("max %d", max)
		}
		if err := f.s.applyCaseAction(ctx, cs, caseActionReq{Action: "approve"}, "owner@x"); err != nil {
			t.Fatal(err)
		}
		f.s.finishPendingDeletions(ctx)
		done, _ := f.s.Store.GetCase(ctx, cs.ID)
		if done.Status != store.CaseClosed || done.DecidedCents != 2000 || len(f.fake.refunds) != 1 {
			t.Fatalf("case %+v refunds %v", done, f.fake.refunds)
		}
		if after, _ := f.s.Store.GetCustomer(ctx, f.uid); !after.AccountDeleted || after.DeletionPending {
			t.Fatalf("after the decision %+v", after)
		}
		if len(forfeitEntries(t, f.s, f.uid)) != 0 {
			t.Fatal("forfeited what the case refunded")
		}
		if len(stub.bodies) != 1 || stub.bodies[0]["via"] != "refund_case" {
			t.Fatalf("calls %v", stub.bodies)
		}
	})
	t.Run("deny", func(t *testing.T) {
		f := deletionFixture(t)
		ctx := context.Background()
		paidTopup(t, f.s, f.uid, 1200)
		cs := legacyClosureCase(t, f.s, f.uid, false)
		if err := f.s.applyCaseAction(ctx, cs, caseActionReq{Action: "deny", Text: "policy"}, "owner@x"); err != nil {
			t.Fatal(err)
		}
		f.s.finishPendingDeletions(ctx)
		if after, _ := f.s.Store.GetCustomer(ctx, f.uid); !after.AccountDeleted {
			t.Fatalf("not deleted %+v", after)
		}
		if es := forfeitEntries(t, f.s, f.uid); len(es) != 1 || es[0].Cents != 1200 || len(f.fake.refunds) != 0 {
			t.Fatalf("forfeit %+v refunds %v", es, f.fake.refunds)
		}
	})
}

// The cash maximum is scoped: a legacy closure case gets min(cash,
// available) (a hold keeps its part); a balance_refund case of another
// reason without a top-up or runs gets nothing from the balance.
func TestLegacyClosureMaxScoped(t *testing.T) {
	f := deletionFixture(t)
	ctx := context.Background()
	paidTopup(t, f.s, f.uid, 2500)
	held := &store.Conversion{ID: store.NewID(), UID: f.uid, State: store.StatePaid, Kind: "video", PaymentFlow: store.FlowBalance,
		Quote: store.Quote{AmountCents: 1000, Currency: "usd"}, RunBalance: &store.RunBalance{HoldCents: 1000, State: store.HoldHeld}}
	held.Stripe.Mode = store.BillingModeBalance
	if _, err := f.s.Store.CreateConversionWithHold(ctx, held, 0); err != nil {
		t.Fatal(err)
	}
	cs := legacyClosureCase(t, f.s, f.uid, false)
	if _, max := f.s.perRun(ctx, cs); max != 1500 {
		t.Fatalf("closure max %d", max)
	}
	other := &store.Case{UID: f.uid, Type: store.CaseBalanceRefund, Reason: ReasonSupport}
	if _, max := f.s.perRun(ctx, other); max != 0 {
		t.Fatalf("other reason max %d", max)
	}
}

// Unchanged by the policy: undelivered runs (failed, cancelled, ours,
// late, a deletion's) are refunded automatically at any amount, a
// customer's top-up withdrawal is still a request, and refund-options'
// windows stay 30 days (runs, plan) and 14 days (top-ups).
func TestRefundPolicyKeepsRunRefunds(t *testing.T) {
	p := defaultRefundPolicy()
	for _, r := range []string{ReasonRunFailed, ReasonCancel, ReasonCancelledByUs, ReasonLate, ReasonDeletion} {
		if p.modeFor(r, 1_000_000) != "auto" {
			t.Errorf("%s is no longer automatic", r)
		}
	}
	if p.Reasons[ReasonTopupWithdraw] == "" || p.Reasons[ReasonClosure] != "manual" {
		t.Fatalf("reasons %v", p.Reasons)
	}
	if refundRequestWindow != 30*24*time.Hour || withdrawalWindow != 14*24*time.Hour {
		t.Fatalf("windows %s %s", refundRequestWindow, withdrawalWindow)
	}
}
