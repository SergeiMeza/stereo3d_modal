package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Plan credit when a plan ends early (owner rules, 2026-11-03):
//
//  1. a normal cancel keeps the credit until the period's end;
//  2. a refund we grant on a plan invoice (a plan_refund case) removes the
//     unspent credit at once and refunds paid × unspent ÷ credit, rounded
//     down (Business $299 with $200 of $400 left → $149.50); spent credit
//     is never refunded; the plan ends now;
//  3. a dispute or an early fraud warning on the plan invoice freezes the
//     unspent credit; a lost dispute removes it, a won one unfreezes it
//     (it still expires at the period's end);
//  4. an admin block freezes it, an unblock unfreezes it, a permanent
//     block removes it;
//  5. a deletion removes it (never paid out);
//  6. a partial (goodwill) refund keeps it (Slack only);
//  7. credit an in-flight run's quote holds stays for that run: freezes and
//     removals reach the unheld part; frozen credit funds nothing.
//
// Every freeze, unfreeze and removal is a ledger entry with a reason, and
// names its case when there is one.

// ReasonPlanRefund: a refund we grant on a plan invoice (manual case).
const ReasonPlanRefund = "plan_refund"

// planCreditOp writes one plan-credit entry (kind: freeze, unfreeze or
// removal); entryID makes an event's op happen once. Returns the cents.
func (s *Service) planCreditOp(ctx context.Context, uid, kind, ref, caseID, note, entryID string) int64 {
	if s.Store == nil || uid == "" {
		return 0
	}
	if entryID != "" {
		if done, err := s.Store.EntryExists(ctx, uid, entryID); err == nil && done {
			return 0
		}
	}
	b, err := s.Store.GetBalance(ctx, uid)
	if err != nil || !b.Exists() || (kind != store.EntryPlanCreditUnfreeze && b.PlanCreditCents() == 0) ||
		(kind == store.EntryPlanCreditUnfreeze && b.PlanCreditFrozen() == 0) {
		return 0
	}
	before := b.PlanCreditCents()
	frozenBefore := b.PlanCreditFrozen()
	after, fx, err := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: kind, Ref: ref, CaseID: caseID, Note: note, EntryID: entryID}}, nil
	})
	if err != nil {
		slog.ErrorContext(ctx, "plan credit op failed", "uid", uid, "kind", kind, "ref", ref, "err", err)
		s.Slack.Alert(ctx, "plan_credit_op_failed", fmt.Sprintf("%s (%s) on `%s` failed: %v", kind, ref, uid, err))
		return 0
	}
	s.handleBalanceEffects(ctx, uid, fx)
	var cents int64
	switch kind {
	case store.EntryPlanCreditRemoval:
		cents = before - after.PlanCreditCents()
	case store.EntryPlanCreditFreeze:
		cents = after.PlanCreditFrozen() - frozenBefore
	default:
		cents = frozenBefore - after.PlanCreditFrozen()
	}
	slog.InfoContext(ctx, "plan credit "+strings.TrimPrefix(kind, "plan_credit_"), "uid", uid, "ref", ref, "cents", cents, "case_id", caseID)
	return cents
}

// planRefundProposal: what a refund we grant would pay now:
// paid × unheld unspent credit ÷ the period's credit, rounded down.
type planRefundQuote struct {
	InvoiceID, PI, SubscriptionID, Tier  string
	PaidCents, CreditCents, UnspentCents int64
	ProposalCents                        int64
}

func planShare(paid, unspent, credit int64) int64 {
	if credit <= 0 || unspent <= 0 || paid <= 0 {
		return 0
	}
	return paid * min(unspent, credit) / credit // integer division rounds down to the cent
}

func (s *Service) planRefundQuote(ctx context.Context, uid string) (*planRefundQuote, error) {
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || cust.Plan.LastInvoiceID == "" {
		return nil, httpx.Err(http.StatusConflict, "no_plan_invoice", "This account has no paid plan invoice on record.")
	}
	pi, paid, err := s.Stripe.InvoicePayment(cust.Plan.LastInvoiceID)
	if err != nil {
		return nil, err
	}
	q := &planRefundQuote{InvoiceID: cust.Plan.LastInvoiceID, PI: pi, SubscriptionID: cust.Plan.SubscriptionID, Tier: cust.Plan.Tier,
		PaidCents: paid, CreditCents: cust.Plan.LastCreditCents}
	if b, berr := s.Store.GetBalance(ctx, uid); berr == nil {
		q.UnspentCents = b.PlanCreditUnheld()
	}
	if f, ferr := s.Stripe.PaymentFactsOf(pi); ferr == nil {
		q.PaidCents = min(q.PaidCents, f.Received-f.Refunded)
	}
	q.ProposalCents = planShare(q.PaidCents, q.UnspentCents, q.CreditCents)
	return q, nil
}

// openPlanRefundCase opens the manual case for a refund we grant on the
// latest plan invoice; its maximum is the proposal.
func (s *Service) openPlanRefundCase(ctx context.Context, uid, who, text string) (*store.Case, error) {
	q, err := s.planRefundQuote(ctx, uid)
	if err != nil {
		return nil, err
	}
	line := "plan_" + q.InvoiceID
	return s.openCase(ctx, &store.Case{UID: uid, Type: store.CaseRefund, Reason: ReasonPlanRefund, Mode: "manual", Source: "support",
		Status: store.CaseOpen, CustomerVisible: true, CustomerText: text, RequestedCents: q.ProposalCents,
		Items:   map[string]int64{line: q.ProposalCents},
		Related: store.CaseRelated{PIIDs: []string{q.PI}, InvoiceIDs: []string{q.InvoiceID}, ChargeIDs: []string{line}}}, who, text)
}

// planRefundRows is the case page's one row for a plan refund (perRun).
func (s *Service) planRefundRows(ctx context.Context, c *store.Case) ([]map[string]any, int64) {
	q, err := s.planRefundQuote(ctx, c.UID)
	if err != nil || len(c.Related.InvoiceIDs) == 0 || q.InvoiceID != c.Related.InvoiceIDs[0] {
		return []map[string]any{}, 0
	}
	return []map[string]any{{"conversion_id": "plan_" + q.InvoiceID, "kind": "plan", "plan": q.Tier,
		"paid_cents": q.PaidCents, "credit_cents": q.CreditCents, "unspent_cents": q.UnspentCents,
		"refundable_cents": q.ProposalCents,
		"label": fmt.Sprintf("%s plan: %s unspent of %s credit → %s of %s", q.Tier, money(q.UnspentCents), money(q.CreditCents),
			money(q.ProposalCents), money(q.PaidCents))}}, q.ProposalCents
}

// planRefund carries out a granted plan refund: the unspent credit goes
// first (so it can't be spent meanwhile), then the refund of its share,
// then the app's plan entitlement, then the subscription.
func (s *Service) planRefund(ctx context.Context, c *store.Case, want int64, who string) error {
	q, err := s.planRefundQuote(ctx, c.UID)
	if err != nil {
		return err
	}
	if len(c.Related.InvoiceIDs) == 0 || q.InvoiceID != c.Related.InvoiceIDs[0] {
		return httpx.Err(http.StatusConflict, "amount_changed", "A newer plan invoice was paid; open a new case.")
	}
	if q.ProposalCents <= 0 {
		return httpx.Err(http.StatusConflict, "nothing_refundable", "The plan credit is spent: there's nothing to refund.")
	}
	removed := s.planCreditOp(ctx, c.UID, store.EntryPlanCreditRemoval, "refund:"+q.InvoiceID, c.ID, "plan refund granted", "plancredit_refund_"+c.ID)
	amount := min(want, planShare(q.PaidCents, removed, q.CreditCents))
	if amount <= 0 {
		return httpx.Err(http.StatusConflict, "nothing_refundable", "The plan credit is spent: there's nothing to refund.")
	}
	line := "plan_" + q.InvoiceID
	// The plan invoice's charge record, so the ledger serializes refunds
	// on it and the refund gets its credit note (amount-only: the plan's
	// line names no run).
	if err := s.Store.RecordCharge(ctx, &store.Charge{UID: c.UID, Kind: "plan", SourceID: q.InvoiceID, PaymentIntentID: q.PI,
		AmountCents: q.PaidCents, Currency: "usd", PaidAt: time.Now().UTC(), InvoiceState: store.InvoiceDone, InvoiceID: q.InvoiceID,
		Lines: []store.ChargeLine{{ConversionID: line, AmountCents: q.PaidCents, Description: q.Tier + " plan"}}}); err != nil && !errors.Is(err, store.ErrAlreadyExists) {
		return err
	}
	if _, err := s.refund(ctx, c, q.PI, line, map[string]int64{line: amount}, who); err != nil {
		return err
	}
	s.Store.AddCaseEvent(ctx, c.ID, store.CaseEvent{Who: who, Kind: "plan_ended",
		Text: fmt.Sprintf("%s plan credit removed, %s refunded, plan ended", money(removed), money(amount))})
	s.revokePlanEntitlement(ctx, c.UID, "refund on "+q.InvoiceID)
	if q.SubscriptionID != "" {
		if err := s.Stripe.CancelSubscriptionNow(q.SubscriptionID); err != nil {
			s.Slack.Alert(ctx, "plan_cancel_failed", fmt.Sprintf("plan %s of `%s` not cancelled after its refund (%s): %v", q.SubscriptionID, c.UID, c.ID, err))
		}
	}
	return nil
}

// planDisputeClosed: won → unfreeze (it still expires at the period's
// end); lost → remove.
func (s *Service) planDisputeClosed(ctx context.Context, pi, disputeID string, won bool) {
	uid, _ := s.planOwnerOfPI(pi)
	if uid == "" {
		return
	}
	ref := "dispute:" + disputeID
	if won {
		s.planCreditOp(ctx, uid, store.EntryPlanCreditUnfreeze, ref, "", "dispute won", "plancredit_won_"+disputeID)
		return
	}
	s.planCreditOp(ctx, uid, store.EntryPlanCreditRemoval, ref, "", "dispute lost", "plancredit_lost_"+disputeID)
}
