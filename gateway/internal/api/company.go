package api

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/mail"
	"strings"
	"time"
	"unicode/utf8"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Company details for invoices (owner 2026-11-04). A Business or Studio
// Checkout collects the billing address (required), a business name and
// tax IDs; checkout.session.completed stores them on the account
// (customer.company) and keeps the Stripe Customer in sync (name =
// business name or name, address, tax IDs added and deduped), so every
// invoice shows them. GET/PUT /v1/billing/company read and change them:
// the PO reference becomes the customer's invoice custom field "PO" on
// invoices from then on; Stripe has no API for extra invoice recipients,
// so the billing email is stored and copied on our own receipt mails (E1,
// E6, E13).

var companyAddressKeys = []string{"line1", "line2", "city", "postal_code", "state", "country"}

const companyChangesKept = 20

// companyView is the company block: {company_name, address{…}, tax_id
// {type, value, verification}|null, billing_email, po_reference}.
func companyView(cust *store.Customer, sc *stripex.Company) map[string]any {
	var stored store.CompanyDetails
	if cust != nil && cust.Company != nil {
		stored = *cust.Company
	}
	name := stored.CompanyName
	addr := map[string]string{}
	for _, k := range companyAddressKeys {
		addr[k] = stored.Address[k]
	}
	var taxID any
	if len(stored.TaxIDs) > 0 {
		taxID = map[string]any{"type": stored.TaxIDs[0].Type, "value": stored.TaxIDs[0].Value, "verification": nil}
	}
	if sc != nil { // the Stripe Customer is what invoices show
		if name == "" {
			name = sc.Name
		}
		if len(sc.Address) > 0 {
			for _, k := range companyAddressKeys {
				addr[k] = sc.Address[k]
			}
		}
		taxID = nil
		if len(sc.TaxIDs) > 0 {
			t := sc.TaxIDs[0]
			taxID = map[string]any{"type": t.Type, "value": t.Value, "verification": nullStr(t.VerificationStatus())}
		}
	}
	return map[string]any{"company_name": nullStr(name), "address": addr, "tax_id": taxID,
		"billing_email": nullStr(stored.BillingEmail), "po_reference": nullStr(stored.POReference)}
}

func nullStr(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// GET /v1/billing/company → the company block, plus the older keys
// {name, tax_ids: [{id, type, value, verification}]}.
func (s *Service) HandleGetCompany(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	sc, err := s.Stripe.GetCompany(customerID)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't load your company details; try again"))
		return
	}
	cust, _ := s.Store.GetCustomer(ctx, user.UID)
	out := companyView(cust, sc)
	ids := make([]map[string]any, 0, len(sc.TaxIDs))
	for _, t := range sc.TaxIDs {
		ids = append(ids, map[string]any{"id": t.ID, "type": t.Type, "value": t.Value, "verification": nullStr(t.VerificationStatus())})
	}
	out["name"], out["tax_ids"] = sc.Name, ids
	httpx.WriteOK(w, out)
}

// optNullString reads a JSON field that may be absent (set=false), null or
// a string (set=true; null → "").
func optNullString(raw json.RawMessage) (set bool, val string, ok bool) {
	if len(raw) == 0 {
		return false, "", true
	}
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return true, "", true
	}
	if json.Unmarshal(raw, &val) != nil {
		return true, "", false
	}
	return true, strings.TrimSpace(val), true
}

func validEmail(e string) bool {
	if e == "" || len(e) > 200 || strings.ContainsAny(e, " \t\r\n,;") {
		return false
	}
	a, err := mail.ParseAddress(e)
	return err == nil && a.Address == e
}

// PUT /v1/billing/company {company_name?, address?{line1, line2, city,
// postal_code, state, country}, tax_id?{type, value}|null,
// billing_email?|null, po_reference?|null} → the GET answer. Absent
// fields stay; null clears. Stripe's tax ID check → 400 invalid_tax_id
// with its message, before anything else changes.
func (s *Service) HandlePutCompany(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		CompanyName  json.RawMessage   `json:"company_name"`
		Name         json.RawMessage   `json:"name"` // older clients
		Address      map[string]string `json:"address"`
		TaxID        json.RawMessage   `json:"tax_id"`
		BillingEmail json.RawMessage   `json:"billing_email"`
		POReference  json.RawMessage   `json:"po_reference"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	nameRaw := req.CompanyName
	if len(nameRaw) == 0 {
		nameRaw = req.Name
	}
	nameSet, name, ok1 := optNullString(nameRaw)
	emailSet, email, ok2 := optNullString(req.BillingEmail)
	poSet, po, ok3 := optNullString(req.POReference)
	if !ok1 || !ok2 || !ok3 {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("company_name, billing_email and po_reference are strings or null"))
		return
	}
	switch {
	case utf8.RuneCountInString(name) > 200:
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("company_name: at most 200 characters"))
		return
	case emailSet && email != "" && !validEmail(email):
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "invalid_email", "That billing email doesn't look right."))
		return
	case utf8.RuneCountInString(po) > 100:
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("po_reference: at most 100 characters"))
		return
	}
	var addr map[string]string
	if req.Address != nil {
		addr = map[string]string{}
		for _, k := range companyAddressKeys {
			v, ok := req.Address[k]
			if !ok {
				continue
			}
			v = strings.TrimSpace(v)
			if utf8.RuneCountInString(v) > 200 {
				httpx.WriteErr(ctx, w, httpx.ErrInvalid("address."+k+": at most 200 characters"))
				return
			}
			if k == "country" {
				v = strings.ToUpper(v)
				if v != "" && (len(v) != 2 || v[0] < 'A' || v[0] > 'Z' || v[1] < 'A' || v[1] > 'Z') {
					httpx.WriteErr(ctx, w, httpx.ErrInvalid("address.country: a two-letter country code"))
					return
				}
			}
			addr[k] = v
		}
	}
	taxSet, clearTax := len(req.TaxID) > 0, false
	var tax store.CompanyTaxID
	if taxSet {
		if bytes.Equal(bytes.TrimSpace(req.TaxID), []byte("null")) {
			clearTax = true
		} else if json.Unmarshal(req.TaxID, &tax) != nil || strings.TrimSpace(tax.Type) == "" || strings.TrimSpace(tax.Value) == "" ||
			len(tax.Type) > 32 || len(tax.Value) > 64 {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("tax_id: {type, value} or null"))
			return
		}
		tax.Type, tax.Value = strings.TrimSpace(tax.Type), strings.TrimSpace(tax.Value)
	}
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	var fields []string
	if taxSet {
		sc, err := s.Stripe.GetCompany(customerID)
		if err != nil {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "couldn't load your company details; try again"))
			return
		}
		keep := ""
		if !clearTax {
			for _, t := range sc.TaxIDs {
				if t.Type == tax.Type && sameTaxValue(t.Value, tax.Value) {
					keep = t.ID
				}
			}
			if keep == "" {
				added, err := s.Stripe.AddTaxID(customerID, tax.Type, tax.Value)
				if err != nil {
					httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "invalid_tax_id", stripex.ErrMessage(err)))
					return
				}
				keep = added.ID
			}
		}
		for _, t := range sc.TaxIDs { // one tax ID: the others go
			if t.ID != keep {
				if err := s.Stripe.DeleteTaxID(customerID, t.ID); err != nil {
					slog.WarnContext(ctx, "old tax ID not removed", "uid", user.UID, "err", err)
				}
			}
		}
		fields = append(fields, "tax_id")
	}
	if nameSet || addr != nil {
		var np *string
		if nameSet {
			np = &name
		}
		if err := s.Stripe.UpdateCompany(customerID, np, addr); err != nil {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "invalid_company", stripex.ErrMessage(err)))
			return
		}
		if nameSet {
			fields = append(fields, "company_name")
		}
		if addr != nil {
			fields = append(fields, "address")
		}
	}
	if poSet {
		if err := s.Stripe.SetInvoicePO(customerID, po); err != nil {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "invalid_company", stripex.ErrMessage(err)))
			return
		}
		fields = append(fields, "po_reference")
	}
	if emailSet {
		fields = append(fields, "billing_email")
	}
	if len(fields) > 0 {
		s.saveCompany(ctx, user.UID, "user", fields, func(c *store.CompanyDetails) {
			if nameSet {
				c.CompanyName = name
			}
			if addr != nil {
				if c.Address == nil {
					c.Address = map[string]string{}
				}
				for k, v := range addr {
					c.Address[k] = v
				}
			}
			if taxSet {
				c.TaxIDs = nil
				if !clearTax {
					c.TaxIDs = []store.CompanyTaxID{tax}
				}
			}
			if emailSet {
				c.BillingEmail = email
			}
			if poSet {
				c.POReference = po
			}
		})
	}
	s.HandleGetCompany(w, r, user)
}

func sameTaxValue(a, b string) bool {
	norm := func(v string) string {
		return strings.ToUpper(strings.Map(func(c rune) rune {
			if c == ' ' || c == '-' || c == '.' {
				return -1
			}
			return c
		}, v))
	}
	return norm(a) == norm(b)
}

// saveCompany changes customer.company and logs the change (which
// fields, by what).
func (s *Service) saveCompany(ctx context.Context, uid, by string, fields []string, mutate func(c *store.CompanyDetails)) {
	now := time.Now().UTC()
	_, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Company == nil {
			c.Company = &store.CompanyDetails{}
		}
		mutate(c.Company)
		c.Company.Source, c.Company.UpdatedAt = by, now
		c.Company.Changes = append(c.Company.Changes, store.CompanyChange{At: now, By: by, Fields: fields})
		if n := len(c.Company.Changes); n > companyChangesKept {
			c.Company.Changes = c.Company.Changes[n-companyChangesKept:]
		}
		return nil
	})
	if err != nil {
		slog.WarnContext(ctx, "company details not saved", "uid", uid, "err", err)
		return
	}
	slog.InfoContext(ctx, "company details changed", "uid", uid, "by", by, "fields", fields)
}

// checkoutDetails is a completed Checkout's customer_details.
type checkoutDetails struct {
	Name         string            `json:"name"`
	BusinessName string            `json:"business_name"`
	Email        string            `json:"email"`
	Address      map[string]string `json:"address"`
	TaxIDs       []struct {
		Type  string `json:"type"`
		Value string `json:"value"`
	} `json:"tax_ids"`
}

// applyCheckoutCompany stores a plan Checkout's company details and
// keeps the Stripe Customer in sync. A Pro Checkout counts only when it
// carries a business name or a tax ID (a person buying Pro isn't a
// company). Idempotent: a redelivery changes nothing.
func (s *Service) applyCheckoutCompany(ctx context.Context, uid, customerID, tier string, d checkoutDetails) {
	if uid == "" || s.Store == nil {
		return
	}
	business := tier == pricing.TierBusiness || tier == pricing.TierStudio
	if !business && d.BusinessName == "" && len(d.TaxIDs) == 0 {
		return
	}
	name := strings.TrimSpace(d.BusinessName)
	if name == "" {
		name = strings.TrimSpace(d.Name)
	}
	addr := map[string]string{}
	for _, k := range companyAddressKeys {
		if v := strings.TrimSpace(d.Address[k]); v != "" {
			addr[k] = v
		}
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil {
		return
	}
	var cur store.CompanyDetails
	if cust.Company != nil {
		cur = *cust.Company
	}
	taxIDs := append([]store.CompanyTaxID(nil), cur.TaxIDs...)
	for _, t := range d.TaxIDs {
		dup := false
		for _, x := range taxIDs {
			if x.Type == t.Type && sameTaxValue(x.Value, t.Value) {
				dup = true
			}
		}
		if !dup && t.Type != "" && t.Value != "" {
			taxIDs = append(taxIDs, store.CompanyTaxID{Type: t.Type, Value: t.Value})
		}
	}
	var fields []string
	if name != "" && name != cur.CompanyName {
		fields = append(fields, "company_name")
	}
	if len(addr) > 0 && !sameAddr(addr, cur.Address) {
		fields = append(fields, "address")
	}
	if len(taxIDs) != len(cur.TaxIDs) {
		fields = append(fields, "tax_id")
	}
	email := strings.TrimSpace(d.Email)
	if cur.BillingEmail == "" && email != "" {
		fields = append(fields, "billing_email")
	}
	if customerID != "" { // invoices read the Customer
		var np *string
		if name != "" {
			np = &name
		}
		var ap map[string]string
		if len(addr) > 0 {
			ap = addr
		}
		if err := s.Stripe.UpdateCompany(customerID, np, ap); err != nil {
			slog.WarnContext(ctx, "checkout company not synced to the customer", "uid", uid, "err", err)
		}
		if sc, err := s.Stripe.GetCompany(customerID); err == nil {
			for _, t := range taxIDs {
				found := false
				for _, x := range sc.TaxIDs {
					if x.Type == t.Type && sameTaxValue(x.Value, t.Value) {
						found = true
					}
				}
				if !found {
					if _, err := s.Stripe.AddTaxID(customerID, t.Type, t.Value); err != nil {
						slog.WarnContext(ctx, "checkout tax ID not added to the customer", "uid", uid, "type", t.Type, "err", err)
					}
				}
			}
		}
	}
	if len(fields) == 0 {
		return
	}
	s.saveCompany(ctx, uid, "checkout", fields, func(c *store.CompanyDetails) {
		if name != "" {
			c.CompanyName = name
		}
		if len(addr) > 0 {
			c.Address = addr
		}
		c.TaxIDs = taxIDs
		if c.BillingEmail == "" {
			c.BillingEmail = email
		}
	})
}

func sameAddr(a, b map[string]string) bool {
	for _, k := range companyAddressKeys {
		if a[k] != b[k] {
			return false
		}
	}
	return true
}

// billingEmailCopy: the company's billing email for a receipt's copy
// ("" when none or the same as the account's).
func (s *Service) billingEmailCopy(ctx context.Context, uid, accountEmail string) string {
	c, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || c.Company == nil || c.Company.BillingEmail == "" || strings.EqualFold(c.Company.BillingEmail, accountEmail) {
		return ""
	}
	return c.Company.BillingEmail
}
