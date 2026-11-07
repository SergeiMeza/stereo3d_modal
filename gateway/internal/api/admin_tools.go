package api

import (
	"encoding/json"
	"net/http"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// POST /v1/admin/reconcile {since_hours (default 48, max 720), dry_run}
// → the M3 report. svs-admin `reconcile --since` calls the same function.
func (s *Service) HandleAdminReconcile(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	var req struct {
		SinceHours int  `json:"since_hours"`
		DryRun     bool `json:"dry_run"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.SinceHours <= 0 {
		req.SinceHours = 48
	}
	req.SinceHours = min(req.SinceHours, 720)
	if !req.DryRun && !a.FreshAuth() { // it can refund
		httpx.WriteErr(ctx, w, a.reauthErr())
		return
	}
	s.audit(ctx, a, "reconcile", map[string]any{"since_hours": req.SinceHours, "dry_run": req.DryRun})
	httpx.WriteOK(w, s.RunM3(ctx, time.Now().Add(-time.Duration(req.SinceHours)*time.Hour), req.DryRun))
}

// GET /v1/admin/blocklist → {cards}; POST {action: add|remove,
// fingerprint, note} → {cards}. Disputes and fraud warnings add cards by
// themselves (H, B11).
func (s *Service) HandleAdminBlocklist(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	if r.Method == http.MethodPost {
		var req struct {
			Action      string `json:"action"`
			Fingerprint string `json:"fingerprint"`
			Note        string `json:"note"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Fingerprint) == "" {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("fingerprint is required"))
			return
		}
		s.audit(ctx, a, "blocklist_"+req.Action, map[string]any{"fingerprint": req.Fingerprint})
		var err error
		switch req.Action {
		case "add":
			_, err = s.Store.BlockCard(ctx, store.BlockedCard{Fingerprint: strings.TrimSpace(req.Fingerprint), Reason: "manual", By: a.who(), Note: req.Note})
		case "remove":
			err = s.Store.UnblockCard(ctx, strings.TrimSpace(req.Fingerprint))
		default:
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("action is add or remove"))
			return
		}
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		resetBlockCache()
	}
	cards, err := s.Store.BlockedCards(ctx, 1000)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.WriteOK(w, map[string]any{"cards": cards})
}
