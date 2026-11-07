package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Pay links (D7, owner 2026-11-07): every failure mail of a web
// off-session charge links straight to a page that pays that debt
// on-session, where the bank's check can be done. The link is
// SiteURL/pay/{token}; the page reads GET /v1/pay-requests/{token}
// (label, amount, state — nothing about the account) and pays with POST
// /v1/pay-requests/{token}/checkout: a Checkout Session for the live
// amount (Adaptive Pricing per config), or Stripe's hosted invoice page
// for a plan renewal. A token is bound to one account and one debt; the
// client never names an amount; an unknown token and a closed one answer
// alike whoever asks. When the debt is paid another way the link closes.

// Public pay-link calls per IP per minute: reads (the page polls after a
// payment) and payments.
var (
	payReadLimit = &ipLimiter{max: 60, hits: map[string][]time.Time{}}
	payPostLimit = &ipLimiter{max: 5, hits: map[string][]time.Time{}}
)

// ipLimiter allows max calls per IP per minute.
type ipLimiter struct {
	mu   sync.Mutex
	max  int
	hits map[string][]time.Time
}

func (l *ipLimiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	keep := l.hits[ip][:0]
	for _, t := range l.hits[ip] {
		if now.Sub(t) < time.Minute {
			keep = append(keep, t)
		}
	}
	if len(keep) >= l.max {
		l.hits[ip] = keep
		return false
	}
	l.hits[ip] = append(keep, now)
	if len(l.hits) > 10000 {
		for k, v := range l.hits {
			if len(v) == 0 || now.Sub(v[len(v)-1]) > time.Minute {
				delete(l.hits, k)
			}
		}
	}
	return true
}

// payLink returns the pay page for (uid, kind, source) — one per debt,
// made on the first failure — or "" when it can't be made (the mail then
// links to Billing).
func (s *Service) payLink(ctx context.Context, uid, kind, source string, cents int64, label string) (string, *store.PayRequest) {
	p, _, err := s.Store.OpenPayRequest(ctx, uid, kind, source, cents, label)
	if err != nil {
		slog.WarnContext(ctx, "pay link not made", "uid", uid, "kind", kind, "err", err)
		return s.Cfg.SiteURL + "/billing", nil
	}
	return s.payURL(p.ID), p
}

func (s *Service) payURL(token string) string { return s.Cfg.SiteURL + "/pay/" + token }

// payLive is a pay request's live state: what is still owed now
// ("open" with the amount), "paid", "void" or "expired". It closes a
// request whose debt was paid or went in the meantime.
func (s *Service) payLive(ctx context.Context, p *store.PayRequest) (string, int64) {
	now := time.Now().UTC()
	if p.State != store.PayOpen {
		return p.State, p.AmountCents
	}
	if !now.Before(p.ExpiresAt) {
		return "expired", p.AmountCents
	}
	cust, err := s.Store.GetCustomer(ctx, p.UID)
	if err != nil || cust.AccountDeleted || cust.Blocked {
		return "void", p.AmountCents
	}
	switch p.Kind {
	case store.PayKindSettle:
		owed := s.owedCents(ctx, p.UID)
		if owed <= 0 {
			s.closePay(ctx, p, store.PayPaid, "nothing owed")
			return store.PayPaid, p.AmountCents
		}
		return store.PayOpen, owed
	case store.PayKindTopup:
		if p.TopupID != "" {
			if t, terr := s.Store.GetTopup(ctx, p.TopupID); terr == nil && t.State == store.TopupPaid {
				s.closePay(ctx, p, store.PayPaid, "paid")
				return store.PayPaid, p.AmountCents
			}
		}
		return store.PayOpen, p.AmountCents
	case store.PayKindInvoice:
		inv, ierr := s.Stripe.GetInvoice(p.SourceID)
		if ierr != nil {
			return store.PayOpen, p.AmountCents // shown as made; the POST reads again
		}
		switch inv.Status {
		case "paid":
			s.closePay(ctx, p, store.PayPaid, "invoice paid")
			return store.PayPaid, p.AmountCents
		case "void", "uncollectible", "draft":
			s.closePay(ctx, p, store.PayVoid, "invoice "+inv.Status)
			return store.PayVoid, p.AmountCents
		}
		return store.PayOpen, inv.AmountDue
	case store.PayKindStepUp:
		return s.stepUpPayLive(ctx, p, cust)
	}
	return "void", p.AmountCents
}

func (s *Service) closePay(ctx context.Context, p *store.PayRequest, state, reason string) {
	now := time.Now().UTC()
	_, _ = s.Store.UpdatePayRequest(ctx, p.ID, func(x *store.PayRequest) error {
		if x.State == store.PayOpen {
			x.State, x.VoidReason, x.ClosedAt = state, reason, &now
		}
		return nil
	})
	p.State = state
}

// errPayLinkUnknown is every miss alike: no such token, a malformed one.
func errPayLinkUnknown() error {
	return httpx.Err(http.StatusNotFound, "pay_link_not_found", "This payment link isn't valid.")
}

func (s *Service) payRequestFor(w http.ResponseWriter, r *http.Request, lim *ipLimiter) (*store.PayRequest, bool) {
	ctx := r.Context()
	if !lim.allow(clientIP(r), time.Now()) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusTooManyRequests, "rate_limited", "too many tries; wait a minute"))
		return nil, false
	}
	p, err := s.Store.GetPayRequest(ctx, r.PathValue("token"))
	if errors.Is(err, store.ErrNotFound) {
		httpx.WriteErr(ctx, w, errPayLinkUnknown())
		return nil, false
	}
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return nil, false
	}
	return p, true
}

// GET /v1/pay-requests/{token} (public, read-only: a link preview pays
// nothing) → {label, amount_cents, currency: "usd", state: open | paid |
// void | expired}. 404 pay_link_not_found for any token that isn't one.
func (s *Service) HandleGetPayRequest(w http.ResponseWriter, r *http.Request) {
	p, ok := s.payRequestFor(w, r, payReadLimit)
	if !ok {
		return
	}
	state, amount := s.payLive(r.Context(), p)
	httpx.WriteOK(w, map[string]any{"label": p.Label, "amount_cents": amount, "currency": "usd", "state": state})
}

// POST /v1/pay-requests/{token}/checkout (public) {ui?: elements |
// hosted_page, return_url?} → the live debt's payment:
//
//	{checkout: {client_secret, expires_at}, publishable_key, amount_cents, url?}
//	  (a Checkout Session; url with ui hosted_page)
//	{url, amount_cents}       (kind invoice: Stripe's hosted invoice page)
//	{state: "paid"}           (nothing left to pay)
//
// 409 pay_link_closed {state} once paid, void or expired; 409
// payment_in_progress while a payment of it is still being confirmed.
func (s *Service) HandlePayRequestCheckout(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p, ok := s.payRequestFor(w, r, payPostLimit)
	if !ok {
		return
	}
	var req struct {
		UI        string `json:"ui"`
		ReturnURL string `json:"return_url"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req)
	state, amount := s.payLive(ctx, p)
	if state != store.PayOpen {
		e := httpx.Err(http.StatusConflict, "pay_link_closed", "This payment link has closed.")
		e.Details = map[string]any{"state": state}
		httpx.WriteErr(ctx, w, e)
		return
	}
	returnURL := s.payURL(p.ID) + "?done=1"
	if strings.HasPrefix(req.ReturnURL, s.Cfg.SiteURL+"/") {
		returnURL = req.ReturnURL
	}
	ui := "elements"
	if req.UI == "hosted_page" || req.UI == "hosted" {
		ui = "hosted_page"
	}
	pc := payContextOf(r)
	var resp map[string]any
	var err error
	switch p.Kind {
	case store.PayKindTopup:
		resp, err = s.payTopupCheckout(ctx, r, p, amount, ui, returnURL)
	case store.PayKindSettle:
		resp, err = s.paySettleCheckout(ctx, p, pc)
	case store.PayKindInvoice:
		inv, ierr := s.Stripe.GetInvoice(p.SourceID)
		if ierr != nil || inv.HostedInvoiceURL == "" {
			err = httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be opened; try again")
			break
		}
		resp = map[string]any{"url": inv.HostedInvoiceURL, "amount_cents": inv.AmountDue}
	case store.PayKindStepUp:
		resp, err = s.payStepUpCheckout(ctx, p, pc)
	default:
		err = errPayLinkUnknown()
	}
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.WriteOK(w, resp)
}

// payTopupCheckout pays a failed auto-reload's amount into the balance: a
// new top-up (sheet) with its own Checkout Session, as POST
// /v1/billing/balance/topup makes, tied to the link.
func (s *Service) payTopupCheckout(ctx context.Context, r *http.Request, p *store.PayRequest, amount int64, ui, returnURL string) (map[string]any, error) {
	cust, err := s.Store.GetCustomer(ctx, p.UID)
	if err != nil || cust.StripeCustomerID == "" {
		return nil, errPayLinkUnknown()
	}
	if cust.UnderReview || cust.DeletionPending {
		return nil, httpx.Err(http.StatusConflict, "pay_link_unavailable", "This payment can't be made here right now. Contact support.")
	}
	if s.Cfg.StripePMCWeb == "" {
		return nil, errSheetUnavailable()
	}
	if p.TopupID != "" { // the page was opened before: its session if still open
		if t, terr := s.Store.GetTopup(ctx, p.TopupID); terr == nil && t.State == store.TopupOpen && t.CurrentPayment != nil &&
			t.CurrentPayment.ExpiresAt != nil && time.Until(*t.CurrentPayment.ExpiresAt) > 5*time.Minute && t.CurrentPayment.UI == ui {
			return s.topupCheckoutJSON(t, t.CurrentPayment), nil
		}
	}
	t := &store.Topup{ID: "t" + store.NewID(), UID: p.UID, Cents: amount, Currency: "usd", State: store.TopupOpen,
		CustomerID: cust.StripeCustomerID, PayRequestID: p.ID}
	if err := s.Store.CreateTopup(ctx, t); err != nil {
		return nil, err
	}
	sess, serr := s.Stripe.CreateWebSession(stripex.SessionSpec{
		CustomerID: cust.StripeCustomerID, PMC: s.Cfg.StripePMCWeb, UI: ui, AmountCents: t.Cents, Currency: "usd",
		Label: topupLabel(t.Cents), ReturnURL: returnURL, NoWeChat: clientDevice(r) != "computer", SaveMethod: true,
		SavedOnce: s.savedOnceTypes(cust.StripeCustomerID), NoKlarna: len(s.rates(ctx).KlarnaMarkets) == 0, Description: topupLabel(t.Cents),
		Metadata: map[string]string{"kind": "topup", "topup_id": t.ID, "user_id": p.UID, "payment_flow": "topup", "attempt": "1",
			"pay_request": p.ID},
		IdemKey:         fmt.Sprintf("topup_%s_%s_1", s.Cfg.Env, t.ID),
		AdaptivePricing: s.rates(ctx).AdaptivePricingEnabled,
	})
	if serr != nil {
		httpx.Log(ctx).Error("pay link top-up session failed", "topup_id", t.ID, "err", serr)
		return nil, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be opened; try again")
	}
	exp := sess.Expires()
	pay := store.Payment{Kind: store.PaymentCheckoutSession, ID: sess.ID, ExpiresAt: &exp, Attempt: 1, UI: ui,
		ClientSecret: sess.ClientSecret, URL: sess.URL, CreatedAt: time.Now().UTC(), ClientIP: clientIP(r)}
	s.Store.UpdateTopup(ctx, t.ID, func(x *store.Topup) error {
		x.CurrentPayment, x.Payments = &pay, append(x.Payments, pay)
		return nil
	})
	s.Store.UpdatePayRequest(ctx, p.ID, func(x *store.PayRequest) error {
		x.TopupID, x.CheckoutID = t.ID, sess.ID
		return nil
	})
	return s.topupCheckoutJSON(t, &pay), nil
}

func (s *Service) topupCheckoutJSON(t *store.Topup, pay *store.Payment) map[string]any {
	resp := map[string]any{"amount_cents": t.Cents, "publishable_key": s.Stripe.PublishableKey,
		"checkout": map[string]any{"client_secret": pay.ClientSecret, "expires_at": pay.ExpiresAt.Format(time.RFC3339)}}
	if pay.UI == "hosted_page" && pay.URL != "" {
		resp["url"] = pay.URL
	}
	return resp
}

// paySettleCheckout pays everything the account owes (deletion dues): the
// settle sheet ("Your last runs").
func (s *Service) paySettleCheckout(ctx context.Context, p *store.PayRequest, pc payContext) (map[string]any, error) {
	res, err := s.collectOutstanding(ctx, p.UID, settleSheet, pc)
	if err != nil {
		var api *httpx.APIError
		if errors.As(err, &api) {
			return nil, err
		}
		httpx.Log(ctx).Error("pay link settle failed", "err", err)
		return nil, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be opened; try again")
	}
	if res.Nothing || res.Paid {
		s.closePay(ctx, p, store.PayPaid, "paid")
		return map[string]any{"state": store.PayPaid}, nil
	}
	cp := res.Settle.CurrentPayment
	if cp == nil || cp.Kind != store.PaymentCheckoutSession || cp.ClientSecret == "" || cp.ExpiresAt == nil {
		return nil, httpx.Err(http.StatusConflict, "payment_in_progress", "A payment of this is being confirmed. Check back in a few minutes.")
	}
	s.Store.UpdatePayRequest(ctx, p.ID, func(x *store.PayRequest) error {
		x.CheckoutID = cp.ID
		return nil
	})
	return map[string]any{"amount_cents": res.Settle.AmountCents, "publishable_key": s.Stripe.PublishableKey,
		"checkout": map[string]any{"client_secret": cp.ClientSecret, "expires_at": cp.ExpiresAt.Format(time.RFC3339)}}, nil
}

// payRequestsAfterTopup closes links a paid top-up settles: the one it was
// opened from, and a failed auto-reload's once any auto-reload pays.
func (s *Service) payRequestsAfterTopup(ctx context.Context, t *store.Topup) {
	if t.PayRequestID != "" {
		if p, err := s.Store.GetPayRequest(ctx, t.PayRequestID); err == nil {
			s.closePay(ctx, p, store.PayPaid, "paid")
		}
	}
	if t.Auto {
		_, _ = s.Store.ClosePayRequests(ctx, t.UID, store.PayKindTopup, "", store.PayVoid, "auto-reload paid")
	}
}

// payRequestsAfterSettle closes the dues links once nothing is owed.
func (s *Service) payRequestsAfterSettle(ctx context.Context, uid string) {
	if s.owedCents(ctx, uid) <= 0 {
		_, _ = s.Store.ClosePayRequests(ctx, uid, store.PayKindSettle, "", store.PayPaid, "nothing owed")
	}
}

// payRequestJSON is one link for admin (the token itself only shortened).
func payRequestJSON(p *store.PayRequest) map[string]any {
	out := map[string]any{"token_prefix": p.ID[:min(len(p.ID), 10)], "uid": p.UID, "kind": p.Kind, "source_id": p.SourceID,
		"amount_cents": p.AmountCents, "label": p.Label, "state": p.State, "created_at": p.CreatedAt.Format(time.RFC3339),
		"expires_at": p.ExpiresAt.Format(time.RFC3339)}
	if p.State == store.PayOpen && !time.Now().Before(p.ExpiresAt) {
		out["state"] = "expired"
	}
	if p.VoidReason != "" {
		out["closed_reason"] = p.VoidReason
	}
	if p.ClosedAt != nil {
		out["closed_at"] = p.ClosedAt.Format(time.RFC3339)
	}
	return out
}

// GET /v1/admin/pay-requests?state=open|paid|void&uid= → {pay_requests: [...]}.
func (s *Service) HandleAdminPayRequests(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	state := r.URL.Query().Get("state")
	if state == "" {
		state = store.PayOpen
	}
	list, err := s.Store.ListPayRequests(ctx, r.URL.Query().Get("uid"), state, 200)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	rows := []map[string]any{}
	for _, p := range list {
		rows = append(rows, payRequestJSON(p))
	}
	httpx.WriteOK(w, map[string]any{"pay_requests": rows})
}

// adminPayRequests is an account's links for the account view.
func (s *Service) adminPayRequests(ctx context.Context, uid string) []map[string]any {
	rows := []map[string]any{}
	if list, err := s.Store.ListPayRequests(ctx, uid, "", 50); err == nil {
		for _, p := range list {
			rows = append(rows, payRequestJSON(p))
		}
	}
	return rows
}
