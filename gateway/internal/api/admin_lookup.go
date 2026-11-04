package api

import (
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
// plan}]}: an exact uid, or emails starting with q (at least 2
// characters), at most 20, the uid match first.
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
		return map[string]any{"uid": uid, "email": nilIfEmpty(c.Email), "created_at": created, "plan": adminPlanLabel(c, now)}
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
