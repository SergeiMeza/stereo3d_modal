package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Our own Billing (spec v6.2 D4, BL-12): the web never uses the Stripe
// customer portal. Methods are listed in the customer's backup order with
// the default first; adding goes through a Checkout setup session; the
// last method can't be removed while anything is owed, a group is open, a
// settle is live or a run is charging (C5).

const (
	maxSavedMethods     = 5
	maxMethodAddsPerDay = 3
)

// methodLabel is how a method reads on screen: "Visa •••• 4242",
// "Apple Pay · Visa •••• 4242", "PayPal · j•••@gmail.com", "Link".
func methodLabel(m *stripex.CardInfo) string {
	if m == nil {
		return ""
	}
	switch m.Type {
	case "paypal":
		return strings.TrimSuffix("PayPal · "+maskEmail(m.Email), " · ")
	case "link":
		return strings.TrimSuffix("Link · "+maskEmail(m.Email), " · ")
	case "alipay":
		return "Alipay"
	case "wechat_pay":
		return "WeChat Pay"
	case "klarna":
		return "Klarna"
	}
	card := strings.TrimSpace(brandName(m.Brand) + " •••• " + m.Last4)
	switch m.Wallet {
	case "apple_pay":
		return "Apple Pay · " + card
	case "google_pay":
		return "Google Pay · " + card
	}
	return card
}

func brandName(b string) string {
	switch b {
	case "visa":
		return "Visa"
	case "mastercard":
		return "Mastercard"
	case "amex":
		return "American Express"
	case "jcb":
		return "JCB"
	case "discover":
		return "Discover"
	case "unionpay":
		return "UnionPay"
	case "":
		return "Card"
	}
	return strings.ToUpper(b[:1]) + b[1:]
}

// maskEmail: "jane@gmail.com" → "j•••@gmail.com".
func maskEmail(e string) string {
	at := strings.Index(e, "@")
	if at <= 0 {
		return ""
	}
	return e[:1] + "•••" + e[at:]
}

// orderMethods sorts saved methods into the customer's backup order: the
// default first, then backup_order, then the rest in the order added.
func orderMethods(methods []*stripex.CardInfo, defaultID string, order []string) []*stripex.CardInfo {
	rank := func(m *stripex.CardInfo) int {
		if m.PaymentMethodID == defaultID {
			return -1
		}
		if i := slices.Index(order, m.PaymentMethodID); i >= 0 {
			return i
		}
		return len(order)
	}
	out := slices.Clone(methods)
	slices.SortStableFunc(out, func(a, b *stripex.CardInfo) int {
		if ra, rb := rank(a), rank(b); ra != rb {
			return ra - rb
		}
		return int(a.Created - b.Created)
	})
	return out
}

// removeBlocked says why the last method can't go (C5), "" when it can.
func (s *Service) removeBlocked(ctx context.Context, uid string, methodsLeft int) string {
	if methodsLeft > 1 {
		return ""
	}
	if owed, _ := s.Store.ListUserByPIStatus(ctx, uid, store.PIChargeFailed, 1); len(owed) > 0 {
		return "payment_pending"
	}
	for _, st := range []string{store.BatchFailed, store.BatchCharging} {
		if b, _ := s.Store.ListUserBatchesByState(ctx, uid, st, 1); len(b) > 0 {
			return "payment_pending"
		}
	}
	if open, _ := s.Store.OpenBatchFor(ctx, uid); open != nil {
		return "payment_pending"
	}
	if charging, _ := s.Store.ListUserByPIStatus(ctx, uid, store.PICharging, 1); len(charging) > 0 {
		return "payment_pending"
	}
	return ""
}

// GET /v1/billing/methods → {methods: [...], max: 5}, in backup order.
func (s *Service) HandleListMethods(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	cust := s.refreshCardCache(ctx, user.UID, customerID)
	methods, err := s.Stripe.ListMethods(customerID)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't load your payment methods; try again"))
		return
	}
	ordered := orderMethods(methods, cust.DefaultPaymentMethod, cust.BackupOrder)
	blocked := s.removeBlocked(ctx, user.UID, len(ordered))
	now := time.Now()
	out := make([]map[string]any, 0, len(ordered))
	for _, m := range ordered {
		e := map[string]any{
			"id": m.PaymentMethodID, "type": m.Type, "label": methodLabel(m),
			"is_default": m.PaymentMethodID == cust.DefaultPaymentMethod,
			"added_at":   time.Unix(m.Created, 0).UTC().Format(time.RFC3339),
			"removable":  blocked == "",
		}
		for k, v := range map[string]string{"wallet": m.Wallet, "brand": m.Brand, "last4": m.Last4, "email": maskEmail(m.Email)} {
			if v != "" {
				e[k] = v
			}
		}
		if m.ExpYear > 0 {
			e["exp_month"], e["exp_year"] = m.ExpMonth, m.ExpYear
			if m.ExpYear < int64(now.Year()) || (m.ExpYear == int64(now.Year()) && m.ExpMonth < int64(now.Month())) {
				e["expired"] = true
			}
		}
		if blocked != "" {
			e["remove_blocked_reason"] = blocked
		}
		out = append(out, e)
	}
	httpx.WriteOK(w, map[string]any{"methods": out, "max": maxSavedMethods})
}

// POST /v1/billing/methods/setup {make_default?} → {checkout {client_secret, expires_at}}:
// a Checkout setup session (P15). 409 too_many_methods at 5; at most 3
// adds a day (429 too_many_adds).
func (s *Service) HandleSetupMethod(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	if s.Cfg.StripePMCWeb == "" {
		httpx.WriteErr(ctx, w, errSheetUnavailable())
		return
	}
	var req struct {
		MakeDefault bool `json:"make_default"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if methods, lerr := s.Stripe.ListMethods(customerID); lerr == nil && len(methods) >= maxSavedMethods {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "too_many_methods", "you can save up to 5 payment methods"))
		return
	}
	day := time.Now().UTC().Format("2006-01-02")
	var adds int
	if _, uerr := s.Store.UpdateCustomer(ctx, user.UID, func(c *store.Customer) error {
		if c.MethodAddsDay != day {
			c.MethodAddsDay, c.MethodAdds = day, 0
		}
		if c.MethodAdds >= maxMethodAddsPerDay {
			adds = c.MethodAdds + 1 // over the limit; nothing written
			return nil
		}
		c.MethodAdds++
		adds = c.MethodAdds
		return nil
	}); uerr != nil {
		httpx.WriteErr(ctx, w, uerr)
		return
	}
	if adds > maxMethodAddsPerDay {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusTooManyRequests, "too_many_adds", "try adding a payment method again tomorrow"))
		return
	}
	sess, err := s.Stripe.CreateSetupSession(customerID, s.Cfg.StripePMCWeb, s.Cfg.SiteURL+"/billing?added=1",
		map[string]string{"kind": "setup", "user_id": user.UID, "client_ip": clientIP(r), "make_default": fmt.Sprint(req.MakeDefault)},
		fmt.Sprintf("setup_%s_%s_%s_%d", s.Cfg.Env, user.UID, day, adds))
	if err != nil {
		httpx.Log(ctx).Error("setup session failed", "uid", user.UID, "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't start adding a payment method; try again"))
		return
	}
	httpx.WriteOK(w, map[string]any{
		"checkout":        map[string]any{"client_secret": sess.ClientSecret, "expires_at": sess.Expires().Format(time.RFC3339)},
		"publishable_key": s.Stripe.PublishableKey,
	})
}

// applySetupSession records a method saved in Billing: consent, redisplay,
// default if none, tax IP. No credit until it pays (C1).
func (s *Service) applySetupSession(ctx context.Context, sessionID, uid, customerID string) error {
	pm, err := s.Stripe.SetupSessionMethod(sessionID)
	if err != nil || pm == "" {
		return err
	}
	cust, cerr := s.Store.GetCustomer(ctx, uid)
	if cerr != nil || cust.StripeCustomerID != customerID {
		return nil // not this env's customer
	}
	ip, makeDefault := "", false
	if sess, gerr := s.Stripe.GetCheckoutSession(sessionID); gerr == nil {
		ip, makeDefault = sess.Metadata["client_ip"], sess.Metadata["make_default"] == "true"
	}
	s.saveMethodFacts(ctx, uid, customerID, pm, sessionID, ip, makeDefault, false)
	return nil
}

// POST /v1/billing/methods/{id}/default
func (s *Service) HandleSetDefaultMethod(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	customerID, m, err := s.ownedMethod(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if err := s.Stripe.SetDefaultMethod(customerID, m.PaymentMethodID); err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't save that; try again"))
		return
	}
	cardRefreshedAt.Delete(user.UID)
	s.refreshCardCache(ctx, user.UID, customerID)
	s.HandleListMethods(w, r, user)
}

// PUT /v1/billing/methods/order {ids: [...]} — the backup order (C5).
func (s *Service) HandlePutMethodOrder(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.IDs) > maxSavedMethods*2 {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("ids must list your payment methods"))
		return
	}
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	methods, err := s.Stripe.ListMethods(customerID)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't save that; try again"))
		return
	}
	order := []string{}
	for _, id := range req.IDs {
		if slices.ContainsFunc(methods, func(m *stripex.CardInfo) bool { return m.PaymentMethodID == id }) && !slices.Contains(order, id) {
			order = append(order, id)
		}
	}
	if _, err := s.Store.UpdateCustomer(ctx, user.UID, func(c *store.Customer) error {
		c.BackupOrder = order
		return nil
	}); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	s.HandleListMethods(w, r, user)
}

// DELETE /v1/billing/methods/{id} — 409 method_needed for the last method
// while something is owed or pending (C5). Removing the default promotes
// the first backup.
func (s *Service) HandleRemoveMethod(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	customerID, m, err := s.ownedMethod(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	methods, lerr := s.Stripe.ListMethods(customerID)
	if lerr != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't remove that; try again"))
		return
	}
	if reason := s.removeBlocked(ctx, user.UID, len(methods)); reason != "" {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "method_needed",
			"you can't remove your only payment method while a payment is pending; pay it or add another one first"))
		return
	}
	cust, _ := s.Store.GetCustomer(ctx, user.UID)
	if err := s.Stripe.DetachMethod(m.PaymentMethodID); err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't remove that; try again"))
		return
	}
	if cust != nil && cust.DefaultPaymentMethod == m.PaymentMethodID {
		rest := orderMethods(slices.DeleteFunc(methods, func(x *stripex.CardInfo) bool { return x.PaymentMethodID == m.PaymentMethodID }),
			"", cust.BackupOrder)
		if len(rest) > 0 {
			_ = s.Stripe.SetDefaultMethod(customerID, rest[0].PaymentMethodID)
		}
	}
	s.forgetMethod(ctx, user.UID, m.PaymentMethodID)
	cardRefreshedAt.Delete(user.UID)
	s.refreshCardCache(ctx, user.UID, customerID)
	s.HandleListMethods(w, r, user)
}

// forgetMethod drops a removed method from the account facts.
func (s *Service) forgetMethod(ctx context.Context, uid, pm string) {
	if _, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		c.PaidMethods = slices.DeleteFunc(c.PaidMethods, func(x string) bool { return x == pm })
		c.BackupOrder = slices.DeleteFunc(c.BackupOrder, func(x string) bool { return x == pm })
		if c.LastGoodMethod == pm {
			c.LastGoodMethod = ""
		}
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "removed method not forgotten", "uid", uid, "err", err)
	}
}

func (s *Service) ownedMethod(ctx context.Context, user *AuthedUser, id string) (string, *stripex.CardInfo, error) {
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		return "", nil, err
	}
	methods, err := s.Stripe.ListMethods(customerID)
	if err != nil {
		return "", nil, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't load your payment methods; try again")
	}
	for _, m := range methods {
		if m.PaymentMethodID == id {
			return customerID, m, nil
		}
	}
	return "", nil, httpx.ErrNotFound("payment method")
}

// ------------------------------------------------------------ company

// GET /v1/billing/company → {name, address, tax_ids: [{id, type, value, verification}]}
func (s *Service) HandleGetCompany(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	c, err := s.Stripe.GetCompany(customerID)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't load your company details; try again"))
		return
	}
	httpx.WriteOK(w, c)
}

// PUT /v1/billing/company {name?, address?} — new invoices only.
func (s *Service) HandlePutCompany(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		Name    *string           `json:"name"`
		Address map[string]string `json:"address"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	addr := map[string]string{}
	for _, k := range []string{"line1", "line2", "city", "state", "postal_code", "country"} {
		if v, ok := req.Address[k]; ok {
			addr[k] = strings.TrimSpace(v)
		}
	}
	if req.Name != nil && len(*req.Name) > 200 {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("name is too long"))
		return
	}
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if err := s.Stripe.UpdateCompany(customerID, req.Name, addr); err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "invalid_company", stripex.ErrMessage(err)))
		return
	}
	s.HandleGetCompany(w, r, user)
}

// POST /v1/billing/company/tax-ids {type, value}
func (s *Service) HandleAddTaxID(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		Type  string `json:"type"`
		Value string `json:"value"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Type == "" || strings.TrimSpace(req.Value) == "" {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("type and value are required"))
		return
	}
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if _, err := s.Stripe.AddTaxID(customerID, req.Type, strings.TrimSpace(req.Value)); err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "invalid_tax_id", stripex.ErrMessage(err)))
		return
	}
	s.HandleGetCompany(w, r, user)
}

// ValidTaxIDRef: a Stripe tax id's id (txi_…), for the delete route.
func ValidTaxIDRef(id string) bool {
	return len(id) > 4 && len(id) <= 64 && strings.HasPrefix(id, "txi_") && !strings.ContainsFunc(id[4:], func(c rune) bool {
		return !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9')
	})
}

// DELETE /v1/billing/company/tax-ids/{id}
func (s *Service) HandleDeleteTaxID(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if err := s.Stripe.DeleteTaxID(customerID, id); err != nil {
		var apiErr *httpx.APIError
		if errors.As(err, &apiErr) {
			httpx.WriteErr(ctx, w, apiErr)
			return
		}
		httpx.WriteErr(ctx, w, httpx.ErrNotFound("tax ID"))
		return
	}
	s.HandleGetCompany(w, r, user)
}
