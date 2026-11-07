package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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
)

// Grant credit (owner 2026-11-07): an admin adds usage credit to an
// account, on the same ledger as the Pro credit (spent before the card,
// never paid out). Passkey session plus a fresh sign-in (5 min),
// idempotent on request_id, audited (admin, time, amount, reason, an IP
// hash). Above admin_credit_grant_cap_cents it needs confirm_over_cap.
// The user sees "Credit from Spatial Video Studio" in Billing history,
// never the reason; balance.credits shows it as kind "grant". Revoke takes
// only that grant's unspent cents.

var creditGrantReasons = []string{"support_goodwill", "refund_as_credit", "promo", "test", "other"}

const (
	creditGrantDefaultDays = 90
	creditGrantMaxCents    = 1_000_000 // $10,000: a typo guard above any cap
)

type creditGrantReq struct {
	AmountCents    int64           `json:"amount_cents"`
	Reason         string          `json:"reason"`
	ReasonText     string          `json:"reason_text"`
	ExpiresDays    json.RawMessage `json:"expires_days"` // absent = 90, null = no end
	NotifyUser     bool            `json:"notify_user"`
	Message        string          `json:"message"`
	RequestID      string          `json:"request_id"`
	ConfirmOverCap bool            `json:"confirm_over_cap"`
}

// parse checks the body; expiry is nil for no end.
func (q *creditGrantReq) parse(now time.Time, needID bool) (*time.Time, *httpx.APIError) {
	q.Reason, q.ReasonText, q.Message, q.RequestID = strings.TrimSpace(q.Reason), strings.TrimSpace(q.ReasonText), strings.TrimSpace(q.Message), strings.TrimSpace(q.RequestID)
	switch {
	case q.AmountCents <= 0 || q.AmountCents > creditGrantMaxCents:
		return nil, httpx.ErrInvalid(fmt.Sprintf("amount_cents must be 1–%d", creditGrantMaxCents))
	case !slices.Contains(creditGrantReasons, q.Reason):
		return nil, httpx.ErrInvalid("reason must be one of " + strings.Join(creditGrantReasons, ", "))
	case q.Reason == "other" && q.ReasonText == "":
		return nil, httpx.ErrInvalid("reason other needs reason_text")
	case len(q.ReasonText) > 500 || len(q.Message) > 1000:
		return nil, httpx.ErrInvalid("reason_text is at most 500 characters, message 1000")
	case needID && (len(q.RequestID) < 8 || len(q.RequestID) > 100):
		return nil, httpx.ErrInvalid("request_id (8–100 characters) is required")
	}
	days := creditGrantDefaultDays
	raw := strings.TrimSpace(string(q.ExpiresDays))
	switch raw {
	case "":
	case "null":
		return nil, nil
	default:
		if err := json.Unmarshal(q.ExpiresDays, &days); err != nil || days < 1 || days > 3650 {
			return nil, httpx.ErrInvalid("expires_days must be 1–3650, or null for no end")
		}
	}
	exp := now.AddDate(0, 0, days)
	return &exp, nil
}

func creditGrantID(uid, requestID string) string {
	sum := sha256.Sum256([]byte(uid + "|" + requestID))
	return "cg" + hex.EncodeToString(sum[:8])
}

func creditGrantJSON(g *store.CreditGrant, b *store.Balance) map[string]any {
	out := map[string]any{"id": g.ID, "uid": g.UID, "amount_cents": g.AmountCents, "reason": g.Reason, "reason_text": nilIfEmpty(g.ReasonText),
		"expires_at": g.ExpiresAt, "over_cap": g.OverCap, "admin": g.Admin, "request_id": g.RequestID, "notify_user": g.NotifyUser,
		"message": nilIfEmpty(g.Message), "mail_state": nilIfEmpty(g.MailState), "state": g.State, "revoked_cents": g.RevokedCents,
		"revoked_at": g.RevokedAt, "revoked_by": nilIfEmpty(g.RevokedBy), "created_at": g.CreatedAt, "unspent_cents": nil}
	if b != nil {
		out["unspent_cents"] = b.RemainingByRef(g.Ref)
	}
	return out
}

func balanceAfterJSON(b *store.Balance) map[string]any {
	if b == nil {
		return nil
	}
	credits := []map[string]any{}
	for _, c := range b.Credits(time.Now()) {
		credits = append(credits, map[string]any{"kind": c.Kind, "cents": c.Cents, "expires_at": c.ExpiresAt})
	}
	return map[string]any{"balance_cents": max(b.Available(), 0), "credits": credits}
}

// POST /v1/admin/accounts/{uid}/credit-grants/preview {amount_cents,
// reason, expires_days?} → {amount_cents, cap_cents, over_cap, expires_at,
// balance_before_cents, balance_after_cents}: nothing is granted.
func (s *Service) HandleAdminCreditGrantPreview(w http.ResponseWriter, r *http.Request, a *AdminUser, uid string) {
	ctx := r.Context()
	var req creditGrantReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	exp, perr := req.parse(time.Now().UTC(), false)
	if perr != nil {
		httpx.WriteErr(ctx, w, perr)
		return
	}
	if _, err := s.Store.GetCustomer(ctx, uid); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrNotFound("account"))
		return
	}
	var before int64
	if b, err := s.Store.GetBalance(ctx, uid); err == nil {
		before = max(b.Available(), 0)
	}
	capCents := s.Pricing.Rates(ctx).AdminCreditGrantCap()
	httpx.WriteOK(w, map[string]any{"amount_cents": req.AmountCents, "cap_cents": capCents, "over_cap": req.AmountCents > capCents,
		"expires_at": exp, "balance_before_cents": before, "balance_after_cents": before + req.AmountCents})
}

// POST /v1/admin/accounts/{uid}/credit-grants (fresh sign-in) → {grant,
// balance_after {balance_cents, credits}, replay}. 409 over_cap without
// confirm_over_cap; 409 request_id_reused when the same request_id came
// with another body.
func (s *Service) HandleAdminCreditGrant(w http.ResponseWriter, r *http.Request, a *AdminUser, uid string) {
	ctx := r.Context()
	if !a.FreshAuth() {
		httpx.WriteErr(ctx, w, a.reauthErr())
		return
	}
	var req creditGrantReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	now := time.Now().UTC()
	exp, perr := req.parse(now, true)
	if perr != nil {
		httpx.WriteErr(ctx, w, perr)
		return
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrNotFound("account"))
		return
	}
	rates := s.Pricing.Rates(ctx)
	overCap := req.AmountCents > rates.AdminCreditGrantCap()
	if overCap && !req.ConfirmOverCap {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "over_cap",
			fmt.Sprintf("%s is above the %s cap; send confirm_over_cap: true to grant it", money(req.AmountCents), money(rates.AdminCreditGrantCap()))))
		return
	}
	id := creditGrantID(uid, req.RequestID)
	g := &store.CreditGrant{ID: id, UID: uid, AmountCents: req.AmountCents, Reason: req.Reason, ReasonText: req.ReasonText, ExpiresAt: exp,
		OverCap: overCap, Admin: a.who(), AdminUID: a.UID, IPHash: hashIP(clientIP(r)), RequestID: req.RequestID,
		Ref: "admin:grant:" + id, EntryID: "creditgrant_" + id, NotifyUser: req.NotifyUser, Message: req.Message, State: "pending"}
	replay := false
	if err := s.Store.CreateCreditGrant(ctx, g); errors.Is(err, store.ErrAlreadyExists) {
		prev, gerr := s.Store.GetCreditGrant(ctx, id)
		if gerr != nil {
			httpx.WriteErr(ctx, w, gerr)
			return
		}
		if prev.AmountCents != req.AmountCents || prev.Reason != req.Reason {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "request_id_reused", "this request_id was used for another grant"))
			return
		}
		g, replay = prev, true
	} else if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if g.State == "pending" { // first time, or a retry of one cut short: the entry id makes it once
		_, fx, berr := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
			return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: g.AmountCents, EntryID: g.EntryID, Ref: g.Ref, ExpiresAt: g.ExpiresAt,
				Note: "credit from Spatial Video Studio", Additive: true}}, nil
		})
		if berr != nil {
			slog.ErrorContext(ctx, "credit grant not applied", "grant_id", id, "err", berr)
			httpx.WriteErr(ctx, w, berr)
			return
		}
		s.handleBalanceEffects(ctx, uid, fx)
		s.payDebtsFromBalance(ctx, uid)
		mailState := ""
		if g.NotifyUser {
			mailState = s.mailCreditGrant(ctx, g, cust.Email)
		}
		if up, uerr := s.Store.UpdateCreditGrant(ctx, id, func(x *store.CreditGrant) error {
			x.State, x.MailState = "active", mailState
			return nil
		}); uerr == nil {
			g = up
		}
		s.audit(ctx, a, "credit_grant", map[string]any{"uid": uid, "grant_id": id, "amount_cents": g.AmountCents, "reason": g.Reason,
			"over_cap": overCap, "expires_at": g.ExpiresAt, "notify_user": g.NotifyUser, "mail_state": mailState, "ip_hash": g.IPHash, "at": now})
	}
	b, _ := s.Store.GetBalance(ctx, uid)
	httpx.WriteOK(w, map[string]any{"grant": creditGrantJSON(g, b), "balance_after": balanceAfterJSON(b), "replay": replay})
}

// mailCreditGrant tells the account (subject names the app). Off prod it
// reaches only the accounts in credit_grant_mail_allow_uids (the owner's
// test account); others are a dry run, logged.
func (s *Service) mailCreditGrant(ctx context.Context, g *store.CreditGrant, email string) string {
	if s.Cfg.Env != "prod" && !slices.Contains(s.Pricing.Rates(ctx).CreditGrantMailAllowUIDs, g.UID) {
		slog.InfoContext(ctx, "credit grant mail: dry run (not allowlisted off prod)", "grant_id", g.ID)
		return "dry_run"
	}
	if email == "" {
		return "skipped"
	}
	s.mailCustomer(ctx, "CG_"+g.ID, g.UID, email, creditGrantMail(money(g.AmountCents), g.Message, g.ExpiresAt, s.Cfg.SiteURL))
	return "sent"
}

// GET /v1/admin/accounts/{uid}/credit-grants → {grants: [grant with
// unspent_cents]}.
func (s *Service) HandleAdminAccountCreditGrants(w http.ResponseWriter, r *http.Request, a *AdminUser, uid string) {
	ctx := r.Context()
	gs, err := s.Store.ListCreditGrants(ctx, uid, 200)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	b, _ := s.Store.GetBalance(ctx, uid)
	out := make([]map[string]any, 0, len(gs))
	for _, g := range gs {
		out = append(out, creditGrantJSON(g, b))
	}
	httpx.WriteOK(w, map[string]any{"grants": out})
}

// POST /v1/admin/accounts/{uid}/credit-grants/{id}/revoke (fresh sign-in)
// → {grant, revoked_cents, balance_after}: removes only what's left of
// that grant (what was spent stays spent). Again: nothing more, 200.
func (s *Service) HandleAdminCreditGrantRevoke(w http.ResponseWriter, r *http.Request, a *AdminUser, uid, id string) {
	ctx := r.Context()
	if !a.FreshAuth() {
		httpx.WriteErr(ctx, w, a.reauthErr())
		return
	}
	g, err := s.Store.GetCreditGrant(ctx, id)
	if err != nil || g.UID != uid {
		httpx.WriteErr(ctx, w, httpx.ErrNotFound("grant"))
		return
	}
	if g.State == "revoked" {
		b, _ := s.Store.GetBalance(ctx, uid)
		httpx.WriteOK(w, map[string]any{"grant": creditGrantJSON(g, b), "revoked_cents": g.RevokedCents, "balance_after": balanceAfterJSON(b)})
		return
	}
	before, _ := s.Store.GetBalance(ctx, uid)
	after, fx, berr := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryPlanCreditRemoval, EntryID: "creditgrant_revoke_" + id, Ref: g.Ref, MatchRef: true,
			Note: "credit ended"}}, nil
	})
	if berr != nil {
		httpx.WriteErr(ctx, w, berr)
		return
	}
	s.handleBalanceEffects(ctx, uid, fx)
	var revoked int64
	if before != nil {
		revoked = before.RemainingByRef(g.Ref) - after.RemainingByRef(g.Ref)
	}
	now := time.Now().UTC()
	g, _ = s.Store.UpdateCreditGrant(ctx, id, func(x *store.CreditGrant) error {
		x.State, x.RevokedCents, x.RevokedAt, x.RevokedBy = "revoked", revoked, &now, a.who()
		return nil
	})
	s.audit(ctx, a, "credit_grant_revoke", map[string]any{"uid": uid, "grant_id": id, "revoked_cents": revoked, "ip_hash": hashIP(clientIP(r)), "at": now})
	httpx.WriteOK(w, map[string]any{"grant": creditGrantJSON(g, after), "revoked_cents": revoked, "balance_after": balanceAfterJSON(after)})
}

// GET /v1/admin/credit-grants → {grants (newest 500), months [{month,
// grants, cents, revoked_cents}], truncated}.
func (s *Service) HandleAdminAllCreditGrants(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	const limit = 500
	gs, err := s.Store.ListCreditGrants(ctx, "", limit)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	months := map[string]map[string]int64{}
	rows := make([]map[string]any, 0, len(gs))
	for _, g := range gs {
		rows = append(rows, creditGrantJSON(g, nil))
		if g.State != "active" && g.State != "revoked" {
			continue
		}
		m := g.CreatedAt.UTC().Format("2006-01")
		if months[m] == nil {
			months[m] = map[string]int64{}
		}
		months[m]["grants"]++
		months[m]["cents"] += g.AmountCents
		months[m]["revoked_cents"] += g.RevokedCents
	}
	byMonth := []map[string]any{}
	for m, v := range months {
		byMonth = append(byMonth, map[string]any{"month": m, "grants": v["grants"], "cents": v["cents"], "revoked_cents": v["revoked_cents"]})
	}
	sortByKey(byMonth, "month")
	slices.Reverse(byMonth) // newest first
	httpx.WriteOK(w, map[string]any{"grants": rows, "months": byMonth, "truncated": len(gs) >= limit})
}
