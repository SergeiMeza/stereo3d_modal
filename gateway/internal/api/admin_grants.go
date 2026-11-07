package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Admin → Grant Pro (owner 2026-11-04). Support grants promotional Pro
// here, never from the RevenueCat dashboard: each grant is a record on
// promo_grants_{env} (the refund and dispute snapshots read them, so a
// support grant RevenueCat's collapsed view hides still comes back), then
// a RevenueCat promotional grant ending exactly at ends_at. A revoke goes
// through the promo re-grant flow (snapshot, revoke the entitlement, give
// every other grant back).

var adminGrantEntitlements = []string{"pro", "business", "studio"}

const adminGrantMaxAhead = 5 * 366 * 24 * time.Hour

func validAccountUID(uid string) bool {
	if uid == "" || len(uid) > 128 {
		return false
	}
	return !strings.ContainsFunc(uid, func(c rune) bool {
		return !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-')
	})
}

func adminGrantJSON(g *store.AdminGrant, now time.Time) map[string]any {
	out := map[string]any{"id": g.ID, "uid": g.UID, "entitlement": g.Entitlement, "ends_at": g.EndsAt, "granted_by": g.GrantedBy,
		"reason": g.Reason, "created_at": g.CreatedAt, "status": g.Status(now)}
	if g.RCError != "" {
		out["rc_error"] = g.RCError
	}
	if g.RevokedAt != nil {
		out["revoked_at"], out["revoked_by"], out["revoke_reason"] = g.RevokedAt, g.RevokedBy, g.RevokeReason
	}
	return out
}

func (s *Service) adminGrantsJSON(ctx context.Context, uid string) []map[string]any {
	gs, err := s.Store.ListUserAdminGrants(ctx, uid, 200)
	if err != nil {
		return nil
	}
	sort.Slice(gs, func(i, j int) bool { return gs[i].CreatedAt.After(gs[j].CreatedAt) })
	now := time.Now().UTC()
	out := make([]map[string]any, 0, len(gs))
	for _, g := range gs {
		out = append(out, adminGrantJSON(g, now))
	}
	return out
}

// GET /v1/admin/accounts/{uid}/grants → {grants: [...]}, newest first.
func (s *Service) HandleAdminGrants(w http.ResponseWriter, r *http.Request, a *AdminUser, uid string) {
	if !validAccountUID(uid) {
		httpx.WriteErr(r.Context(), w, httpx.Err(http.StatusNotFound, "no_account", "No account with that ID."))
		return
	}
	httpx.WriteOK(w, map[string]any{"grants": s.adminGrantsJSON(r.Context(), uid)})
}

// accountKnown: a web account or an app user.
func (s *Service) accountKnown(ctx context.Context, uid string) bool {
	if _, err := s.Store.GetCustomer(ctx, uid); err == nil {
		return true
	}
	v, err := s.Store.GetAppViewing(ctx, uid)
	return err == nil && v != nil
}

// POST /v1/admin/accounts/{uid}/grants {entitlement, ends_at, reason}
// (fresh sign-in) → 201 {grant}.
func (s *Service) HandleAdminGrantPro(w http.ResponseWriter, r *http.Request, a *AdminUser, uid string) {
	ctx := r.Context()
	if !a.FreshAuth() {
		httpx.WriteErr(ctx, w, a.reauthErr())
		return
	}
	var req struct {
		Entitlement string `json:"entitlement"`
		EndsAt      string `json:"ends_at"`
		Reason      string `json:"reason"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	now := time.Now().UTC()
	ends, err := time.Parse(time.RFC3339, strings.TrimSpace(req.EndsAt))
	reason := strings.TrimSpace(req.Reason)
	switch {
	case !containsStr(adminGrantEntitlements, req.Entitlement):
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("entitlement: pro, business or studio"))
		return
	case err != nil || !ends.After(now.Add(time.Hour)) || ends.After(now.Add(adminGrantMaxAhead)):
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("ends_at: an RFC 3339 time at least an hour and at most five years ahead"))
		return
	case reason == "" || utf8.RuneCountInString(reason) > 500:
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("reason: required, at most 500 characters"))
		return
	}
	if !validAccountUID(uid) || !s.accountKnown(ctx, uid) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusNotFound, "no_account", "No account with that ID."))
		return
	}
	if !s.RevenueCat.CanGrant() {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusServiceUnavailable, "rc_unavailable", "RevenueCat grants aren't configured here."))
		return
	}
	g := &store.AdminGrant{UID: uid, Entitlement: req.Entitlement, EndsAt: ends.UTC(), GrantedBy: a.who(), Reason: reason, CreatedAt: now, State: "granting"}
	if err := s.Store.CreateAdminGrant(ctx, g); err != nil { // the record first: a grant never exists without one
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	gctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
	gerr := s.RevenueCat.GrantPromotional(gctx, uid, g.Entitlement, now, g.EndsAt)
	cancel()
	g, _ = s.Store.UpdateAdminGrant(ctx, g.ID, func(x *store.AdminGrant) error {
		x.State = "granted"
		if gerr != nil {
			x.State, x.RCError = "failed", gerr.Error()
		}
		return nil
	})
	s.audit(ctx, a, "grant_pro", map[string]any{"uid": uid, "grant_id": g.ID, "entitlement": g.Entitlement, "ends_at": g.EndsAt, "reason": reason, "ok": gerr == nil})
	if gerr != nil {
		slog.WarnContext(ctx, "admin grant failed", "uid", uid, "grant_id", g.ID, "entitlement", g.Entitlement, "err", gerr)
		writeJSON(w, http.StatusBadGateway, map[string]any{"error": "grant_failed", "message": "RevenueCat didn't take the grant: " + gerr.Error(), "grant": adminGrantJSON(g, now)})
		return
	}
	slog.InfoContext(ctx, "admin grant", "uid", uid, "grant_id", g.ID, "entitlement", g.Entitlement, "ends_at", g.EndsAt, "by", a.who())
	writeJSON(w, http.StatusCreated, map[string]any{"grant": adminGrantJSON(g, now)})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// DELETE /v1/admin/accounts/{uid}/grants/{id} {reason} (fresh sign-in)
// → {grant, regrant: {id, status, regranted, skipped}}.
func (s *Service) HandleAdminRevokeGrant(w http.ResponseWriter, r *http.Request, a *AdminUser, uid, id string) {
	ctx := r.Context()
	if !a.FreshAuth() {
		httpx.WriteErr(ctx, w, a.reauthErr())
		return
	}
	var req struct {
		Reason string `json:"reason"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req)
	reason := strings.TrimSpace(req.Reason)
	if reason == "" || utf8.RuneCountInString(reason) > 500 {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("reason: required, at most 500 characters"))
		return
	}
	g, err := s.Store.GetAdminGrant(ctx, id)
	if err != nil || g.UID != uid {
		httpx.WriteErr(ctx, w, httpx.ErrNotFound("grant"))
		return
	}
	now := time.Now().UTC()
	if st := g.Status(now); st != "active" {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "grant_not_active", "That grant is "+st+"."))
		return
	}
	// Marked first: the snapshot then leaves it out, and the revoke below
	// gives every other grant back.
	g, err = s.Store.UpdateAdminGrant(ctx, id, func(x *store.AdminGrant) error {
		if x.State == "revoked" {
			return errPromoSkip
		}
		x.State, x.RevokedAt, x.RevokedBy, x.RevokeReason = "revoked", &now, a.who(), reason
		return nil
	})
	if errors.Is(err, errPromoSkip) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "grant_not_active", "That grant is revoked."))
		return
	}
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	key := "revoke:" + id
	end := g.EndsAt
	s.promoStart(ctx, &store.PromoRegrant{UID: uid, Policy: promoPolicyOurs, Reason: fmt.Sprintf("admin revoke of grant %s: %s", id, reason),
		Revoked: []string{g.Entitlement}, Ours: []store.PromoGrant{{Entitlement: g.Entitlement, ExpiresAt: &end}}}, key)
	s.audit(ctx, a, "revoke_grant", map[string]any{"uid": uid, "grant_id": id, "entitlement": g.Entitlement, "reason": reason})
	slog.InfoContext(ctx, "admin grant revoked", "uid", uid, "grant_id", id, "entitlement", g.Entitlement, "by", a.who())
	out := map[string]any{"grant": adminGrantJSON(g, now)}
	if rec, err := s.Store.GetPromoRegrant(ctx, key); err == nil {
		out["regrant"] = map[string]any{"id": rec.ID, "status": rec.Status, "regranted": rec.Regranted, "skipped": rec.Skipped}
		if !(rec.Status == "done") {
			writeJSON(w, http.StatusAccepted, out) // the revoke or a re-grant failed: Slack has it, the nightly job retries
			return
		}
	}
	httpx.WriteOK(w, out)
}

// withAdminGrants adds the account's active admin grants of the
// entitlements being revoked that the RevenueCat snapshot doesn't show
// (collapsed under a later grant of the same product).
func (s *Service) withAdminGrants(ctx context.Context, uid string, ents []string, snap []store.PromoGrant) []store.PromoGrant {
	gs, err := s.Store.ListUserAdminGrants(ctx, uid, 200)
	if err != nil {
		return snap
	}
	now := time.Now().UTC()
	for _, g := range gs {
		if g.Status(now) != "active" || !containsStr(ents, g.Entitlement) {
			continue
		}
		end := g.EndsAt
		rec := store.PromoGrant{Entitlement: g.Entitlement, Product: "admin_grant:" + g.ID, ExpiresAt: &end}
		if !isOurs(rec, snap) { // isOurs: same entitlement, end within promoMatch
			snap = append(snap, rec)
		}
	}
	return snap
}

// GET /v1/admin/grants → {grants: [{id, uid, email, kind, granted_by,
// start, end, status, reason, revoked_at?, revoked_by?, revoke_reason?}]}:
// every Admin → Grant Pro grant, active ones first, then newest.
func (s *Service) HandleAdminAllGrants(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	gs, err := s.Store.ListAllAdminGrants(ctx, 2000)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	now := time.Now().UTC()
	sort.Slice(gs, func(i, j int) bool {
		ai, aj := gs[i].Status(now) == "active", gs[j].Status(now) == "active"
		if ai != aj {
			return ai
		}
		return gs[i].CreatedAt.After(gs[j].CreatedAt)
	})
	emails := map[string]string{}
	out := make([]map[string]any, 0, len(gs))
	for _, g := range gs {
		e, ok := emails[g.UID]
		if !ok {
			e = s.accountEmail(ctx, g.UID)
			emails[g.UID] = e
		}
		row := map[string]any{"id": g.ID, "uid": g.UID, "email": nilIfEmpty(e), "kind": g.Entitlement, "granted_by": g.GrantedBy,
			"start": g.CreatedAt, "end": g.EndsAt, "status": g.Status(now), "reason": g.Reason}
		if g.RevokedAt != nil {
			row["revoked_at"], row["revoked_by"], row["revoke_reason"] = g.RevokedAt, g.RevokedBy, g.RevokeReason
		}
		out = append(out, row)
	}
	s.audit(ctx, a, "grants_list", map[string]any{"count": len(out)})
	httpx.WriteOK(w, map[string]any{"grants": out})
}
