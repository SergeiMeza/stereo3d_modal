package api

import (
	"context"
	"fmt"
	"log/slog"
	"slices"
	"strings"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// One saved method per card or account (owner bug 2026-11-05: "Link ·
// j•••@gmail.com" listed twice after paying again with the saved Link).
// A Checkout that saves (setup_future_usage) makes a new PaymentMethod
// each time for the same Link account, and can for the same card.

// methodKey: what makes two saved methods the same: a card's fingerprint
// and expiry (and wallet), a Link or PayPal account's email; "" when it
// can't be told.
func methodKey(m *stripex.CardInfo) string {
	switch {
	case m == nil:
		return ""
	case m.Type == "link" && m.Email != "":
		return "link:" + strings.ToLower(m.Email)
	case m.Type == "paypal" && m.Email != "":
		return "paypal:" + strings.ToLower(m.Email)
	case (m.Type == "card" || m.Type == "") && m.Fingerprint != "":
		return fmt.Sprintf("card:%s:%d/%d:%s", m.Fingerprint, m.ExpMonth, m.ExpYear, m.Wallet)
	}
	return ""
}

// dedupePlan: per set of the same method, the one kept and the ones to
// drop. The kept one is prefer (the method just saved) when it's in the
// set, else the newest, so the method a subscription was just set up
// with stays.
func dedupePlan(methods []*stripex.CardInfo, prefer string) (drop map[string]string) {
	groups := map[string][]*stripex.CardInfo{}
	for _, m := range methods {
		if k := methodKey(m); k != "" {
			groups[k] = append(groups[k], m)
		}
	}
	drop = map[string]string{} // dropped → kept
	for _, g := range groups {
		if len(g) < 2 {
			continue
		}
		keep := g[0]
		for _, m := range g {
			if m.PaymentMethodID == prefer {
				keep = m
				break
			}
			if m.Created > keep.Created || (m.Created == keep.Created && m.PaymentMethodID > keep.PaymentMethodID) {
				keep = m
			}
		}
		for _, m := range g {
			if m != keep {
				drop[m.PaymentMethodID] = keep.PaymentMethodID
			}
		}
	}
	return drop
}

// dedupeMethods detaches the customer's duplicate saved methods, after
// moving to the kept one the account default and any live subscription's
// default that used a dropped one; the account facts (paid methods,
// backup order) follow. Returns how many went.
func (s *Service) dedupeMethods(ctx context.Context, uid, customerID, prefer string) int {
	if s.Stripe == nil || customerID == "" {
		return 0
	}
	methods, err := s.Stripe.ListMethods(customerID)
	if err != nil {
		slog.WarnContext(ctx, "method dedupe: list failed", "err", err)
		return 0
	}
	drop := dedupePlan(methods, prefer)
	if len(drop) == 0 {
		return 0
	}
	cust, _ := s.Store.GetCustomer(ctx, uid)
	n := 0
	for old, keep := range drop {
		if cust != nil && cust.DefaultPaymentMethod == old {
			if err := s.Stripe.SetDefaultMethod(customerID, keep); err != nil {
				slog.WarnContext(ctx, "method dedupe: default not moved", "err", err)
				continue
			}
		}
		subs, err := s.Stripe.SubscriptionsUsingMethod(customerID, old)
		if err != nil {
			slog.WarnContext(ctx, "method dedupe: subscriptions unread", "err", err)
			continue // never detach under a renewal we couldn't check
		}
		moved := true
		for _, sub := range subs {
			if err := s.Stripe.SetSubscriptionMethod(sub, keep); err != nil {
				slog.WarnContext(ctx, "method dedupe: subscription not moved", "subscription", sub, "err", err)
				moved = false
			}
		}
		if !moved {
			continue
		}
		if err := s.Stripe.DetachMethod(old); err != nil {
			slog.WarnContext(ctx, "method dedupe: detach failed", "err", err)
			continue
		}
		s.mergeMethodFacts(ctx, uid, old, keep)
		n++
	}
	cardRefreshedAt.Delete(uid)
	s.refreshCardCache(ctx, uid, customerID)
	slog.InfoContext(ctx, "duplicate saved methods removed", "count", n)
	return n
}

// mergeMethodFacts moves a dropped method's account facts to the kept one.
func (s *Service) mergeMethodFacts(ctx context.Context, uid, old, keep string) {
	if _, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if slices.Contains(c.PaidMethods, old) && !slices.Contains(c.PaidMethods, keep) {
			c.PaidMethods = append(c.PaidMethods, keep)
		}
		c.PaidMethods = slices.DeleteFunc(c.PaidMethods, func(x string) bool { return x == old })
		if i := slices.Index(c.BackupOrder, old); i >= 0 {
			if slices.Contains(c.BackupOrder, keep) {
				c.BackupOrder = slices.Delete(c.BackupOrder, i, i+1)
			} else {
				c.BackupOrder[i] = keep
			}
		}
		if c.LastGoodMethod == old {
			c.LastGoodMethod = keep
		}
		if c.DefaultPaymentMethod == old {
			c.DefaultPaymentMethod = keep
		}
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "method dedupe: facts not merged", "err", err)
	}
}

// uniqueMethods is the list as shown: one entry per card or account (the
// default when it's one of them, else the newest).
func uniqueMethods(methods []*stripex.CardInfo, defaultID string) []*stripex.CardInfo {
	drop := dedupePlan(methods, defaultID)
	return slices.DeleteFunc(slices.Clone(methods), func(m *stripex.CardInfo) bool { _, gone := drop[m.PaymentMethodID]; return gone })
}

// savedOnceTypes: the account methods Checkout shouldn't save again
// (setup_future_usage) because one is already saved: Link and PayPal
// accounts (each save makes a new PaymentMethod for the same account).
// Cards still save (a new card is a new method; the same card is
// deduped on save).
func (s *Service) savedOnceTypes(customerID string) []string {
	if s.Stripe == nil || customerID == "" {
		return nil
	}
	methods, err := s.Stripe.ListMethods(customerID)
	if err != nil {
		return nil
	}
	var out []string
	for _, m := range methods {
		if (m.Type == "link" || m.Type == "paypal") && !slices.Contains(out, m.Type) {
			out = append(out, m.Type)
		}
	}
	return out
}
