package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Failed renewals (D5, owner 2026-11-07). Stripe's Smart Retries retry the
// renewal; we mail on the first failure (RN1) and when the bank asks for
// a check (RN2), each with a pay link to the invoice's hosted page (D7).
// Billing and admin show past_due. The plan's benefits — web prices and
// allowances, the app's Pro and plan entitlements — stay on through the
// retries and end when the subscription is canceled; the period's credit
// waits for the invoice to be paid (as before: invoice.paid grants it).

type planInvoice struct {
	ID                 string `json:"id"`
	Status             string `json:"status"`
	AmountDue          int64  `json:"amount_due"`
	Currency           string `json:"currency"`
	AttemptCount       int    `json:"attempt_count"`
	NextPaymentAttempt int64  `json:"next_payment_attempt"`
	HostedInvoiceURL   string `json:"hosted_invoice_url"`
	BillingReason      string `json:"billing_reason"`
	Subscription       string `json:"subscription"`
	Parent             struct {
		SubscriptionDetails struct {
			Subscription string `json:"subscription"`
		} `json:"subscription_details"`
	} `json:"parent"`
}

// handlePlanInvoiceFailed: invoice.payment_failed and
// invoice.payment_action_required on a web plan's renewal.
func (s *Service) handlePlanInvoiceFailed(ctx context.Context, eventType string, raw json.RawMessage) {
	var inv planInvoice
	if json.Unmarshal(raw, &inv) != nil || inv.ID == "" || inv.BillingReason != "subscription_cycle" {
		return // renewals only: a step-up's payment is answered on the spot (D4)
	}
	subID := inv.Subscription
	if subID == "" {
		subID = inv.Parent.SubscriptionDetails.Subscription
	}
	sub, err := s.Stripe.GetSubscription(subID)
	if subID == "" || err != nil || sub.Metadata["product"] != "svs-web" || sub.Metadata["env"] != s.Cfg.Env {
		return
	}
	s.syncPlan(ctx, sub)
	uid := sub.Metadata["user_id"]
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || cust.Plan.SubscriptionID != sub.ID {
		return
	}
	now := time.Now().UTC()
	var next *time.Time
	if inv.NextPaymentAttempt > 0 {
		t := time.Unix(inv.NextPaymentAttempt, 0).UTC()
		next = &t
	}
	name := planName(s, cust.Plan)
	link, pr := s.payLink(ctx, uid, store.PayKindInvoice, inv.ID, inv.AmountDue, "Spatial Video Studio "+name+" renewal")
	var dn store.PlanDunning
	if _, uerr := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan == nil || c.Plan.SubscriptionID != sub.ID {
			return store.ErrStateConflict
		}
		d := c.Plan.Dunning
		if d == nil || d.InvoiceID != inv.ID {
			d = &store.PlanDunning{InvoiceID: inv.ID, FirstFailedAt: now}
		}
		d.AmountDueCents, d.Currency, d.LastFailedAt = inv.AmountDue, inv.Currency, now
		if eventType == "invoice.payment_action_required" {
			d.ActionRequired = true
		} else {
			d.AttemptCount, d.NextAttemptAt = max(inv.AttemptCount, d.AttemptCount), next
		}
		if pr != nil {
			d.PayRequestID = pr.ID
		}
		c.Plan.Dunning, dn = d, *d
		return nil
	}); uerr != nil {
		return
	}
	slog.InfoContext(ctx, "plan renewal failed", "uid", uid, "invoice", inv.ID, "event", eventType, "next_attempt", next)
	if next != nil {
		s.extendDunningEntitlements(ctx, uid, cust.Plan.Tier, *next)
	}
	amount := money(inv.AmountDue)
	if cur := strings.ToLower(inv.Currency); cur != "" && cur != "usd" {
		amount = formatMinor(inv.AmountDue, cur) // a plan sold in the customer's currency renews in it
	}
	email := s.accountEmail(ctx, uid)
	if eventType == "invoice.payment_action_required" {
		s.mailCustomer(ctx, "RN2_"+inv.ID, uid, email, renewalConfirmMail(name, amount, link))
		return
	}
	s.mailCustomer(ctx, "RN1_"+inv.ID, uid, email, renewalFailedMail(name, amount, dn.NextAttemptAt, link))
}

func planName(s *Service, p *store.Plan) string {
	if p.Tier == "pro" {
		return "Pro"
	}
	if def, ok := s.rates(context.Background()).Plan(p.Tier); ok && def.Name != "" {
		return def.Name
	}
	return p.Tier
}

// extendDunningEntitlements keeps the app's entitlements on until Stripe's
// next try (+ the usual grace), so Pro doesn't lapse during Smart Retries.
func (s *Service) extendDunningEntitlements(ctx context.Context, uid, tier string, next time.Time) {
	until := next.Add(planEntitlementGrace)
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || (cust.Plan.RCGrantedUntil != nil && !until.After(*cust.Plan.RCGrantedUntil)) {
		return
	}
	if !s.RevenueCat.CanGrant() || s.promoHeldFor(ctx, uid) != nil {
		return // no key, or a dispute holds the grants (they come back with it)
	}
	if err := s.grantRC(ctx, uid, tier, until); err != nil {
		s.Slack.Alert(ctx, "rc_grant_failed", fmt.Sprintf("entitlements not extended for `%s` through a failed renewal: %v", uid, err))
		return
	}
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil {
			c.Plan.RCGrantedUntil = &until
		}
		return nil
	})
}

// dunningPaid clears a failed renewal once a plan invoice is paid, and
// closes its pay links.
func (s *Service) dunningPaid(ctx context.Context, uid, subID, invoiceID string) {
	if uid == "" {
		return
	}
	_, _ = s.Store.ClosePayRequests(ctx, uid, store.PayKindInvoice, invoiceID, store.PayPaid, "invoice paid")
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil && c.Plan.SubscriptionID == subID && c.Plan.Dunning != nil {
			c.Plan.Dunning = nil
		}
		return nil
	})
}

// endDunnedPlan: a subscription that ended unpaid after a failed renewal
// (canceled or unpaid at the end of Smart Retries) ends the app's
// entitlements now, once; its pay links close.
func (s *Service) endDunnedPlan(ctx context.Context, sub *stripex.Subscription) {
	if sub.Metadata["product"] != "svs-web" || sub.Metadata["env"] != s.Cfg.Env {
		return
	}
	if sub.Status != "canceled" && sub.Status != "unpaid" && sub.Status != "incomplete_expired" {
		return
	}
	uid := sub.Metadata["user_id"]
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || cust.Plan.SubscriptionID != sub.ID || cust.Plan.Dunning == nil || cust.Plan.Dunning.RevokedAt != nil {
		return
	}
	now := time.Now().UTC()
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil && c.Plan.Dunning != nil {
			c.Plan.Dunning.RevokedAt = &now
		}
		return nil
	})
	_, _ = s.Store.ClosePayRequests(ctx, uid, store.PayKindInvoice, cust.Plan.Dunning.InvoiceID, store.PayVoid, "plan ended unpaid")
	s.revokePlanEntitlement(ctx, uid, "renewal unpaid")
	slog.InfoContext(ctx, "plan ended after a failed renewal", "uid", uid, "subscription", sub.ID, "status", sub.Status)
}

// addDunningJSON adds a plan's renewal state to planJSON: past_due, and
// payment_failed_at, next_payment_attempt_at, action_required,
// amount_due_cents, pay_url (null when nothing failed).
func (s *Service) addDunningJSON(out map[string]any, p *store.Plan) {
	out["past_due"] = p.Status == "past_due"
	out["payment_failed_at"], out["next_payment_attempt_at"], out["action_required"], out["amount_due_cents"], out["pay_url"] = nil, nil, false, nil, nil
	d := p.Dunning
	if d == nil || d.RevokedAt != nil {
		return
	}
	out["payment_failed_at"] = d.FirstFailedAt.Format(time.RFC3339)
	if d.NextAttemptAt != nil {
		out["next_payment_attempt_at"] = d.NextAttemptAt.Format(time.RFC3339)
	}
	out["action_required"], out["amount_due_cents"] = d.ActionRequired, d.AmountDueCents
	if d.PayRequestID != "" {
		out["pay_url"] = s.payURL(d.PayRequestID)
	}
}
