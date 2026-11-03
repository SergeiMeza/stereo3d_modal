package api

import (
	"context"
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Pay on another device (spec v6 B17): the headset hands its payment to a
// phone or computer. The headset's open session is expired first (E0-1), a
// code — 8 Crockford base32 characters, one per run, living as long as the
// run — opens a page that only SHOWS the payment (a GET creates nothing,
// so link previews are harmless); "Continue to payment" (a POST) makes the
// run's current object a Stripe-hosted session (or, in China mode, an
// Alipay PaymentIntent). 5 tries per IP per minute on the public routes.

const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

func newHandoffCode() string {
	var b [8]byte
	_, _ = rand.Read(b[:])
	out := make([]byte, 8)
	for i, v := range b {
		out[i] = crockford[int(v)%32]
	}
	return string(out)
}

// normalizeCode reads a typed or linked code: case-insensitive, dashes and
// spaces ignored, O→0, I/L→1 (Crockford).
func normalizeCode(raw string) string {
	r := strings.NewReplacer("-", "", " ", "", "O", "0", "I", "1", "L", "1")
	return r.Replace(strings.ToUpper(strings.TrimSpace(raw)))
}

func displayCode(code string) string {
	if len(code) != 8 {
		return code
	}
	return code[:4] + "-" + code[4:]
}

// handoffLimiter: at most 5 public hand-off calls per IP per minute.
type handoffLimiter struct {
	mu   sync.Mutex
	hits map[string][]time.Time
}

var publicHandoffLimit = &handoffLimiter{hits: map[string][]time.Time{}}

func (l *handoffLimiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	keep := l.hits[ip][:0]
	for _, t := range l.hits[ip] {
		if now.Sub(t) < time.Minute {
			keep = append(keep, t)
		}
	}
	if len(keep) >= 5 {
		l.hits[ip] = keep
		return false
	}
	l.hits[ip] = append(keep, now)
	if len(l.hits) > 10000 { // bound memory: forget everyone idle
		for k, v := range l.hits {
			if len(v) == 0 || now.Sub(v[len(v)-1]) > time.Minute {
				delete(l.hits, k)
			}
		}
	}
	return true
}

func (s *Service) handoffURL(code string) string {
	return s.Cfg.SiteURL + "/p/" + displayCode(code)
}

// POST /v1/conversions/{id}/handoff {email?: true} → {code, url,
// expires_at, email_masked?}. Expires the headset's session; one code per
// run; email mails the link (E7).
func (s *Service) HandleCreateHandoff(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	var req struct {
		Email bool `json:"email"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	conv, err := s.Store.GetConversion(ctx, id)
	if err != nil || conv.UID != user.UID || s.projectGone(ctx, conv, nil) {
		httpx.WriteErr(ctx, w, httpx.ErrNotFound("conversion"))
		return
	}
	if err := runPayable(conv); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	// The headset can no longer pay (E0-1): close its object; a paid one
	// means it's paid.
	if conv.CurrentPayment != nil {
		out, cerr := s.closePayment(conv.CurrentPayment)
		if cerr != nil {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't hand the payment over; try again"))
			return
		}
		if out.Paid || out.Processing {
			if _, aerr := s.applyRunPayment(ctx, conv.ID, *conv.CurrentPayment, out); aerr == nil {
				httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "already_paid", "this is already paid"))
				return
			}
		}
	}
	code := conv.HandoffCode
	if code == "" {
		for i := 0; i < 5 && code == ""; i++ {
			c := newHandoffCode()
			if cerr := s.Store.CreateHandoff(ctx, &store.Handoff{Code: c, ConversionID: conv.ID, UID: user.UID, Email: user.Email, State: "waiting"}); cerr == nil {
				code = c
			} else if !errors.Is(cerr, store.ErrAlreadyExists) {
				httpx.WriteErr(ctx, w, cerr)
				return
			}
		}
	} else {
		s.Store.SetHandoffState(ctx, code, "waiting")
	}
	now := time.Now().UTC()
	expiry := now.Add(noObjectHold)
	oldID := ""
	if conv.CurrentPayment != nil {
		oldID = conv.CurrentPayment.ID
	}
	updated, err := s.Store.Transition(ctx, conv.ID, []string{store.StateCreated}, func(c *store.Conversion) error {
		cur := ""
		if c.CurrentPayment != nil {
			cur = c.CurrentPayment.ID
		}
		if cur != oldID || c.Stripe.PIStatus == store.PISucceeded {
			return store.ErrStateConflict
		}
		c.HandoffCode, c.CurrentPayment, c.ExpiresAt = code, nil, &expiry // a hand-off with no session: 30 min (E0-3)
		return nil
	})
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "payment_moved", "the payment changed; try again"))
		return
	}
	resp := map[string]any{"code": displayCode(code), "url": s.handoffURL(code), "expires_at": updated.ExpiresAt.Format(time.RFC3339),
		"amount_cents": updated.Quote.AmountCents}
	if req.Email && user.Email != "" {
		s.mailHandoff(ctx, fmt.Sprintf("E7_%s_%d", code, now.Unix()/60), user.UID, user.Email, s.handoffURL(code), updated.Quote.AmountCents)
		resp["email_masked"] = maskEmail(user.Email)
	}
	httpx.WriteOK(w, resp)
}

// handoffRun resolves a public code to its run.
func (s *Service) handoffRun(ctx context.Context, w http.ResponseWriter, r *http.Request, raw string) (*store.Handoff, *store.Conversion, bool) {
	if !publicHandoffLimit.allow(clientIP(r), time.Now()) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusTooManyRequests, "too_many_tries", "too many tries; wait a minute"))
		return nil, nil, false
	}
	h, err := s.Store.GetHandoff(ctx, normalizeCode(raw))
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusNotFound, "bad_link", "this link didn't work; check it and try again"))
		return nil, nil, false
	}
	conv, err := s.Store.GetConversion(ctx, h.ConversionID)
	if err != nil || conv.HandoffCode != h.Code {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusNotFound, "bad_link", "this link didn't work; check it and try again"))
		return nil, nil, false
	}
	return h, conv, true
}

func handoffState(h *store.Handoff, c *store.Conversion) string {
	switch {
	case c.State == store.StateCreated && c.Stripe.PIStatus == store.PIProcessing:
		return "confirming"
	case c.State == store.StateCreated:
		if h.State == "paying" {
			return "paying"
		}
		return "waiting"
	case c.State == store.StateExpired || c.State == store.StateCanceled:
		return "expired"
	}
	return "paid"
}

// GET /v1/handoff/{code} (public, read-only) → {label, amount_cents,
// currency, email_masked, china, expires_at, state}.
func (s *Service) HandleGetHandoff(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	h, conv, ok := s.handoffRun(ctx, w, r, r.PathValue("code"))
	if !ok {
		return
	}
	resp := map[string]any{
		"label": s.runLabel(ctx, conv), "amount_cents": conv.Quote.AmountCents, "currency": conv.Quote.Currency,
		"email_masked": maskEmail(h.Email), "china": conv.PaymentFlow == store.FlowChina, "state": handoffState(h, conv),
	}
	if conv.ExpiresAt != nil {
		resp["expires_at"] = conv.ExpiresAt.Format(time.RFC3339)
	}
	httpx.WriteOK(w, resp)
}

// POST /v1/handoff/{code}/pay (public) {return_url?, method?} — outside
// China: the run's current object becomes a hosted session → {url};
// China: {method: alipay} → {next_action}. Restarts the run's clock.
func (s *Service) HandleHandoffPay(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	h, conv, ok := s.handoffRun(ctx, w, r, r.PathValue("code"))
	if !ok {
		return
	}
	var req struct {
		ReturnURL string `json:"return_url"`
		Method    string `json:"method"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if err := runPayable(conv); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	returnURL := s.handoffURL(h.Code) + "?back=1"
	if strings.HasPrefix(req.ReturnURL, s.Cfg.SiteURL+"/") {
		returnURL = req.ReturnURL // only our own pages
	}
	if conv.PaymentFlow == store.FlowChina || req.Method != "" {
		if req.Method != "alipay" {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "method_unavailable", "this payment method isn't available yet"))
			return
		}
		_, redirect, err := s.openAlipay(ctx, conv, returnURL, h.Email)
		if err != nil {
			s.writePayOpenErr(ctx, w, conv.ID, err)
			return
		}
		s.Store.SetHandoffState(ctx, h.Code, "paying")
		httpx.WriteOK(w, map[string]any{"next_action": map[string]any{"type": "redirect", "redirect_url": redirect}})
		return
	}
	updated, err := s.openRunSessionTo(ctx, conv, "hosted_page", clientDevice(r), clientIP(r), h.Email, returnURL)
	if err != nil {
		s.writePayOpenErr(ctx, w, conv.ID, err)
		return
	}
	s.Store.SetHandoffState(ctx, h.Code, "paying")
	httpx.WriteOK(w, map[string]any{"url": updated.CurrentPayment.URL})
}

func (s *Service) writePayOpenErr(ctx context.Context, w http.ResponseWriter, convID string, err error) {
	if errors.Is(err, errAlreadyPaid) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "already_paid", "this is already paid"))
		return
	}
	var apiErr *httpx.APIError
	if errors.As(err, &apiErr) {
		httpx.WriteErr(ctx, w, apiErr)
		return
	}
	httpx.Log(ctx).Error("hand-off payment failed", "conversion_id", convID, "err", err)
	httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be opened; try again"))
}
