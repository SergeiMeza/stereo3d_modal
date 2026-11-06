package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Pro's monthly usage credit (owner 2026-11-07, PRO-01..11; pricing
// config pro_credit_cents, TEST only until prod sets it):
//
//   - PRO-01/02: paid Pro gets plan credit every month on top of its
//     discount: App Store, Mac App Store and RevenueCat Billing purchases
//     (RevenueCat), and web Pro on our own Stripe (our plan record, never
//     RevenueCat's promotional grant behind it). Gifts, promos and admin
//     grants (promotional) get none.
//   - PRO-03/04/05: each month runs from the purchase's anniversary (a
//     subscription's original purchase) and its credit ends with it, no
//     rollover; yearly gets it monthly, never upfront; Lifetime $10.
//   - PRO-06: a free trial counts. A month is granted once per store
//     purchase (its original transaction, else its original purchase
//     time) whoever holds it, so a re-trial on the same purchase or a
//     transfer to another account gets nothing twice.
//   - PRO-07: a refund takes back the month's unspent credit (never what
//     was spent) and counts on the customer; two or more flag it.
//   - PRO-08: after a cancel the months keep coming to the paid period's end.
//   - PRO-09: an anonymous holder's credit starts at sign-in, no back-pay
//     (only the current month is ever granted).
//   - PRO-10: a Business or Studio plan's credit wins; Pro adds nothing.
//
// Triggers: GET /v1/billing and GET /v1/pro (the person is there), the
// RevenueCat webhook when configured, a web Pro invoice, and a sweep every
// 10 minutes over accounts known to hold paid Pro (pro_credit_holders).

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

// proCreditView is GET /v1/billing's pro_credit.
type proCreditView struct {
	CentsPerMonth int64     `json:"cents_per_month"`
	Kind          string    `json:"kind"`
	Source        string    `json:"source"`
	Trial         bool      `json:"trial"`
	PeriodStart   time.Time `json:"period_start"`
	PeriodEnd     time.Time `json:"period_end"`
	// Granted: this month's credit is on this account (false when the
	// purchase's month went to the account it was on before a transfer).
	Granted   bool  `json:"granted"`
	LeftCents int64 `json:"left_cents"`
	// grantedNow: granted by this call (the sweep's count, tests).
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

// ensureProCredit grants the current month's Pro credit when due (and
// takes back refunded months first); nil when the account earns none.
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
		if len(st.Refunded) > 0 {
			cust, _ = s.Store.GetCustomer(ctx, uid)
		}
	}
	src := s.proCreditSourceOf(ctx, cust, st, now)
	if src == nil || (src.PaidUntil != nil && !now.Before(*src.PaidUntil)) {
		s.Store.DropProCreditHolder(ctx, uid)
		return nil
	}
	hash := store.ProKeyHash(src.Key)
	if cust != nil {
		for _, k := range cust.ProRefundedKeys {
			if k == hash {
				return nil // refunded: no more months from that purchase
			}
		}
	}
	cents := rates.ProCreditFor(src.Kind)
	if cents <= 0 {
		return nil
	}
	k, from, to := proMonth(src.Anchor, now)
	view := &proCreditView{CentsPerMonth: cents, Kind: src.Kind, Source: src.Source, Trial: src.PeriodType == "trial", PeriodStart: from, PeriodEnd: to}
	g, err := s.Store.ClaimProCreditGrant(ctx, &store.ProCreditGrant{ID: store.ProCreditGrantID(hash, k), UID: uid, KeyHash: hash, Month: k,
		PeriodStart: from, PeriodEnd: to, Cents: cents, Kind: src.Kind, Source: src.Source, PeriodType: src.PeriodType, GrantedAt: now})
	switch {
	case errors.Is(err, store.ErrProCreditTaken):
		slog.InfoContext(ctx, "pro credit: this month went to the account the purchase was on", "kind", src.Kind)
	case err != nil:
		slog.WarnContext(ctx, "pro credit: claim failed", "err", err)
	case g.State == store.ProCreditGranting:
		if s.grantProCreditEntry(ctx, uid, g) {
			view.Granted, view.grantedNow = true, true
		}
	default:
		view.Granted = g.State == store.ProCreditGranted
	}
	s.Store.SetProCreditHolder(ctx, uid, src.Kind, to)
	if b, err := s.Store.GetBalance(ctx, uid); err == nil {
		view.LeftCents = b.PlanCreditCents()
	}
	return view
}

// grantProCreditEntry writes a claimed month's ledger entry (once per
// account: its entry id) and marks the grant.
func (s *Service) grantProCreditEntry(ctx context.Context, uid string, g *store.ProCreditGrant) bool {
	entry := "procredit_" + g.ID
	done, err := s.Store.EntryExists(ctx, uid, entry)
	if err != nil {
		return false
	}
	if !done {
		end := g.PeriodEnd
		_, fx, err := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
			return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: g.Cents, EntryID: entry, Ref: "pro:" + g.KeyHash, ExpiresAt: &end,
				Note: fmt.Sprintf("Pro credit, month %d", g.Month+1)}}, nil
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
	slog.InfoContext(ctx, "pro credit granted", "kind", g.Kind, "month", g.Month+1, "cents", g.Cents, "source", g.Source, "until", g.PeriodEnd)
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
	if !found {
		return // nothing was granted on it
	}
	removed := int64(0)
	if len(live) > 0 {
		removed = s.planCreditOp(ctx, uid, store.EntryPlanCreditRemoval, "pro:"+hash, "", "Pro refunded ("+why+")", "procredit_refund_"+hash)
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

// proCreditSweep looks again at accounts known to hold paid Pro whose next
// month has come (balance sweep, every 10 minutes).
func (s *Service) proCreditSweep(ctx context.Context, now time.Time) int {
	if len(s.rates(ctx).ProCreditCents) == 0 {
		return 0
	}
	uids, err := s.Store.DueProCreditHolders(ctx, now, 50)
	if err != nil {
		return 0
	}
	n := 0
	for _, uid := range uids {
		if s.RevenueCat.Configured() {
			s.RevenueCat.Forget(uid)
		}
		if v := s.ensureProCredit(ctx, uid); v != nil && v.grantedNow {
			n++
		}
	}
	return n
}

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
