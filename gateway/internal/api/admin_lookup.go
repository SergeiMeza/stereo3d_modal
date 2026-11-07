package api

import (
	"context"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Admin lookups for the console's ⌘K and lists (BL-29). The search text
// is never logged or audited (it may be an email).

// adminPlanLabel: the account's active web plan (plan id or tier), or nil.
func adminPlanLabel(c *store.Customer, now time.Time) any {
	if c == nil || c.Plan == nil || !c.Plan.Active(now) {
		return nil
	}
	if c.Plan.PlanID != "" {
		return c.Plan.PlanID
	}
	return c.Plan.Tier
}

// GET /v1/admin/accounts?q= → {accounts: [{uid, email, created_at,
// plan, deleted, found_by}]}: an exact uid, or emails starting with q (at
// least 2 characters), at most 20, the uid match first. A whole email
// also finds the Stripe customers made with it (found_by "stripe"): an
// account whose record has another email, or none, a deleted one too
// (support's lookup after a deletion, owner 2026-11-06). Accounts holding
// a matching email in the email store, an additional or a released one,
// come with found_by "email", matched_email and email_released.
func (s *Service) HandleAdminAccountSearch(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if utf8.RuneCountInString(q) < 2 || len(q) > 320 {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("q: 2 to 320 characters (an email prefix or a uid)"))
		return
	}
	now := time.Now().UTC()
	row := func(uid string, c *store.Customer) map[string]any {
		var created any
		if !c.CreatedAt.IsZero() {
			created = c.CreatedAt
		}
		return map[string]any{"uid": uid, "email": nilIfEmpty(c.Email), "created_at": created, "plan": adminPlanLabel(c, now),
			"deleted": c.AccountDeleted, "found_by": "record"}
	}
	out := []map[string]any{}
	seen := map[string]bool{}
	if validAccountUID(q) {
		if c, err := s.Store.GetCustomer(ctx, q); err == nil {
			out, seen[q] = append(out, row(q, c)), true
		}
	}
	found, err := s.Store.SearchCustomersByEmail(ctx, q, 20)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	var rest []map[string]any
	for uid, c := range found {
		if !seen[uid] {
			rest = append(rest, row(uid, c))
		}
	}
	for _, row := range s.emailStoreAccounts(ctx, q, seen, found, row) {
		rest = append(rest, row)
	}
	for _, row := range s.stripeAccountsByEmail(ctx, q, seen, found, row) {
		rest = append(rest, row)
	}
	sort.Slice(rest, func(i, j int) bool {
		ei, _ := rest[i]["email"].(string)
		ej, _ := rest[j]["email"].(string)
		return ei < ej
	})
	out = append(out, rest...)
	if len(out) > 20 {
		out = out[:20]
	}
	s.audit(ctx, a, "account_search", map[string]any{"results": len(out)}) // not the query
	httpx.WriteOK(w, map[string]any{"accounts": out})
}

// GET /v1/admin/runs/{id} → {run: {id, uid, project_id, status,
// created_at, amount_cents, currency, kind, method}}; 404 run_not_found.
func (s *Service) HandleAdminRun(w http.ResponseWriter, r *http.Request, a *AdminUser, id string) {
	ctx := r.Context()
	c, err := s.Store.GetConversion(ctx, id)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusNotFound, "run_not_found", "No run with that ID."))
		return
	}
	s.audit(ctx, a, "run_view", map[string]any{"conversion_id": id})
	run := map[string]any{"id": c.ID, "uid": c.UID, "project_id": nilIfEmpty(c.ProjectID), "status": c.State,
		"created_at": c.CreatedAt, "amount_cents": c.Quote.AmountCents, "currency": nilIfEmpty(c.Quote.Currency), "kind": c.Kind,
		"method": nilIfEmpty(c.Method), "presentment": c.Stripe.Presentment}
	addRunMedia(run, c)
	run["source"] = s.adminSourceJSON(ctx, c.ProjectID, nil)
	httpx.WriteOK(w, map[string]any{"run": run})
}

// GET /v1/admin/efws → {efws: [{id, uid, charge, payment_intent,
// amount_cents, created, case_id}]}: every early fraud warning still
// open, with a case (an efw case not closed) or without one (a
// fraud-warning hold on promotional Pro, e.g. a plan invoice's), newest
// first. charge and created come from Stripe when it answers.
func (s *Service) HandleAdminOpenEFWs(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	rows := map[string]map[string]any{}
	if cases, err := s.Store.ListCasesByType(ctx, store.CaseEFW, 500); err == nil {
		for _, c := range cases {
			if !c.Open {
				continue
			}
			id := firstNonEmpty(c.Related.EFWID, c.ID)
			pi := ""
			if len(c.Related.PIIDs) > 0 {
				pi = c.Related.PIIDs[0]
			}
			rows[id] = map[string]any{"id": id, "uid": c.UID, "charge": nil, "payment_intent": nilIfEmpty(pi), "amount_cents": c.RequestedCents,
				"created": c.OpenedAt, "case_id": c.ID}
		}
	}
	if recs, err := s.Store.ListPromoRegrantsByStatus(ctx, []string{"held"}, 500); err == nil {
		for _, rec := range recs {
			id, ok := strings.CutPrefix(rec.ID, "efw:")
			if !ok || rows[id] != nil {
				continue
			}
			rows[id] = map[string]any{"id": id, "uid": rec.UID, "charge": nil, "payment_intent": nil, "amount_cents": rec.AmountCents,
				"created": rec.CreatedAt, "case_id": nilIfEmpty(rec.CaseID)}
		}
	}
	if len(rows) > 0 && s.Stripe != nil {
		if efws, err := s.Stripe.ListEFWsSince(time.Now().AddDate(0, 0, -180), 2000); err == nil {
			for _, e := range efws {
				if row := rows[e.ID]; row != nil {
					row["charge"] = nilIfEmpty(e.Charge)
					if e.PaymentIntent != "" {
						row["payment_intent"] = e.PaymentIntent
					}
					if e.Created > 0 {
						row["created"] = time.Unix(e.Created, 0).UTC()
					}
				}
			}
		}
	}
	out := make([]map[string]any, 0, len(rows))
	for _, row := range rows {
		out = append(out, row)
	}
	sort.Slice(out, func(i, j int) bool {
		ti, _ := out[i]["created"].(time.Time)
		tj, _ := out[j]["created"].(time.Time)
		return ti.After(tj)
	})
	s.audit(ctx, a, "efws_list", map[string]any{"count": len(out)})
	httpx.WriteOK(w, map[string]any{"efws": out})
}

// looksLikeEmail: a whole address, worth asking Stripe about.
func looksLikeEmail(q string) bool {
	at := strings.LastIndex(q, "@")
	return at > 0 && strings.Contains(q[at+1:], ".") && !strings.ContainsAny(q, " '\"\\")
}

// stripeAccountsByEmail are the accounts whose Stripe customer has the
// email q, not already listed (seen, or found by their record). The
// account's record fills the row when there is one; Stripe failing
// leaves the search as it was.
func (s *Service) stripeAccountsByEmail(ctx context.Context, q string, seen map[string]bool, found map[string]*store.Customer,
	row func(string, *store.Customer) map[string]any) []map[string]any {
	if s.Stripe == nil || !looksLikeEmail(q) {
		return nil
	}
	custs, err := s.Stripe.CustomersByEmail(strings.ToLower(q))
	if err != nil {
		slog.WarnContext(ctx, "admin search: Stripe lookup failed", "err", err) // never the query
		return nil
	}
	var out []map[string]any
	for _, ec := range custs {
		if seen[ec.UID] || found[ec.UID] != nil {
			continue
		}
		seen[ec.UID] = true
		r := map[string]any{"uid": ec.UID, "email": nilIfEmpty(ec.Email), "created_at": nil, "plan": nil, "deleted": false}
		if c, err := s.Store.GetCustomer(ctx, ec.UID); err == nil {
			r = row(ec.UID, c)
			if r["email"] == nil {
				r["email"] = nilIfEmpty(ec.Email)
			}
		}
		r["found_by"] = "stripe"
		out = append(out, r)
	}
	return out
}

// emailStoreAccounts are the accounts with an email row starting with q
// (additional and released emails included) not found already.
func (s *Service) emailStoreAccounts(ctx context.Context, q string, seen map[string]bool, found map[string]*store.Customer,
	row func(string, *store.Customer) map[string]any) []map[string]any {
	rows, err := s.Store.SearchAccountEmails(ctx, q, 20)
	if err != nil {
		slog.WarnContext(ctx, "admin search: email store lookup failed", "err", err) // never the query
		return nil
	}
	var out []map[string]any
	for _, e := range rows {
		if seen[e.UID] || found[e.UID] != nil {
			continue
		}
		seen[e.UID] = true
		c, err := s.Store.GetCustomer(ctx, e.UID)
		if err != nil {
			c = &store.Customer{}
		}
		r := row(e.UID, c)
		r["found_by"], r["matched_email"], r["email_released"] = "email", e.Email, e.State == store.EmailReleased
		if e.SupportCase != "" {
			r["support_case"], r["support_note"] = e.SupportCase, e.SupportNote
		}
		out = append(out, r)
	}
	return out
}
