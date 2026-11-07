package api

import (
	"bytes"
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"google.golang.org/api/idtoken"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The app-path deletion hand-off (agreed with svs-app 2026-11-07). A
// deletion asked through svs-backend (keep_sign_in) that completes later —
// the 48-hour sweep, the console's "Process now", a decided refund case —
// leaves the Firebase user for svs-backend and tells it: POST
// <SVS_BACKEND_URL>/internal/v1/account/deletion-completed {uid,
// environment, requested_at, completed_at, via}, with a Google ID token
// from the gateway's service account (audience = that URL). A durable
// outbox (account_deletion_callbacks_{env}) retries with backoff until a
// 2xx, for 72 hours; GET /v1/internal/account-deletions is the backstop.
// A deletion that completes at once (0 h: prod until its release, and
// anonymous accounts) answers 200 deleted: true and needs no callback.

const (
	deletionCallbackPath   = "/internal/v1/account/deletion-completed"
	deletionCallbackLease  = 2 * time.Minute
	deletionCallbackWindow = 72 * time.Hour // at least 24 h of retries (agreed)
	deletionCallbackMaxGap = time.Hour
)

// Completion sources for the callback.
const (
	viaSweep      = "sweep"
	viaAdmin      = "admin"
	viaRefundCase = "refund_case"
)

// deletionCompleted queues (and tries once) the callback for an app-path
// deletion that just completed.
func (s *Service) deletionCompleted(ctx context.Context, uid string, requestedAt time.Time, via string) {
	now := time.Now().UTC()
	created, err := s.Store.EnqueueDeletionCallback(ctx, &store.DeletionCallback{UID: uid, Environment: s.Cfg.Env,
		RequestedAt: requestedAt.UTC(), CompletedAt: now, Via: via})
	if err != nil {
		slog.ErrorContext(ctx, "deletion callback not queued", "uid", uid, "err", err)
		s.Slack.Alert(ctx, "deletion_callback", fmt.Sprintf("account `%s`'s deletion completed (%s) but its svs-backend callback wasn't queued: %v", uid, via, err))
		return
	}
	if created {
		slog.InfoContext(ctx, "deletion callback queued", "uid", uid, "via", via)
		s.sendDeletionCallback(ctx, uid, now)
	}
}

// deletionCallbackSweep sends the due callbacks (cases sweep).
func (s *Service) deletionCallbackSweep(ctx context.Context) map[string]int {
	stats := map[string]int{}
	rows, err := s.Store.ListPendingDeletionCallbacks(ctx, 100)
	if err != nil {
		return stats
	}
	now := time.Now().UTC()
	for _, c := range rows {
		if now.Before(c.NextAttemptAt) {
			continue
		}
		switch s.sendDeletionCallback(ctx, c.UID, now) {
		case store.CallbackSent:
			stats["deletion_callbacks_sent"]++
		case store.CallbackFailed:
			stats["deletion_callbacks_failed"]++
		case store.CallbackPending:
			stats["deletion_callbacks_retrying"]++
		}
	}
	return stats
}

// sendDeletionCallback makes one leased attempt; the row's state after it
// ("" when not attempted).
func (s *Service) sendDeletionCallback(ctx context.Context, uid string, now time.Time) string {
	if s.Cfg.SVSBackendURL == "" {
		return "" // waits in the outbox until a target is configured
	}
	c, ok, err := s.Store.ClaimDeletionCallback(ctx, uid, now, deletionCallbackLease)
	if err != nil || !ok {
		return ""
	}
	body, _ := json.Marshal(map[string]any{"uid": c.UID, "environment": c.Environment,
		"requested_at": c.RequestedAt.UTC().Format(time.RFC3339), "completed_at": c.CompletedAt.UTC().Format(time.RFC3339), "via": c.Via})
	code, _, perr := s.postDeletionCallback(ctx, s.Cfg.SVSBackendURL+deletionCallbackPath, body)
	if perr == nil && code >= 200 && code < 300 {
		if err := s.Store.FinishDeletionCallback(ctx, uid, true, time.Time{}, "", false, time.Now().UTC()); err != nil {
			slog.WarnContext(ctx, "deletion callback sent, not marked", "uid", uid, "err", err)
		}
		slog.InfoContext(ctx, "deletion callback sent", "uid", uid, "via", c.Via, "attempts", c.Attempts)
		return store.CallbackSent
	}
	why := fmt.Sprintf("status %d", code)
	if perr != nil {
		why = perr.Error()
	}
	giveUp := time.Since(c.CompletedAt) > deletionCallbackWindow
	next := now.Add(callbackBackoff(c.Attempts))
	if err := s.Store.FinishDeletionCallback(ctx, uid, false, next, why, giveUp, now); err != nil {
		slog.WarnContext(ctx, "deletion callback outcome not saved", "uid", uid, "err", err)
	}
	slog.WarnContext(ctx, "deletion callback failed", "uid", uid, "attempts", c.Attempts, "err", why, "gave_up", giveUp)
	if giveUp {
		s.Slack.Alert(ctx, "deletion_callback", fmt.Sprintf("account `%s`'s deletion callback to svs-backend failed for %s (%s); the backstop read still lists it",
			uid, deletionCallbackWindow, why))
		return store.CallbackFailed
	}
	return store.CallbackPending
}

// callbackBackoff: 1, 2, 4 … minutes, at most an hour.
func callbackBackoff(attempts int) time.Duration {
	d := time.Minute
	for i := 1; i < attempts && d < deletionCallbackMaxGap; i++ {
		d *= 2
	}
	return min(d, deletionCallbackMaxGap)
}

func (s *Service) postDeletionCallback(ctx context.Context, url string, body []byte) (int, []byte, error) {
	if s.DeletionCallbackPost != nil {
		return s.DeletionCallbackPost(ctx, url, body)
	}
	client, err := idtoken.NewClient(ctx, s.Cfg.SVSBackendURL) // audience: svs-backend's URL
	if err != nil {
		return 0, nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<10))
	return resp.StatusCode, out, nil
}

// POST /internal/deletion-callback-probe {uid} (X-Reconcile-Token; test
// only): the hand-off's end-to-end check from the gateway's own service
// account. It refuses unless uid is unknown everywhere — no Firebase user
// (getUser not-found), no billing record, no deletion or callback row —
// then sends exactly one callback {via: "admin"} straight to svs-backend,
// outside the outbox, records it in the admin audit, and answers
// {status, response}.
func (s *Service) HandleDeletionCallbackProbe(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if s.Cfg.ReconcileToken == "" ||
		subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Reconcile-Token")), []byte(s.Cfg.ReconcileToken)) != 1 {
		httpx.WriteErr(ctx, w, httpx.ErrUnauthorized())
		return
	}
	if s.Cfg.Env != "test" || s.Cfg.SVSBackendURL == "" {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusForbidden, "probe_off", "the probe runs on test only, with a callback target"))
		return
	}
	var body struct {
		UID string `json:"uid"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&body); err != nil || body.UID == "" || len(body.UID) > 128 {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("uid is required"))
		return
	}
	uid := body.UID
	refuse := func(code, msg string) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, code, msg))
	}
	lookup := s.SignInLookup
	if lookup == nil && s.Auth != nil {
		lookup = s.Auth.SignInOf
	}
	if lookup == nil {
		refuse("no_auth", "can't check the uid against Firebase Auth")
		return
	}
	switch info, err := lookup(ctx, uid); {
	case err != nil:
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "auth_unreadable", "couldn't check the uid: "+err.Error()))
		return
	case info != nil:
		refuse("user_exists", "that uid has a Firebase user; the probe only takes an unknown uid")
		return
	}
	if _, err := s.Store.GetCustomer(ctx, uid); !errors.Is(err, store.ErrNotFound) {
		refuse("known_uid", "that uid has a billing record")
		return
	}
	if _, err := s.Store.GetAccountDeletion(ctx, uid); !errors.Is(err, store.ErrNotFound) {
		refuse("known_uid", "that uid has a deletion row")
		return
	}
	if _, err := s.Store.GetDeletionCallback(ctx, uid); !errors.Is(err, store.ErrNotFound) {
		refuse("known_uid", "that uid has a callback row")
		return
	}
	now := time.Now().UTC().Format(time.RFC3339)
	payload, _ := json.Marshal(map[string]any{"uid": uid, "environment": s.Cfg.Env, "requested_at": now, "completed_at": now, "via": viaAdmin})
	code, resp, err := s.postDeletionCallback(ctx, s.Cfg.SVSBackendURL+deletionCallbackPath, payload)
	out := map[string]any{"status": code}
	var parsed any
	if json.Unmarshal(resp, &parsed) == nil {
		out["response"] = parsed
	} else {
		out["response"] = string(resp)
	}
	if err != nil {
		out["error"] = err.Error()
	}
	s.audit(ctx, &AdminUser{UID: "operator", Email: "operator (reconcile token)"}, "deletion_callback_probe",
		map[string]any{"uid": uid, "status": code, "error": out["error"]})
	slog.InfoContext(ctx, "deletion callback probe", "uid", uid, "status", code)
	httpx.WriteOK(w, out)
}

// internalCaller answers the service account behind an internal route's
// Google ID token, if it's one we accept.
func (s *Service) internalCaller(r *http.Request) (string, error) {
	return s.internalCallerIn(r, s.Cfg.SVSBackendServiceAccounts)
}

// internalCallerIn answers the service account behind a Google ID token
// (audience: one of Cfg.InternalOIDCAudiences) when it is one of allowed;
// an empty allowed list accepts nobody.
func (s *Service) internalCallerIn(r *http.Request, allowed []string) (string, error) {
	tok, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || tok == "" {
		return "", errors.New("no bearer token")
	}
	var email string
	var err error
	if s.InternalCaller != nil {
		email, err = s.InternalCaller(r.Context(), tok)
	} else {
		email, err = s.validateGoogleToken(r.Context(), tok)
	}
	if err != nil {
		return "", err
	}
	if !slices.Contains(allowed, email) {
		return "", fmt.Errorf("service account not accepted")
	}
	return email, nil
}

func (s *Service) validateGoogleToken(ctx context.Context, tok string) (string, error) {
	for _, aud := range s.Cfg.InternalOIDCAudiences {
		p, err := idtoken.Validate(ctx, tok, aud)
		if err != nil {
			continue
		}
		email, _ := p.Claims["email"].(string)
		if v, _ := p.Claims["email_verified"].(bool); !v || email == "" {
			return "", errors.New("no verified email")
		}
		return email, nil
	}
	return "", errors.New("token not valid for this service")
}

// GET /v1/internal/account-deletions?state=completed&since=<RFC 3339> →
// [{uid, completed_at, via}], oldest first, at most 500: the app-path
// deletions that completed since then (the backstop for missed
// callbacks). Google ID token from svs-backend's service account only.
func (s *Service) HandleInternalDeletions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if _, err := s.internalCaller(r); err != nil {
		httpx.Log(ctx).Warn("internal deletions refused", "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusUnauthorized, "unauthenticated", "a Google ID token from an accepted service account is required"))
		return
	}
	q := r.URL.Query()
	if q.Get("state") != "completed" {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("state must be completed"))
		return
	}
	since, err := time.Parse(time.RFC3339, q.Get("since"))
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("since must be an RFC 3339 time"))
		return
	}
	rows, err := s.Store.ListCompletedDeletions(ctx, since, 500)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	out := make([]map[string]any, 0, len(rows))
	for _, c := range rows {
		out = append(out, map[string]any{"uid": c.UID, "completed_at": c.CompletedAt.UTC().Format(time.RFC3339), "via": c.Via})
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(out)
}
