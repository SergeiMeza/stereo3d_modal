package api

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"path"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// GET /internal/holdings/{uid} (svs-backend only, 2026-11-06): what the
// gateway holds for an account, as counts, for the app's account-switch
// bookkeeping. Only with X-SVS-Proxy-Key (no user token); without it, or
// with a wrong one, a plain 404 like any unknown path. Its own rate limit;
// the uid is logged as a hash only. A uid with nothing answers zeros.
const holdingsPerHour = 1200

func (s *Service) HandleHoldings(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if !httpx.ProxyAuthenticated(ctx) {
		http.NotFound(w, r)
		return
	}
	uid := r.PathValue("uid")
	if uid == "" || len(uid) > 128 {
		http.NotFound(w, r)
		return
	}
	if !eventAllowed("holdings:"+clientIP(r), holdingsPerHour, time.Now()) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusTooManyRequests, "rate_limited", "too many holdings reads"))
		return
	}
	sum := sha256.Sum256([]byte(uid))
	uidHash := hex.EncodeToString(sum[:6])

	out := map[string]any{"customer": false, "conversions": 0, "billing_batches_pending": 0, "billing_batches_failed": 0,
		"projects": 0, "image_quota": false, "files": 0, "promo_grants_active": 0, "balance_cents": int64(0)}
	fail := func(what string, err error) {
		httpx.Log(ctx).Warn("holdings read failed", "uid_hash", uidHash, "what", what, "err", err)
		httpx.WriteErr(ctx, w, httpx.ErrServer())
	}
	if _, err := s.Store.GetCustomer(ctx, uid); err == nil {
		out["customer"] = true
	} else if !errors.Is(err, store.ErrNotFound) {
		fail("customer", err)
		return
	}
	n, err := s.Store.CountUserConversions(ctx, uid)
	if err != nil {
		fail("conversions", err)
		return
	}
	out["conversions"] = n
	pending := 0
	for _, st := range []string{store.BatchOpen, store.BatchCharging, store.BatchSettling} {
		bs, err := s.Store.ListUserBatchesByState(ctx, uid, st, 100)
		if err != nil {
			fail("batches", err)
			return
		}
		pending += len(bs)
	}
	out["billing_batches_pending"] = pending
	failed, err := s.Store.ListUserBatchesByState(ctx, uid, store.BatchFailed, 100)
	if err != nil {
		fail("batches", err)
		return
	}
	out["billing_batches_failed"] = len(failed)
	projects, err := s.Store.ListUserProjects(ctx, uid, 1000)
	if err != nil {
		fail("projects", err)
		return
	}
	np := 0
	for _, p := range projects {
		if !p.Sample && !p.Deleted {
			np++
		}
	}
	out["projects"] = np
	if q, err := s.Store.HasImageQuota(ctx, uid); err != nil {
		fail("image quota", err)
		return
	} else {
		out["image_quota"] = q
	}
	if s.GCS != nil {
		keys, err := s.GCS.List(ctx, path.Join(s.GCS.Prefix(), "users", uid)+"/")
		if err != nil {
			fail("files", err)
			return
		}
		out["files"] = len(keys)
	}
	grants, err := s.Store.ListUserAdminGrants(ctx, uid, 200)
	if err != nil {
		fail("grants", err)
		return
	}
	active, now := 0, time.Now()
	for _, g := range grants {
		if g.Status(now) == "active" {
			active++
		}
	}
	out["promo_grants_active"] = active
	if b, err := s.Store.GetBalance(ctx, uid); err == nil && b.Exists() {
		out["balance_cents"] = b.Available()
	}
	httpx.Log(ctx).Info("holdings read", "uid_hash", uidHash)
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, out)
}
