package api

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Yearly Studio (owner 2026-11-04): billed $11,988 once a year; $1,500
// of credit and 200 free previews every month of the year, each month
// starting on the subscription's monthly anniversary, unused credit ending
// with its month. The scheduler grants each month (no Stripe invoice),
// once per (subscription, month index); M3 re-grants a missed one. A
// dispute or fraud warning on the year's invoice, or a block, holds the
// grants back (plan.grants_paused); a normal cancel lets them run to the
// end of the year.

// planMonthEntry is a yearly plan month's ledger entry id.
func planMonthEntry(subID string, k int) string { return fmt.Sprintf("plancredit_%s_m%02d", subID, k) }

// grantPlanMonth grants the current month's credit of a yearly plan
// (idempotent). Reports whether it granted now.
func (s *Service) grantPlanMonth(ctx context.Context, uid string, p *store.Plan, def pricing.PlanDef, now time.Time) bool {
	if !p.Yearly() || !p.Active(now) || p.GrantsPaused != "" || def.CreditCents <= 0 {
		return false
	}
	k, _, to, ok := p.Month(now)
	if !ok {
		return false
	}
	id := planMonthEntry(p.SubscriptionID, k)
	if done, err := s.Store.EntryExists(ctx, uid, id); err != nil || done {
		return false
	}
	end := to
	_, fx, err := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: def.CreditCents, EntryID: id, Ref: p.SubscriptionID, ExpiresAt: &end,
			Note: fmt.Sprintf("%s credit, month %d of 12", def.Name, k+1)}}, nil
	})
	if err != nil {
		if done, _ := s.Store.EntryExists(ctx, uid, id); done {
			return false // another instance granted it
		}
		slog.ErrorContext(ctx, "plan month not granted", "uid", uid, "subscription", p.SubscriptionID, "month", k+1, "err", err)
		s.Slack.Alert(ctx, "plan_credit_failed", fmt.Sprintf("%s month %d credit not granted to `%s` (%s): %v", def.Name, k+1, uid, p.SubscriptionID, err))
		return false
	}
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil && c.Plan.SubscriptionID == p.SubscriptionID {
			c.Plan.LastCreditCents = def.CreditCents
		}
		return nil
	})
	slog.InfoContext(ctx, "plan month credit granted", "uid", uid, "plan", p.Tier, "month", k+1, "cents", def.CreditCents, "until", end)
	s.handleBalanceEffects(ctx, uid, fx)
	s.payDebtsFromBalance(ctx, uid)
	return true
}

// planMonthlySweep grants due months of yearly plans (reconciler, every
// 10 minutes).
func (s *Service) planMonthlySweep(ctx context.Context, now time.Time) int {
	custs, err := s.Store.ListPlanCustomers(ctx, 500)
	if err != nil {
		slog.WarnContext(ctx, "plan month sweep: list failed", "err", err)
		return 0
	}
	n := 0
	for uid, c := range custs {
		if c.AccountDeleted || !c.Plan.Yearly() {
			continue
		}
		def, ok := s.rates(ctx).Plan(c.Plan.Tier)
		if ok && s.grantPlanMonth(ctx, uid, c.Plan, def, now) {
			n++
		}
	}
	return n
}

// setGrantsPaused holds back (reason) or resumes ("") a yearly plan's
// monthly grants; a resume grants a month that came due meanwhile.
func (s *Service) setGrantsPaused(ctx context.Context, uid, reason string) {
	c, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil && c.Plan.Yearly() {
			c.Plan.GrantsPaused = reason
		}
		return nil
	})
	if err == nil && reason == "" && c != nil && c.Plan.Yearly() {
		if def, ok := s.rates(ctx).Plan(c.Plan.Tier); ok {
			s.grantPlanMonth(ctx, uid, c.Plan, def, time.Now().UTC())
		}
	}
}
