package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Checkout Sessions for every on-session payment (spec v6 D1): our sheet
// hosts ui_mode=elements, the hand-off link a hosted_page. One session per
// run at a time (E0-1), keyed run_{env}_{conversion_id}_{attempt}.

// consentTextVersion names the save/reuse text the sheet shows (C3); the
// record of each save carries it.
const consentTextVersion = "save-v1-2026-11"

// clientDevice: phone | computer | headset (X-Client-Device; default
// computer). WeChat Pay is offered on computers only (B16).
func clientDevice(r *http.Request) string {
	if r == nil {
		return "computer"
	}
	switch d := strings.ToLower(strings.TrimSpace(r.Header.Get("X-Client-Device"))); d {
	case "phone", "headset":
		return d
	}
	return "computer"
}

// clientIP is the caller's address (the load balancer's X-Forwarded-For
// first hop; the relay's X-Client-IP when present).
func clientIP(r *http.Request) string {
	if r == nil {
		return ""
	}
	if ip := strings.TrimSpace(r.Header.Get("X-Client-IP")); ip != "" && net.ParseIP(ip) != nil {
		return ip
	}
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		first := strings.TrimSpace(strings.Split(xff, ",")[0])
		if net.ParseIP(first) != nil {
			return first
		}
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err == nil {
		return host
	}
	return ""
}

// runLabel is the sheet's line item: "{project} · {what} · {quality}".
func (s *Service) runLabel(ctx context.Context, c *store.Conversion) string {
	what := jobDescription(c)
	parts := []string{}
	if c.ProjectID != "" {
		if p, err := s.Store.GetProject(ctx, c.ProjectID); err == nil && strings.TrimSpace(p.Name) != "" {
			parts = append(parts, strings.TrimSpace(p.Name))
		}
	}
	parts = append(parts, what)
	if l := resolutionLabel(c, nil); l != "" {
		parts = append(parts, l)
	}
	return strings.Join(parts, " · ")
}

// errSheetUnavailable: no web payment-method configuration in this env.
func errSheetUnavailable() error {
	return httpx.Err(http.StatusServiceUnavailable, "payment_unavailable", "payment isn't available right now; try again later")
}

// openRunSession makes the run's current payment a fresh Checkout Session
// (E0-1 replace): the first sheet, Try again, Pay here instead, the
// hand-off's Continue to payment. ui is elements or hosted_page.
func (s *Service) openRunSession(ctx context.Context, conv *store.Conversion, ui, device, ip, email string) (*store.Conversion, error) {
	return s.openRunSessionTo(ctx, conv, ui, device, ip, email, "")
}

// openRunSessionTo is openRunSession with an explicit return URL ("" =
// the return page).
func (s *Service) openRunSessionTo(ctx context.Context, conv *store.Conversion, ui, device, ip, email, returnURL string) (*store.Conversion, error) {
	if s.Cfg.StripePMCWeb == "" {
		return conv, errSheetUnavailable()
	}
	label := s.runLabel(ctx, conv)
	if returnURL == "" {
		returnURL = s.Cfg.SiteURL + "/pay/return?c=" + conv.ID
	}
	return s.replaceRunPayment(ctx, conv, func(attempt int) (*store.Payment, error) {
		sess, err := s.Stripe.CreateWebSession(stripex.SessionSpec{
			CustomerID: conv.Stripe.CustomerID, PMC: s.Cfg.StripePMCWeb, UI: ui,
			AmountCents: conv.Quote.AmountCents, Currency: conv.Quote.Currency, Label: label,
			ReturnURL: returnURL, NoWeChat: device != "computer", SaveMethod: true,
			NoKlarna:     len(s.rates(ctx).KlarnaMarkets) == 0, // per-market offer comes with local prices
			ReceiptEmail: email, Description: jobDescription(conv),
			Metadata: map[string]string{
				"kind": "run", "conversion_id": conv.ID, "user_id": conv.UID,
				"payment_flow": store.FlowPayNow, "attempt": fmt.Sprint(attempt),
			},
			IdemKey: fmt.Sprintf("run_%s_%s_%d", s.Cfg.Env, conv.ID, attempt),
		})
		if err != nil {
			return nil, err
		}
		exp := sess.Expires()
		return &store.Payment{Kind: store.PaymentCheckoutSession, ID: sess.ID, ExpiresAt: &exp, Attempt: attempt,
			UI: ui, ClientSecret: sess.ClientSecret, URL: sess.URL, CreatedAt: time.Now().UTC(), ClientIP: ip}, nil
	})
}

// payNowBilling is the billing block of a run waiting in the sheet:
// requires_payment with why and the open session's client secret, or
// waiting_for_payment while an async payment settles.
func payNowBilling(c *store.Conversion) map[string]any {
	if c.State != store.StateCreated || (c.PaymentFlow != store.FlowPayNow && c.PaymentFlow != store.FlowChina) {
		return nil
	}
	if c.Stripe.PIStatus == store.PIProcessing {
		return map[string]any{"status": "waiting_for_payment"}
	}
	b := map[string]any{"status": "requires_payment", "reason": payReasonOrDefault(c.PayReason)}
	if c.DeclinedMethodLabel != "" {
		b["declined_method_label"] = c.DeclinedMethodLabel // "Your Visa •••• 4242 was declined."
	}
	if cp := c.CurrentPayment; cp != nil && cp.Kind == store.PaymentCheckoutSession && cp.UI == "elements" && cp.ClientSecret != "" {
		checkout := map[string]any{"client_secret": cp.ClientSecret}
		if cp.ExpiresAt != nil {
			checkout["expires_at"] = cp.ExpiresAt.Format(time.RFC3339)
		}
		b["checkout"] = checkout
	}
	if c.ExpiresAt != nil {
		b["expires_at"] = c.ExpiresAt.Format(time.RFC3339)
	}
	return b
}

func payReasonOrDefault(r string) string {
	if r == "" {
		return "no_method"
	}
	return r
}

// POST /v1/conversions/{id}/pay-now {ui: "elements", replace?: bool} — the
// sheet for a run waiting for its payment: the open current session, or a
// fresh one when replace (Try again, Pay here instead; "retry" is
// accepted too) or when the current one is closed. Answers the run plus
// {checkout {client_secret, expires_at}, amount_cents, publishable_key}.
// 409 already_paid / expired / payment_in_progress past "created".
func (s *Service) HandleRunPayNow(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	var req struct {
		UI      string `json:"ui"`
		Retry   bool   `json:"retry"`
		Replace bool   `json:"replace"`
		Method  string `json:"method"` // alipay | wechat_pay (China mode)
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	req.Retry = req.Retry || req.Replace
	conv, err := s.Store.GetConversion(ctx, id)
	if err != nil || conv.UID != user.UID || s.projectGone(ctx, conv, nil) {
		httpx.WriteErr(ctx, w, httpx.ErrNotFound("conversion"))
		return
	}
	if req.Method != "" {
		s.handleChinaPay(ctx, w, r, user, conv, req.Method)
		return
	}
	if err := runPayable(conv); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if cp := conv.CurrentPayment; cp != nil && !req.Retry && cp.Kind == store.PaymentCheckoutSession && cp.UI == "elements" {
		out, sess, gerr := s.Stripe.SessionOutcome(cp.ID)
		if gerr == nil && sess.Status == "open" {
			httpx.WriteOK(w, s.payNowResponse(conv))
			return
		}
		if gerr == nil && (out.Paid || out.Processing) {
			if paid, aerr := s.applyRunPayment(ctx, conv.ID, *cp, out); aerr == nil {
				conv = paid
			}
			if err := runPayable(conv); err != nil {
				httpx.WriteErr(ctx, w, err)
				return
			}
		}
	}
	updated, err := s.openRunSession(ctx, conv, "elements", clientDevice(r), clientIP(r), user.Email)
	if errors.Is(err, errAlreadyPaid) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "already_paid", "this is already paid"))
		return
	}
	if err != nil {
		var apiErr *httpx.APIError
		if errors.As(err, &apiErr) {
			httpx.WriteErr(ctx, w, apiErr)
			return
		}
		httpx.Log(ctx).Error("pay-now session failed", "conversion_id", id, "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be opened; try again"))
		return
	}
	httpx.WriteOK(w, s.payNowResponse(updated))
}

// payNowResponse is the run plus the sheet's top-level fields (the web's
// shape): checkout, amount_cents, publishable_key.
func (s *Service) payNowResponse(c *store.Conversion) map[string]any {
	resp := s.conversionResponse(c, nil)
	resp["amount_cents"] = c.Quote.AmountCents
	resp["publishable_key"] = s.Stripe.PublishableKey
	if b, ok := resp["billing"].(map[string]any); ok {
		if ch, ok := b["checkout"]; ok {
			resp["checkout"] = ch
		}
	}
	return resp
}

// runPayable: only a created run waiting in the sheet can be paid.
func runPayable(c *store.Conversion) error {
	switch {
	case c.State == store.StateCreated && c.Stripe.PIStatus == store.PIProcessing:
		return httpx.Err(http.StatusConflict, "payment_in_progress", "your payment is being confirmed")
	case c.State == store.StateCreated && (c.PaymentFlow == store.FlowPayNow || c.PaymentFlow == store.FlowChina):
		return nil
	case c.State == store.StateExpired || c.State == store.StateCanceled:
		return httpx.Err(http.StatusConflict, "expired", "this payment expired; start again when you're ready")
	case c.State == store.StateCreated:
		return httpx.Err(http.StatusConflict, "not_payable", "this run isn't waiting for a payment")
	}
	return httpx.Err(http.StatusConflict, "already_paid", "this is already paid")
}

// --------------------------------------------------------------- D3

// handleCheckoutEvent applies checkout.session.* events (D3): completed /
// async_payment_succeeded → the run is paid (or waits while an async
// payment settles), and a method saved with it is recorded; expired /
// async_payment_failed on the CURRENT session → the run expires, not
// charged. Setup sessions (Billing → add a method) record the method.
func (s *Service) handleCheckoutEvent(ctx context.Context, eventType string, raw json.RawMessage) error {
	var sess struct {
		ID            string            `json:"id"`
		Mode          string            `json:"mode"`
		Status        string            `json:"status"`
		PaymentStatus string            `json:"payment_status"`
		Customer      string            `json:"customer"`
		Metadata      map[string]string `json:"metadata"`
	}
	if err := json.Unmarshal(raw, &sess); err != nil {
		return nil
	}
	if sess.Metadata["env"] != s.Cfg.Env || sess.Metadata["product"] != "svs-web" {
		return nil // another product's session on the shared account
	}
	switch sess.Metadata["kind"] {
	case "setup":
		if eventType == "checkout.session.completed" {
			return s.applySetupSession(ctx, sess.ID, sess.Metadata["user_id"], sess.Customer)
		}
		return nil
	case "settle":
		return s.applySettleSessionEvent(ctx, eventType, sess.ID, sess.Metadata["settle_id"])
	case "run":
	default:
		return nil
	}
	convID := sess.Metadata["conversion_id"]
	conv, err := s.Store.GetConversion(ctx, convID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	payment := store.Payment{Kind: store.PaymentCheckoutSession, ID: sess.ID}
	for _, p := range conv.Payments {
		if p.ID == sess.ID {
			payment = p
		}
	}
	switch eventType {
	case "checkout.session.completed", "checkout.session.async_payment_succeeded":
		out, _, oerr := s.Stripe.SessionOutcome(sess.ID)
		if oerr != nil {
			return oerr
		}
		updated, aerr := s.applyRunPayment(ctx, convID, payment, out)
		if aerr != nil {
			return aerr
		}
		if out.Paid && updated != nil && updated.Stripe.PaymentIntentID == out.PaymentIntentID {
			s.recordSavedMethod(ctx, updated, out.PaymentMethod, payment, updated.PayReason != "no_method")
		}
	case "checkout.session.expired", "checkout.session.async_payment_failed":
		if conv.State != store.StateCreated || conv.CurrentPayment == nil || conv.CurrentPayment.ID != sess.ID {
			return nil // not current: a replaced session ending is expected
		}
		now := time.Now().UTC()
		expired, terr := s.Store.Transition(ctx, convID, []string{store.StateCreated}, func(c *store.Conversion) error {
			if c.CurrentPayment == nil || c.CurrentPayment.ID != sess.ID || c.Stripe.PIStatus == store.PISucceeded {
				return store.ErrStateConflict
			}
			c.State = store.StateExpired
			c.Stripe.PIStatus = store.PICanceled
			c.Stripe.CanceledAt = &now
			return nil
		})
		if terr == nil {
			s.restoreCredit(ctx, expired)
		}
	}
	return nil
}

// recordSavedMethod is D3 step 4–5 for a method saved with a payment: the
// consent record, allow_redisplay=always, the default (when the customer
// has none, or always after a bank check / decline sheet, P3), the account
// facts, and the tax location evidence.
func (s *Service) recordSavedMethod(ctx context.Context, conv *store.Conversion, pm string, payment store.Payment, forceDefault bool) {
	if pm == "" {
		return
	}
	owner, typ, err := s.Stripe.MethodOwner(pm)
	if err != nil || owner == "" || owner != conv.Stripe.CustomerID || !stripex.ReusableTypes[typ] {
		return // not saved (Alipay, WeChat Pay) or not this customer's
	}
	s.saveMethodFacts(ctx, conv.UID, conv.Stripe.CustomerID, pm, payment.ID, payment.ClientIP, forceDefault, true)
}

// saveMethodFacts records a newly saved method: consent, redisplay,
// default, account facts (paid → credit), tax IP.
func (s *Service) saveMethodFacts(ctx context.Context, uid, customerID, pm, sessionID, ip string, forceDefault, paid bool) {
	if err := s.Store.RecordConsent(ctx, store.Consent{UID: uid, PaymentMethod: pm, TextVersion: consentTextVersion,
		SessionID: sessionID, IP: ip, At: time.Now().UTC()}); err != nil {
		slog.WarnContext(ctx, "consent not recorded", "uid", uid, "err", err)
	}
	if err := s.Stripe.SetAllowRedisplay(pm); err != nil {
		slog.WarnContext(ctx, "allow_redisplay not set", "uid", uid, "err", err)
	}
	cust, _ := s.Store.GetCustomer(ctx, uid)
	if forceDefault || cust == nil || cust.DefaultPaymentMethod == "" {
		if err := s.Stripe.SetDefaultMethod(customerID, pm); err != nil {
			slog.WarnContext(ctx, "default not set", "uid", uid, "err", err)
		} else {
			cardRefreshedAt.Delete(uid)
			s.refreshCardCache(ctx, uid, customerID)
		}
	}
	if paid {
		s.noteMethodPaid(ctx, uid, pm)
	}
	if err := s.Stripe.SetTaxIP(customerID, ip); err != nil {
		slog.WarnContext(ctx, "tax ip not set", "uid", uid, "err", err)
	}
}

// handleChinaPay is the China path (pay-now {method, return_url}, B7): a
// server-side Alipay PaymentIntent replaces the run's payment object
// (E0-1); the answer carries next_action {type: redirect, redirect_url}
// so no Stripe domain loads in the browser before Alipay's page. WeChat
// Pay is held back: this account doesn't offer it in USD (BL-20).
func (s *Service) handleChinaPay(ctx context.Context, w http.ResponseWriter, r *http.Request, user *AuthedUser, conv *store.Conversion, method string) {
	if err := runPayable(conv); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if method != "alipay" {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "method_unavailable", "this payment method isn't available yet"))
		return
	}
	updated, redirect, err := s.openAlipay(ctx, conv, s.Cfg.SiteURL+"/pay/return?c="+conv.ID, user.Email)
	if errors.Is(err, errAlreadyPaid) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "already_paid", "this is already paid"))
		return
	}
	if err != nil {
		httpx.Log(ctx).Error("alipay payment failed", "conversion_id", conv.ID, "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be opened; try again"))
		return
	}
	resp := s.payNowResponse(updated)
	resp["next_action"] = map[string]any{"type": "redirect", "redirect_url": redirect}
	httpx.WriteOK(w, resp)
}

// openAlipay makes the run's current payment a server-side Alipay
// PaymentIntent (30-min clock, E0-3).
func (s *Service) openAlipay(ctx context.Context, conv *store.Conversion, returnURL, email string) (*store.Conversion, string, error) {
	redirect := ""
	updated, err := s.replaceRunPayment(ctx, conv, func(attempt int) (*store.Payment, error) {
		pi, url, perr := s.Stripe.CreateAlipayPayment(conv.Stripe.CustomerID, conv.Quote.AmountCents, conv.Quote.Currency,
			returnURL, attempt, stripex.Job{Web: true, ConversionID: conv.ID, UID: conv.UID,
				Description: jobDescription(conv), ReceiptEmail: email, Metadata: jobMetadataFromConversion(conv)})
		if perr != nil {
			return nil, perr
		}
		redirect = url
		exp := time.Now().UTC().Add(noObjectHold)
		return &store.Payment{Kind: store.PaymentIntentKind, ID: pi.ID, ExpiresAt: &exp, Attempt: attempt, URL: url, CreatedAt: time.Now().UTC()}, nil
	})
	return updated, redirect, err
}

// applySettleSessionEvent: a settle's Checkout Session completed (paid or
// processing) or ended (expired / async failed — the settle releases at
// its lease, resolving the session first).
func (s *Service) applySettleSessionEvent(ctx context.Context, eventType, sessionID, settleID string) error {
	st, err := s.Store.GetSettle(ctx, settleID)
	if errors.Is(err, store.ErrNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	payment := store.Payment{Kind: store.PaymentCheckoutSession, ID: sessionID}
	for _, p := range st.Payments {
		if p.ID == sessionID {
			payment = p
		}
	}
	switch eventType {
	case "checkout.session.completed", "checkout.session.async_payment_succeeded":
		out, _, oerr := s.Stripe.SessionOutcome(sessionID)
		if oerr != nil {
			return oerr
		}
		_, aerr := s.applySettlePayment(ctx, settleID, payment, out)
		return aerr
	case "checkout.session.expired", "checkout.session.async_payment_failed":
		if st.State == store.SettleSettling && st.CurrentPayment != nil && st.CurrentPayment.ID == sessionID {
			_, ferr := s.Store.FinishSettle(ctx, settleID, store.SettleOutcome{}, nil)
			if errors.Is(ferr, store.ErrStateConflict) {
				return nil
			}
			return ferr
		}
	}
	return nil
}
