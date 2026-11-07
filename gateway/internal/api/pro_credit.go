package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Pro's usage credit, once (owner 2026-11-07; superseded the monthly
// grant of PRO-01..05 the same day; pricing config pro_credit_cents, TEST
// only until prod sets it):
//
//   - $20 when someone subscribes to Pro on the web, or the first time
//     they're seen on the web (GET /v1/billing, GET /v1/pro at sign-in,
//     the RevenueCat webhook) holding paid Pro from the apps. Lifetime
//     too. A free trial counts (PRO-06); gifts, promos and admin grants
//     (promotional) get nothing (PRO-02).
//   - Once per account, ever (ledger entry procredit_once_<uid>; an
//     account with an earlier monthly grant counts as granted), and once
//     per store purchase (its original transaction: grant once_<hash>),
//     so the same purchase can't grant on a second account. Renewals,
//     re-subscribing and switching plans never grant again.
//   - It expires pro_credit_expiry_days (30) after the grant and is never
//     paid out. A refund takes back its unspent part (PRO-07); repeat
//     refunders are flagged.
//   - A Business or Studio plan's credit wins (PRO-10): no Pro credit
//     while one is active, and a plan's grant replaces it.
//   - Anonymous app holders get it at their first web sign-in; there is
//     no back-pay.

// proCreditSource is what earns this month's Pro credit.
type proCreditSource struct {
	Kind, Source, PeriodType, Key string
	Anchor                        time.Time
	PaidUntil                     *time.Time
}

// proCreditSourceOf picks the one paid Pro that earns credit (web Pro on
// our Stripe first, else RevenueCat's); nil without one, or with a
// Business or Studio plan (PRO-10).
func (s *Service) proCreditSourceOf(ctx context.Context, cust *store.Customer, st *revenuecat.Status, now time.Time) *proCreditSource {
	if cust != nil && cust.Plan.Active(now) && (cust.Plan.Tier == pricing.TierBusiness || cust.Plan.Tier == pricing.TierStudio) {
		return nil
	}
	if st != nil && (st.Tier == revenuecat.TierBusiness || st.Tier == revenuecat.TierStudio) {
		return nil
	}
	if cust != nil && cust.Plan.Active(now) && cust.Plan.Tier == pricing.TierPro && cust.Plan.PlanID != "" && cust.Plan.SubscriptionID != "" {
		p := cust.Plan
		anchor := p.StartedAt
		if anchor == nil {
			anchor = p.CurrentPeriodStart
		}
		if anchor == nil {
			return nil
		}
		return &proCreditSource{Kind: p.PlanID, Source: "web", Key: "stripe:" + p.SubscriptionID, Anchor: *anchor, PaidUntil: p.CurrentPeriodEnd}
	}
	if st == nil || !st.Pro || st.Credit == nil || !st.Credit.Paid {
		return nil
	}
	kind := st.CreditKind()
	if kind == "" {
		return nil
	}
	c := st.Credit
	return &proCreditSource{Kind: kind, Source: c.Store, PeriodType: c.PeriodType, Key: c.Key, Anchor: c.Anchor, PaidUntil: c.PaidUntil}
}

// proMonth is the month of a purchase now is in: its index and window
// [from, to), counted from the anchor's anniversaries.
func proMonth(anchor, now time.Time) (int, time.Time, time.Time) {
	k := 0
	for k < 1200 && !store.AddMonths(anchor, k+1).After(now) {
		k++
	}
	return k, store.AddMonths(anchor, k), store.AddMonths(anchor, k+1)
}

// proCreditView is GET /v1/billing's pro_credit: {cents, granted,
// granted_at, expires_at, left_cents, source, trial, kind}.
type proCreditView struct {
	Cents     int64      `json:"cents"`
	Kind      string     `json:"kind"`
	Source    string     `json:"source"`
	Trial     bool       `json:"trial"`
	Granted   bool       `json:"granted"` // false: the purchase's credit went to the account it was on before
	GrantedAt *time.Time `json:"granted_at"`
	ExpiresAt *time.Time `json:"expires_at"`
	LeftCents int64      `json:"left_cents"` // this credit's unspent part
	// grantedNow: granted by this call (tests).
	grantedNow bool
}

func (s *Service) proRCStatus(ctx context.Context, uid string) *revenuecat.Status {
	if !s.RevenueCat.Configured() {
		return nil
	}
	st, err := s.RevenueCat.Pro(ctx, uid)
	if err != nil {
		slog.WarnContext(ctx, "pro credit: RevenueCat unread", "err", err)
		return nil
	}
	return &st
}

// ensureProCredit grants the one-time Pro credit when it's due (and takes
// back refunded purchases' first); nil when the account earns none.
func (s *Service) ensureProCredit(ctx context.Context, uid string) *proCreditView {
	rates := s.rates(ctx)
	if s.Store == nil || len(rates.ProCreditCents) == 0 || uid == "" {
		return nil
	}
	now := time.Now().UTC()
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil {
		cust = nil
	}
	if cust != nil && (cust.AccountDeleted || cust.DeletionPending) {
		return nil
	}
	st := s.proRCStatus(ctx, uid)
	if st != nil {
		for _, key := range st.Refunded {
			s.proCreditRefund(ctx, uid, key, "store refund")
		}
	}
	// Once per account: an earlier grant (the monthly ones on TEST too)
	// is the answer from now on.
	if grants, err := s.Store.ListProCreditGrants(ctx, uid, 24); err == nil {
		for _, g := range grants { // newest first
			switch g.State {
			case store.ProCreditGranted:
				return s.proCreditViewOf(ctx, uid, g)
			case store.ProCreditRemoved:
				return nil // refunded: gone, and never granted again
			}
		}
	}
	src := s.proCreditSourceOf(ctx, cust, st, now)
	if src == nil || (src.PaidUntil != nil && !now.Before(*src.PaidUntil)) {
		return nil
	}
	hash := store.ProKeyHash(src.Key)
	if cust != nil {
		for _, k := range cust.ProRefundedKeys {
			if k == hash {
				return nil // a refunded purchase earns nothing
			}
		}
	}
	cents := rates.ProCreditFor(src.Kind)
	if cents <= 0 {
		return nil
	}
	exp := now.AddDate(0, 0, rates.ProCreditExpiryDays())
	view := &proCreditView{Cents: cents, Kind: src.Kind, Source: src.Source, Trial: src.PeriodType == "trial"}
	g, err := s.Store.ClaimProCreditGrant(ctx, &store.ProCreditGrant{ID: store.ProCreditOnceID(hash), UID: uid, KeyHash: hash,
		PeriodStart: now, PeriodEnd: exp, Cents: cents, Kind: src.Kind, Source: src.Source, PeriodType: src.PeriodType, GrantedAt: now})
	switch {
	case errors.Is(err, store.ErrProCreditTaken):
		slog.InfoContext(ctx, "pro credit: this purchase's credit went to another account", "kind", src.Kind)
		return view
	case err != nil:
		slog.WarnContext(ctx, "pro credit: claim failed", "err", err)
		return view
	case g.State == store.ProCreditGranting:
		if !s.grantProCreditEntry(ctx, uid, g) {
			return view
		}
		g.State = store.ProCreditGranted
		v := s.proCreditViewOf(ctx, uid, g)
		v.grantedNow = true
		return v
	}
	return s.proCreditViewOf(ctx, uid, g)
}

// proCreditViewOf is a grant as GET /v1/billing shows it.
func (s *Service) proCreditViewOf(ctx context.Context, uid string, g *store.ProCreditGrant) *proCreditView {
	at, end := g.GrantedAt, g.PeriodEnd
	v := &proCreditView{Cents: g.Cents, Kind: g.Kind, Source: g.Source, Trial: g.PeriodType == "trial",
		Granted: g.State == store.ProCreditGranted || g.State == store.ProCreditRemoved, GrantedAt: &at, ExpiresAt: &end}
	if b, err := s.Store.GetBalance(ctx, uid); err == nil {
		for _, it := range b.Fifo {
			if it.PlanCredit && it.Ref == "pro:"+g.KeyHash && (it.ExpiresAt == nil || it.ExpiresAt.After(time.Now())) {
				v.LeftCents += it.RemainingCents
			}
		}
	}
	return v
}

// grantProCreditEntry writes a claimed month's ledger entry (once per
// account: its entry id) and marks the grant.
func (s *Service) grantProCreditEntry(ctx context.Context, uid string, g *store.ProCreditGrant) bool {
	entry := "procredit_" + g.ID
	note := fmt.Sprintf("Pro credit, month %d", g.Month+1)
	once := store.IsProCreditOnce(g.ID)
	if once {
		entry, note = "procredit_once_"+uid, "Pro credit" // one per account, ever (tx.Create on the entry)
	}
	done, err := s.Store.EntryExists(ctx, uid, entry)
	if err != nil {
		return false
	}
	if !done {
		end := g.PeriodEnd
		_, fx, err := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
			return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: g.Cents, EntryID: entry, Ref: "pro:" + g.KeyHash, ExpiresAt: &end,
				Note: note, Additive: once}}, nil
		})
		if err != nil {
			if done, _ := s.Store.EntryExists(ctx, uid, entry); !done {
				slog.ErrorContext(ctx, "pro credit not granted", "kind", g.Kind, "err", err)
				return false
			}
		} else {
			s.handleBalanceEffects(ctx, uid, fx)
			s.payDebtsFromBalance(ctx, uid)
		}
	}
	if err := s.Store.MarkProCreditGrant(ctx, g.ID, store.ProCreditGranted, 0, time.Now().UTC()); err != nil {
		slog.WarnContext(ctx, "pro credit: grant not marked", "err", err)
	}
	slog.InfoContext(ctx, "pro credit granted", "kind", g.Kind, "once", once, "cents", g.Cents, "source", g.Source, "until", g.PeriodEnd)
	return true
}

// proCreditRefund takes back the unspent Pro credit of a refunded purchase
// (PRO-07): never what was spent; counted once per purchase; two or more
// refunds flag the customer.
func (s *Service) proCreditRefund(ctx context.Context, uid, key, why string) {
	hash := store.ProKeyHash(key)
	grants, err := s.Store.ListProCreditGrants(ctx, uid, 50)
	if err != nil {
		return
	}
	now := time.Now().UTC()
	var live []*store.ProCreditGrant
	found := false
	for _, g := range grants {
		if g.KeyHash != hash {
			continue
		}
		found = true
		if g.State == store.ProCreditGranted && g.PeriodEnd.After(now) {
			live = append(live, g)
		}
	}
	// counted whether or not it earned credit (once per account: a second
	// purchase earns none, and repeat refunders are still flagged)
	_ = found
	removed := int64(0)
	if len(live) > 0 {
		removed = s.removeProCredit(ctx, uid, hash, why)
		for _, g := range live {
			s.Store.MarkProCreditGrant(ctx, g.ID, store.ProCreditRemoved, removed, now)
			removed = 0
		}
	}
	isNew, c, err := s.Store.NoteProRefund(ctx, uid, hash)
	if errors.Is(err, store.ErrNotFound) {
		s.Store.PutCustomer(ctx, uid, &store.Customer{CreatedAt: now})
		isNew, c, err = s.Store.NoteProRefund(ctx, uid, hash)
	}
	if err == nil && isNew && c != nil && c.ProRefundFlag && s.Slack != nil {
		s.Slack.Alert(ctx, "pro_refund_repeat", fmt.Sprintf("an account refunded Pro %d times; see its account page (pro_credit.refund_flag)", c.ProRefunds))
	}
	slog.InfoContext(ctx, "pro credit refund", "why", why, "new", isNew)
}

// removeProCredit takes back a refunded purchase's unspent Pro credit and
// only that (an admin's or a plan's credit stays).
func (s *Service) removeProCredit(ctx context.Context, uid, hash, why string) int64 {
	entry := "procredit_refund_" + hash
	if done, err := s.Store.EntryExists(ctx, uid, entry); err == nil && done {
		return 0
	}
	b, err := s.Store.GetBalance(ctx, uid)
	if err != nil || !b.Exists() {
		return 0
	}
	before := b.PlanCreditCents()
	after, fx, err := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryPlanCreditRemoval, Ref: "pro:" + hash, MatchRef: true,
			Note: "Pro refunded (" + why + ")", EntryID: entry}}, nil
	})
	if err != nil {
		slog.ErrorContext(ctx, "pro credit removal failed", "err", err)
		return 0
	}
	s.handleBalanceEffects(ctx, uid, fx)
	return before - after.PlanCreditCents()
}

// proCreditSweep granted the monthly Pro credit; the one-time credit has
// no months, so there is nothing to sweep (kept for the balance sweep).
func (s *Service) proCreditSweep(context.Context, time.Time) int { return 0 }

// proCreditAdminJSON is the account page's pro_credit.
func (s *Service) proCreditAdminJSON(ctx context.Context, uid string, cust *store.Customer) map[string]any {
	grants, _ := s.Store.ListProCreditGrants(ctx, uid, 24)
	if grants == nil {
		grants = []*store.ProCreditGrant{}
	}
	out := map[string]any{"grants": grants, "refunds": 0, "refund_flag": false}
	if cust != nil {
		out["refunds"], out["refund_flag"] = cust.ProRefunds, cust.ProRefundFlag
	}
	return out
}

// proCreditEligible: the one-time Pro credit can still be granted to this
// account (the web says "your $20 credit covers this video" only then).
// False when the credit is off, the account ever had a grant (granted,
// being granted or removed by a refund) or its once-per-account entry,
// it's being deleted, a Business or Studio plan is active, or the Pro it
// holds is a purchase whose credit went to another account or was
// refunded — the same keying as the grant (once_<hash of the original
// transaction>).
func (s *Service) proCreditEligible(ctx context.Context, uid string) bool {
	rates := s.rates(ctx)
	if s.Store == nil || len(rates.ProCreditCents) == 0 || uid == "" {
		return false
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return false
	}
	if err != nil {
		cust = nil
	}
	if cust != nil && (cust.AccountDeleted || cust.DeletionPending) {
		return false
	}
	now := time.Now().UTC()
	if cust != nil && cust.Plan.Active(now) && (cust.Plan.Tier == pricing.TierBusiness || cust.Plan.Tier == pricing.TierStudio) {
		return false
	}
	grants, err := s.Store.ListProCreditGrants(ctx, uid, 24)
	if err != nil {
		return false
	}
	if len(grants) > 0 {
		return false // any grant, a refunded one included: once per account
	}
	if done, err := s.Store.EntryExists(ctx, uid, "procredit_once_"+uid); err != nil || done {
		return false
	}
	if src := s.proCreditSourceOf(ctx, cust, s.proRCStatus(ctx, uid), now); src != nil {
		hash := store.ProKeyHash(src.Key)
		if cust != nil && slices.Contains(cust.ProRefundedKeys, hash) {
			return false
		}
		if g, err := s.Store.GetProCreditGrant(ctx, store.ProCreditOnceID(hash)); err == nil && g.UID != uid {
			return false // this purchase's credit went to another account
		}
	}
	return true
}
