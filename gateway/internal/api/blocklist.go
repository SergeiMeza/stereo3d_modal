package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Repeat-disputer block list (spec H, B11): the card fingerprint of a
// disputed or fraud-warned payment joins blocklist_{env}. It is refused at
// the gate (a saved default card with a blocked fingerprint can't start
// runs or top-ups: 403 payment_method_blocked) and in webhooks (a payment
// that still succeeds with one is refunded in full, the account goes under
// review, Slack is told).

// ReasonBlockedCard: a payment made with a blocked card (auto, any amount).
const ReasonBlockedCard = "blocked_card"

var blockCache struct {
	sync.Mutex
	set map[string]bool
	at  time.Time
}

// blockedSet is the block list, cached 60 s per instance.
func (s *Service) blockedSet(ctx context.Context) map[string]bool {
	blockCache.Lock()
	defer blockCache.Unlock()
	if blockCache.set != nil && time.Since(blockCache.at) < time.Minute {
		return blockCache.set
	}
	set := map[string]bool{}
	if s.Store != nil {
		if list, err := s.Store.BlockedCards(ctx, 5000); err == nil {
			for _, b := range list {
				set[b.Fingerprint] = true
			}
		} else if blockCache.set != nil {
			return blockCache.set
		}
	}
	blockCache.set, blockCache.at = set, time.Now()
	return set
}

func resetBlockCache() {
	blockCache.Lock()
	blockCache.set = nil
	blockCache.Unlock()
}

func (s *Service) isBlocked(ctx context.Context, fp string) bool {
	return fp != "" && s.blockedSet(ctx)[fp]
}

// blockPaymentCard adds the card behind a disputed or warned payment.
func (s *Service) blockPaymentCard(ctx context.Context, f *stripex.PaymentFacts, reason, sourceID, uid string) {
	if f == nil || f.Fingerprint == "" || s.Store == nil {
		return
	}
	added, err := s.Store.BlockCard(ctx, store.BlockedCard{Fingerprint: f.Fingerprint, Reason: reason, SourceID: sourceID, UID: uid,
		PI: f.ID, Brand: f.Brand, Country: f.Country, By: "system"})
	if err != nil {
		slog.WarnContext(ctx, "block list add failed", "pi", f.ID, "err", err)
		return
	}
	if added {
		resetBlockCache()
		slog.InfoContext(ctx, "card blocked", "reason", reason, "source_id", sourceID, "uid", uid)
	}
}

// methodBlocked is the gate: the account's default card is on the list.
func (s *Service) methodBlocked(ctx context.Context, uid string, cust *store.Customer) bool {
	if cust == nil || cust.DefaultPaymentMethod == "" || len(s.blockedSet(ctx)) == 0 {
		return false
	}
	fp := cust.DefaultFingerprint
	if fp == "" && (cust.DefaultMethodType == "" || cust.DefaultMethodType == "card") {
		got, err := s.Stripe.PaymentMethodFingerprint(cust.DefaultPaymentMethod)
		if err != nil || got == "" {
			return false
		}
		fp = got
		pm := cust.DefaultPaymentMethod
		s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
			if c.DefaultPaymentMethod == pm {
				c.DefaultFingerprint = got
			}
			return nil
		})
	}
	if !s.isBlocked(ctx, fp) {
		return false
	}
	s.Store.NoteBlockHit(ctx, fp)
	return true
}

func errMethodBlocked() error {
	return httpx.Err(http.StatusForbidden, "payment_method_blocked",
		"this payment method can't be used; add a different one in Billing or contact support")
}

// checkBlockedPayment runs after a payment_intent success event: a
// payment made with a blocked card is refunded in full and flagged.
func (s *Service) checkBlockedPayment(ctx context.Context, piID string) {
	if s.Store == nil || len(s.blockedSet(ctx)) == 0 {
		return
	}
	o, ok := s.ownerOfPI(piID)
	if !ok || o.UID == "" || o.Facts == nil || !s.isBlocked(ctx, o.Facts.Fingerprint) {
		return
	}
	s.Store.NoteBlockHit(ctx, o.Facts.Fingerprint)
	s.Store.UpdateCustomer(ctx, o.UID, func(c *store.Customer) error { c.UnderReview = true; return nil })
	msg := fmt.Sprintf("payment %s on account `%s` used a blocked card (%s); refunding it, account under review", piID, o.UID, money(o.Facts.Received))
	s.Slack.Alert(ctx, "blocked_card", msg)
	switch {
	case o.TopupID != "":
		if _, err := s.requestBalanceRefund(ctx, o.UID, ReasonTopupWithdraw, o.TopupID, "system", "system", "paid with a blocked card"); err != nil {
			slog.WarnContext(ctx, "blocked top-up not refunded", "pi", piID, "err", err)
		}
	default:
		runs := s.runsOf(ctx, o)
		if len(runs) == 0 {
			s.refundExtraPayment(ctx, o.UID, piID, o.Facts.Received, ReasonLate, "paid with a blocked card", store.CaseRelated{})
			return
		}
		// Undelivered runs are cancelled as ours and refunded in full;
		// delivered ones open a manual case.
		if _, err := s.requestRefund(ctx, RefundRequest{UID: o.UID, ConversionIDs: runs, Reason: ReasonCancelledByUs,
			Source: "system", Who: "system", Text: "paid with a blocked card"}); err != nil {
			slog.WarnContext(ctx, "blocked payment refund failed", "pi", piID, "err", err)
		}
	}
}

// usableMethods drops saved cards on the block list from the backup loops.
func (s *Service) usableMethods(ctx context.Context, methods []*stripex.CardInfo) []*stripex.CardInfo {
	if len(s.blockedSet(ctx)) == 0 {
		return methods
	}
	out := make([]*stripex.CardInfo, 0, len(methods))
	for _, m := range methods {
		if !s.isBlocked(ctx, m.Fingerprint) {
			out = append(out, m)
		}
	}
	return out
}
