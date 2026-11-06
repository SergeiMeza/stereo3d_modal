package api

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// RevenueCat entitlements for web plans (owner decision 2026-11-03,
// option b: promotional grants, no Stripe app in RevenueCat). The Stripe
// mirror (cust.Plan) stays the source of truth for the plan and its
// credit; the entitlements are for the app.
//
//   - A paid plan invoice grants `business` (or `studio`) AND `pro` to the
//     uid from now until the invoice's period end + 3 days, once per
//     invoice (recorded on the plan). Retries on 5xx/429, Slack after the
//     last failure; a failed grant never blocks the credit or the payment.
//   - A normal end (cancel at period end, non-payment) needs nothing: the
//     grant runs out.
//   - A full refund revokes the plan's entitlement and its pro; a dispute
//     or fraud warning removes every promotional Pro until it is resolved;
//     the account blocked or deleted revokes the plan entitlement only.
//     Other promotional grants are snapshotted first and given back
//     (promo_regrant.go).

const planEntitlementGrace = 72 * time.Hour

// grantPlanEntitlements grants the plan's entitlements for invoiceID.
func (s *Service) grantPlanEntitlements(ctx context.Context, uid, tier, invoiceID string, periodEnd time.Time) {
	if uid == "" || (tier != pricing.TierBusiness && tier != pricing.TierStudio && tier != pricing.TierPro) || invoiceID == "" || s.Store == nil {
		return
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil {
		return
	}
	if cust.Plan.RCGrantInvoice == invoiceID {
		return // granted for this invoice already
	}
	if !s.RevenueCat.CanGrant() {
		slog.WarnContext(ctx, "plan entitlements not granted: no RevenueCat secret key", "uid", uid, "plan", tier, "invoice", invoiceID)
		return
	}
	until := periodEnd.Add(planEntitlementGrace)
	if h := s.promoHeldFor(ctx, uid); h != nil {
		// A dispute or fraud warning is open: the grants join its hold and
		// come back with the rest when it is won or cleared.
		add := []store.PromoGrant{{Entitlement: "pro", ExpiresAt: &until}}
		if tier != pricing.TierPro {
			add = append(add, store.PromoGrant{Entitlement: tier, ExpiresAt: &until})
		}
		s.Store.UpdatePromoRegrant(ctx, h.ID, func(r *store.PromoRegrant) error {
			r.Snapshot = mergeGrants(r.Snapshot, add)
			return nil
		})
		s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
			if c.Plan != nil {
				c.Plan.RCGrantInvoice, c.Plan.RCGrantedUntil = invoiceID, &until
			}
			return nil
		})
		slog.InfoContext(ctx, "plan entitlements held for an open dispute", "uid", uid, "plan", tier, "invoice", invoiceID, "hold", h.ID)
		return
	}
	if err := s.grantRC(ctx, uid, tier, until); err != nil {
		s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
			if c.Plan != nil {
				c.Plan.RCGrantError = err.Error()
			}
			return nil
		})
		s.Slack.Alert(ctx, "rc_grant_failed", fmt.Sprintf("RevenueCat entitlements not granted for `%s` (%s, invoice %s): %v", uid, tier, invoiceID, err))
		return
	}
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil {
			c.Plan.RCGrantInvoice, c.Plan.RCGrantedUntil, c.Plan.RCGrantError = invoiceID, &until, ""
			c.Plan.RCRevokedAt, c.Plan.RCRevokeReason = nil, ""
		}
		return nil
	})
	slog.InfoContext(ctx, "plan entitlements granted", "uid", uid, "plan", tier, "invoice", invoiceID, "until", until)
}

// grantRC grants tier and pro until `until` (its own deadline: the
// retries must finish even when the webhook's caller has gone).
func (s *Service) grantRC(ctx context.Context, uid, tier string, until time.Time) error {
	gctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	now := time.Now().UTC()
	if tier != pricing.TierPro { // web Pro: the pro grant alone
		if err := s.RevenueCat.GrantPromotional(gctx, uid, tier, now, until); err != nil {
			return fmt.Errorf("%s: %w", tier, err)
		}
	}
	if err := s.RevenueCat.GrantPromotional(gctx, uid, "pro", now, until); err != nil {
		return fmt.Errorf("pro: %w", err)
	}
	return nil
}

// revokePlanEntitlement revokes the plan's entitlement (business or
// studio; pro for a web Pro plan) on an early end that isn't a refund or
// a dispute (account blocked or deleted). Other promotional grants of the
// same entitlement are given back (promo_regrant.go).
func (s *Service) revokePlanEntitlement(ctx context.Context, uid, reason string) {
	if s.Store == nil || uid == "" {
		return
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || (cust.Plan.RCRevokedAt != nil && cust.Plan.RCGrantInvoice == "") {
		return
	}
	s.promoRevokeOurs(ctx, uid, "end:"+cust.Plan.SubscriptionID+":"+slugReason(reason), reason, false)
}

// revokeRefundedPlan: a refunded plan invoice's grants (the plan's
// entitlement and its pro) go; every other promotional grant comes back.
func (s *Service) revokeRefundedPlan(ctx context.Context, uid, invoiceID string) {
	s.promoRevokeOurs(ctx, uid, "refund:"+invoiceID, "refund on "+invoiceID, true)
}

func slugReason(r string) string {
	return strings.Map(func(c rune) rune {
		if (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
			return c
		}
		return '_'
	}, strings.ToLower(r))
}

// planOwnerOfPI: the uid whose plan invoice pi paid ("" when pi paid no
// plan of ours).
func (s *Service) planOwnerOfPI(pi string) (uid string, pay *stripex.PlanPayment) {
	if pi == "" {
		return "", nil
	}
	pay, err := s.Stripe.PlanPaymentOf(pi)
	if err != nil || pay == nil {
		return "", nil
	}
	sub, err := s.Stripe.GetSubscription(pay.SubscriptionID)
	if err != nil || sub.Metadata["product"] != "svs-web" || sub.Metadata["env"] != s.Cfg.Env {
		return "", nil
	}
	return sub.Metadata["user_id"], pay
}

// planEarlyEnd handles a refund, dispute or fraud warning (ref: its id)
// on a PaymentIntent that paid a plan invoice: a full refund removes the
// unspent credit, a dispute or warning freezes it; all three revoke the
// plan's app entitlement. A partial refund only alerts Slack.
func (s *Service) planEarlyEnd(ctx context.Context, pi, why, ref string, cents int64, caseID string) {
	uid, pay := s.planOwnerOfPI(pi)
	if uid == "" {
		return
	}
	switch why {
	case "refund":
		if cents < pay.AmountPaid {
			s.Slack.Alert(ctx, "plan_partial_refund", fmt.Sprintf("plan invoice %s of `%s` partly refunded (%s of %s): credit and entitlements kept",
				pay.InvoiceID, uid, money(cents), money(pay.AmountPaid)))
			return
		}
		s.planCreditOp(ctx, uid, store.EntryPlanCreditRemoval, "refund:"+pay.InvoiceID, "", "plan invoice refunded in full", "plancredit_refund_"+pay.InvoiceID)
		s.revokeRefundedPlan(ctx, uid, pay.InvoiceID)
	case "dispute":
		s.planCreditOp(ctx, uid, store.EntryPlanCreditFreeze, "dispute:"+ref, "", "plan invoice disputed", "plancredit_freeze_"+ref)
		s.setGrantsPaused(ctx, uid, "dispute:"+ref)
		if cents == 0 {
			cents = pay.AmountPaid
		}
		s.promoHold(ctx, uid, "dispute:"+ref, why+" on "+pay.InvoiceID, cents, caseID)
	case "fraud warning":
		s.planCreditOp(ctx, uid, store.EntryPlanCreditFreeze, "efw:"+ref, "", "early fraud warning on the plan invoice", "plancredit_freeze_"+ref)
		s.setGrantsPaused(ctx, uid, "efw:"+ref)
		s.promoHold(ctx, uid, "efw:"+ref, why+" on "+pay.InvoiceID, pay.AmountPaid, "")
	}
}

// m3Plans: every active plan should hold its entitlement in RevenueCat;
// one that doesn't (and wasn't revoked) is granted again.
func (s *Service) m3Plans(ctx context.Context, rep *M3Report, dryRun bool) {
	custs, err := s.Store.ListPlanCustomers(ctx, 500)
	if err != nil {
		rep.fail("plan customers", err)
		return
	}
	now := time.Now().UTC()
	for uid, c := range custs {
		s.m3PlanOne(ctx, rep, uid, c, now, dryRun)
	}
}

// m3PlanOne is M3's plan check for one account (the nightly run and
// Restore Purchases): a yearly plan's missed month, and the app's
// entitlement missing in RevenueCat.
func (s *Service) m3PlanOne(ctx context.Context, rep *M3Report, uid string, c *store.Customer, now time.Time, dryRun bool) {
	if c == nil || c.Plan == nil {
		return
	}
	// A yearly plan's month that wasn't granted (plan_credit_missed).
	if c.Plan.Yearly() && c.Plan.Active(now) && c.Plan.GrantsPaused == "" && !c.AccountDeleted {
		if k, _, _, ok := c.Plan.Month(now); ok {
			if done, _ := s.Store.EntryExists(ctx, uid, planMonthEntry(c.Plan.SubscriptionID, k)); !done {
				f := M3Flag{Flag: "plan_credit_missed", Ref: uid, UID: uid, Detail: fmt.Sprintf("%s month %d of 12", c.Plan.Tier, k+1)}
				if def, ok := s.rates(ctx).Plan(c.Plan.Tier); ok && !dryRun && s.grantPlanMonth(ctx, uid, c.Plan, def, now) {
					f.Action = "granted"
				}
				rep.add(f)
			}
		}
	}
	if !s.RevenueCat.Configured() || !c.Plan.Active(now) || c.Plan.RCRevokedAt != nil || c.AccountDeleted {
		return
	}
	st, err := s.RevenueCat.Fresh(ctx, uid)
	if err != nil {
		rep.fail("revenuecat "+uid, err)
		return
	}
	if tierRank(st.Tier) >= tierRank(c.Plan.Tier) || (c.Plan.Tier == pricing.TierPro && st.Pro) {
		return
	}
	f := M3Flag{Flag: "plan_entitlement_missing", Ref: uid, UID: uid, Detail: fmt.Sprintf("%s plan, RevenueCat tier %q", c.Plan.Tier, st.Tier)}
	if !dryRun && s.RevenueCat.CanGrant() && c.Plan.CurrentPeriodEnd != nil {
		until := c.Plan.CurrentPeriodEnd.Add(planEntitlementGrace)
		if err := s.grantRC(ctx, uid, c.Plan.Tier, until); err != nil {
			f.Action = "re-grant failed: " + err.Error()
		} else {
			f.Action = "granted again until " + until.Format(time.RFC3339)
		}
	}
	rep.add(f)
}
