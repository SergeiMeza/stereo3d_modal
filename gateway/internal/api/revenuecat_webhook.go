package api

import (
	"crypto/subtle"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
)

// POST /webhooks/revenuecat: RevenueCat tells us a subscriber changed (a
// purchase, renewal, cancellation, expiry, transfer in the app's stores),
// so the gateway forgets its cached answer for every account the event
// names and asks again, keeping pro_state current. Authorized by the
// header set in the RevenueCat dashboard (REVENUECAT_WEBHOOK_AUTH); 503
// without one. Anonymous RevenueCat ids are skipped; nothing about the
// people is logged.
func (s *Service) HandleRevenueCatWebhook(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	want := s.Cfg.RevenueCatWebhookAuth
	if want == "" {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusServiceUnavailable, "webhook_not_configured", "revenuecat webhook is off"))
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(want)) != 1 {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusUnauthorized, "unauthorized", "bad webhook authorization"))
		return
	}
	var body struct {
		Event struct {
			Type            string   `json:"type"`
			AppUserID       string   `json:"app_user_id"`
			OriginalAppUser string   `json:"original_app_user_id"`
			Aliases         []string `json:"aliases"`
			TransferredFrom []string `json:"transferred_from"`
			TransferredTo   []string `json:"transferred_to"`
			EntitlementIDs  []string `json:"entitlement_ids"`
			Store           string   `json:"store"`
			Environment     string   `json:"environment"`
		} `json:"event"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&body); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed event"))
		return
	}
	e := body.Event
	ids := rcAccountIDs(append(append(append([]string{e.AppUserID, e.OriginalAppUser}, e.Aliases...), e.TransferredFrom...), e.TransferredTo...))
	refreshed := 0
	for _, uid := range ids {
		s.RevenueCat.Forget(uid)
		st, err := s.RevenueCat.Fresh(ctx, uid)
		if err != nil {
			continue
		}
		s.noteProSeen(ctx, uid, st.Pro && st.Tier == "")
		s.ensureProCredit(ctx, uid) // a purchase, renewal, refund or transfer: this month's Pro credit
		refreshed++
	}
	slog.InfoContext(ctx, "revenuecat event", "type", e.Type, "store", e.Store, "environment", e.Environment,
		"accounts", len(ids), "refreshed", refreshed)
	httpx.WriteOK(w, map[string]any{"received": true, "accounts": len(ids)})
}

// rcAccountIDs: the event's ids that can be our accounts (not
// RevenueCat's anonymous ones), once each, at most 10.
func rcAccountIDs(all []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, id := range all {
		if id == "" || strings.HasPrefix(id, "$RCAnonymousID") || seen[id] || len(out) == 10 {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	return out
}
