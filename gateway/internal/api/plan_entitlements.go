package api

import (
	"context"
	"fmt"
	"log/slog"
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
//   - An early end (the plan invoice refunded in full, disputed, a fraud
//     warning on it, the account blocked or deleted) revokes the plan
//     entitlement only. `pro` is never revoked (it may be Pro granted for
//     other reasons) and runs out at its end time.

const planEntitlementGrace = 72 * time.Hour

// grantPlanEntitlements grants the plan's entitlements for invoiceID.
func (s *Service) grantPlanEntitlements(ctx context.Context, uid, tier, invoiceID string, periodEnd time.Time) {
	if uid == "" || (tier != pricing.TierBusiness && tier != pricing.TierStudio) || invoiceID == "" || s.Store == nil {
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
	if err := s.RevenueCat.GrantPromotional(gctx, uid, tier, now, until); err != nil {
		return fmt.Errorf("%s: %w", tier, err)
	}
	if err := s.RevenueCat.GrantPromotional(gctx, uid, "pro", now, until); err != nil {
		return fmt.Errorf("pro: %w", err)
	}
	return nil
}

// revokePlanEntitlement revokes the plan's entitlement (business or
// studio, never pro) on an early end.
func (s *Service) revokePlanEntitlement(ctx context.Context, uid, reason string) {
	if s.Store == nil || uid == "" {
		return
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || (cust.Plan.Tier != pricing.TierBusiness && cust.Plan.Tier != pricing.TierStudio) {
		return
	}
	if cust.Plan.RCRevokedAt != nil && cust.Plan.RCGrantInvoice == "" {
		return
	}
	if !s.RevenueCat.CanGrant() {
		slog.WarnContext(ctx, "plan entitlement not revoked: no RevenueCat secret key", "uid", uid, "reason", reason)
		return
	}
	rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	defer cancel()
	if err := s.RevenueCat.RevokePromotionals(rctx, uid, cust.Plan.Tier); err != nil {
		s.Slack.Alert(ctx, "rc_revoke_failed", fmt.Sprintf("RevenueCat %s not revoked for `%s` (%s): %v", cust.Plan.Tier, uid, reason, err))
		return
	}
	now := time.Now().UTC()
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil {
			c.Plan.RCRevokedAt, c.Plan.RCRevokeReason, c.Plan.RCGrantInvoice = &now, reason, ""
		}
		return nil
	})
	slog.InfoContext(ctx, "plan entitlement revoked", "uid", uid, "plan", cust.Plan.Tier, "reason", reason)
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

// planEarlyEnd handles a refund, dispute or fraud warning on a PaymentIntent
// that paid a plan invoice. Refunds revoke only when the invoice is
// refunded in full.
func (s *Service) planEarlyEnd(ctx context.Context, pi, why string, refundedCents int64) {
	uid, pay := s.planOwnerOfPI(pi)
	if uid == "" {
		return
	}
	if why == "refund" && refundedCents < pay.AmountPaid {
		s.Slack.Alert(ctx, "plan_partial_refund", fmt.Sprintf("plan invoice %s of `%s` partly refunded (%s of %s): entitlements kept",
			pay.InvoiceID, uid, money(refundedCents), money(pay.AmountPaid)))
		return
	}
	s.revokePlanEntitlement(ctx, uid, why+" on "+pay.InvoiceID)
}

// m3Plans: every active plan should hold its entitlement in RevenueCat;
// one that doesn't (and wasn't revoked) is granted again.
func (s *Service) m3Plans(ctx context.Context, rep *M3Report, dryRun bool) {
	if !s.RevenueCat.Configured() {
		return
	}
	custs, err := s.Store.ListPlanCustomers(ctx, 500)
	if err != nil {
		rep.fail("plan customers", err)
		return
	}
	now := time.Now().UTC()
	for uid, c := range custs {
		if !c.Plan.Active(now) || c.Plan.RCRevokedAt != nil || c.AccountDeleted {
			continue
		}
		st, err := s.RevenueCat.Fresh(ctx, uid)
		if err != nil {
			rep.fail("revenuecat "+uid, err)
			continue
		}
		if tierRank(st.Tier) >= tierRank(c.Plan.Tier) {
			continue
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
}
