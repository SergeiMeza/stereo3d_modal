package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Promotional Pro when a payment is refunded or disputed (owner
// 2026-11-04). RevenueCat can only revoke every promotional grant of an
// entitlement at once, and an account may hold grants from elsewhere
// (the SVS backend's campaigns, support goodwill in the RevenueCat
// dashboard) that we have no records of. So, before any revoke, the
// account's promotional grants are read from RevenueCat (the snapshot,
// stored on promo_regrants_{env}/{event} and on the dispute case), then:
//
//   - refund (revoke_ours): the entitlements the refunded purchase granted
//     are revoked, and every snapshotted grant except ours (our records:
//     the plan's entitlements and their end) is given back at once, each
//     to its original end. RevenueCat collapses grants of one entitlement
//     and duration into the latest; when the only pro entry is ours,
//     another grant may hide under it: promo_regrant_uncertain is logged
//     and the record marked for support.
//   - dispute opened or early fraud warning (revoke_all): every
//     promotional grant of every entitlement that gives Pro (pro,
//     business, studio, trial) is removed and the yearly plan's months
//     are held back (grants_paused). Won, withdrawn or a cleared review →
//     everything from the snapshot is given back to its original end
//     (expired ones skipped); lost → it stays removed until the owner
//     restores it (admin action restore_promo_grants, with a reason).
//
// Each step is idempotent per (account, event); a failure alerts Slack
// (promo_regrant_failed) and the nightly job picks the record up again.

const (
	promoPolicyOurs = "revoke_ours"
	promoPolicyAll  = "revoke_all"
	// promoMatch: how close a snapshot entry's end must be to our record's
	// to be ours (we grant with end_time_ms, so it is exact in practice).
	promoMatch = 10 * time.Minute
)

// promoAllEntitlements are what a dispute removes: every entitlement that
// makes the app Pro.
var promoAllEntitlements = []string{"pro", pricing.TierBusiness, pricing.TierStudio, "trial"}

// disputePromoPolicy: what an early end does to promotional grants.
func disputePromoPolicy(why string) string {
	switch why {
	case "dispute", "fraud warning":
		return promoPolicyAll
	}
	return promoPolicyOurs
}

// ourPlanGrants: the grants our records say the plan holds (withPro: a
// Business or Studio plan's pro grant too).
func ourPlanGrants(p *store.Plan, withPro bool) []store.PromoGrant {
	if p == nil {
		return nil
	}
	var ents []string
	switch p.Tier {
	case pricing.TierPro:
		ents = []string{"pro"}
	case pricing.TierBusiness, pricing.TierStudio:
		ents = []string{p.Tier}
		if withPro {
			ents = append(ents, "pro")
		}
	}
	out := make([]store.PromoGrant, 0, len(ents))
	for _, e := range ents {
		out = append(out, store.PromoGrant{Entitlement: e, ExpiresAt: p.RCGrantedUntil})
	}
	return out
}

func isOurs(g store.PromoGrant, ours []store.PromoGrant) bool {
	for _, o := range ours {
		if o.Entitlement != g.Entitlement || o.ExpiresAt == nil || g.ExpiresAt == nil {
			continue
		}
		if d := g.ExpiresAt.Sub(*o.ExpiresAt); d <= promoMatch && d >= -promoMatch {
			return true
		}
	}
	return false
}

func grantsText(gs []store.PromoGrant) string {
	if len(gs) == 0 {
		return "none"
	}
	parts := make([]string, 0, len(gs))
	for _, g := range gs {
		end := "lifetime"
		if g.ExpiresAt != nil {
			end = "until " + g.ExpiresAt.UTC().Format("2 Jan 2006 15:04")
		}
		parts = append(parts, g.Entitlement+" "+end)
	}
	return strings.Join(parts, ", ")
}

// promoRevokeOurs revokes the plan's grants (withPro: its pro grant too)
// and gives every other promotional grant back. key names the event.
func (s *Service) promoRevokeOurs(ctx context.Context, uid, key, reason string, withPro bool) {
	if s.Store == nil || uid == "" {
		return
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || (cust.Plan.Tier != pricing.TierBusiness && cust.Plan.Tier != pricing.TierStudio && cust.Plan.Tier != pricing.TierPro) {
		return
	}
	if !s.RevenueCat.CanGrant() {
		slog.WarnContext(ctx, "plan entitlement not revoked: no RevenueCat secret key", "uid", uid, "reason", reason)
		return
	}
	ours := ourPlanGrants(cust.Plan, withPro)
	ents := make([]string, 0, len(ours))
	for _, g := range ours {
		ents = append(ents, g.Entitlement)
	}
	s.promoStart(ctx, &store.PromoRegrant{UID: uid, Policy: promoPolicyOurs, Reason: reason, Revoked: ents, Ours: ours}, key)
}

// promoHold removes every promotional Pro grant for a dispute or fraud
// warning (key dispute:{id} | efw:{id}) until it is resolved.
func (s *Service) promoHold(ctx context.Context, uid, key, reason string, amount int64, caseID string) {
	if s.Store == nil || uid == "" {
		return
	}
	if !s.RevenueCat.CanGrant() {
		slog.WarnContext(ctx, "promotional grants not removed: no RevenueCat secret key", "uid", uid, "event", key)
		return
	}
	s.promoStart(ctx, &store.PromoRegrant{UID: uid, Policy: promoPolicyAll, Reason: reason, Revoked: promoAllEntitlements,
		AmountCents: amount, CaseID: caseID}, key)
}

// promoStart's outcomes: a new record, an unfinished one taken up again,
// or nothing to do (a second delivery of a finished event, or no record).
const (
	promoNew = iota
	promoResumed
	promoNothing
)

func (s *Service) promoStart(ctx context.Context, r *store.PromoRegrant, key string) int {
	r.Status = "started"
	rec, created, err := s.Store.CreatePromoRegrant(ctx, key, r)
	if err != nil {
		s.Slack.Alert(ctx, "promo_regrant_failed", fmt.Sprintf("promo record %s for `%s` not written: %v", key, r.UID, err))
		return promoNothing
	}
	if !created && !retryablePromo(rec.Status) {
		return promoNothing // a second delivery of the same event
	}
	s.promoAdvance(ctx, rec)
	if created {
		return promoNew
	}
	return promoResumed
}

func retryablePromo(st string) bool {
	switch st {
	case "started", "snapshot_failed", "snapshotted", "revoke_failed", "regranting", "regrant_failed":
		return true
	}
	return false
}

// promoRetryAfter: the nightly job leaves records this fresh alone (a
// webhook may still be working on them).
var promoRetryAfter = 10 * time.Minute

var errPromoSkip = errors.New("promo: nothing to do")

// promoAdvance takes a record from where it stopped to its next resting
// state (held, done, or a failure the nightly job retries).
func (s *Service) promoAdvance(ctx context.Context, rec *store.PromoRegrant) {
	ctx = context.WithoutCancel(ctx) // the steps must finish when a webhook caller has gone
	key := rec.ID
	if rec.Status == "started" || rec.Status == "snapshot_failed" {
		grants, err := s.RevenueCat.PromotionalGrants(ctx, rec.UID)
		if err != nil {
			s.promoFail(ctx, key, "snapshot_failed", "RevenueCat read before the revoke", err)
			return
		}
		snap := make([]store.PromoGrant, 0, len(grants))
		for _, g := range grants {
			snap = append(snap, store.PromoGrant{Entitlement: g.Entitlement, Product: g.Product, ExpiresAt: g.ExpiresAt})
		}
		// Support grants (Admin → Grant Pro) RevenueCat's collapsed view hides.
		snap = s.withAdminGrants(ctx, rec.UID, rec.Revoked, snap)
		if rec, err = s.Store.UpdatePromoRegrant(ctx, key, func(r *store.PromoRegrant) error {
			if r.Status != "started" && r.Status != "snapshot_failed" {
				return errPromoSkip
			}
			r.Snapshot, r.Status, r.Attempts = snap, "snapshotted", r.Attempts+1
			return nil
		}); err != nil {
			return
		}
		s.linkPromoCase(ctx, rec)
	}
	if rec.Status == "snapshotted" || rec.Status == "revoke_failed" {
		rctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		var err error
		for _, e := range rec.Revoked {
			if err = s.RevenueCat.RevokeAnyPromotionals(rctx, rec.UID, e); err != nil {
				err = fmt.Errorf("%s: %w", e, err)
				break
			}
		}
		cancel()
		if err != nil {
			s.promoFail(ctx, key, "revoke_failed", "revoke", err)
			return
		}
		now := time.Now().UTC()
		var uncertain []string
		if rec, err = s.Store.UpdatePromoRegrant(ctx, key, func(r *store.PromoRegrant) error {
			if r.Status != "snapshotted" && r.Status != "revoke_failed" {
				return errPromoSkip
			}
			r.RevokedAt, r.LastError = &now, ""
			if r.Policy == promoPolicyAll {
				r.Status = "held"
				return nil
			}
			r.ToGrant, r.Status, r.Outcome = nil, "regranting", "refund"
			for _, g := range r.Snapshot {
				if !containsStr(r.Revoked, g.Entitlement) || isOurs(g, r.Ours) {
					continue // not revoked, or the refunded purchase's own
				}
				r.ToGrant = append(r.ToGrant, g)
			}
			// RevenueCat collapses grants of one product into the latest:
			// when ours is the only pro entry, another grant may hide under
			// it (business and studio are granted by the gateway alone).
			for _, o := range r.Ours {
				if o.Entitlement != "pro" {
					continue
				}
				mine, others := 0, 0
				for _, g := range r.Snapshot {
					if g.Entitlement != o.Entitlement {
						continue
					}
					if isOurs(g, r.Ours) {
						mine++
					} else {
						others++
					}
				}
				if mine > 0 && others == 0 {
					uncertain = append(uncertain, o.Entitlement)
				}
			}
			r.Uncertain = len(uncertain) > 0
			return nil
		}); err != nil {
			return
		}
		s.promoMarkPlanRevoked(ctx, rec)
		if rec.Policy == promoPolicyOurs {
			s.clearWebPlan(ctx, rec.UID) // D14: web_plan "none" once the revoke went through, never before
		}
		if len(uncertain) > 0 {
			slog.WarnContext(ctx, "promo_regrant_uncertain", "uid", rec.UID, "event", key, "entitlements", uncertain,
				"note", "the refunded grant is the only promotional entry RevenueCat shows; a grant of the same product may hide under it")
		}
		if rec.Status == "held" {
			s.linkPromoCase(ctx, rec)
			s.Slack.Alert(ctx, "promo_grants_removed", fmt.Sprintf("%s on `%s` (%s): promotional Pro removed until it is resolved: %s",
				promoEventName(key), rec.UID, money(rec.AmountCents), grantsText(activeGrants(rec.Snapshot, now))))
			return
		}
	}
	if rec.Status == "regranting" || rec.Status == "regrant_failed" {
		s.promoGrantPending(ctx, rec)
	}
}

func activeGrants(gs []store.PromoGrant, now time.Time) []store.PromoGrant {
	var out []store.PromoGrant
	for _, g := range gs {
		if g.ExpiresAt == nil || g.ExpiresAt.After(now) {
			out = append(out, g)
		}
	}
	return out
}

func containsStr(xs []string, x string) bool {
	for _, v := range xs {
		if v == x {
			return true
		}
	}
	return false
}

func promoEventName(key string) string {
	kind, id, _ := strings.Cut(key, ":")
	switch kind {
	case "dispute":
		return "dispute " + id
	case "efw":
		return "early fraud warning " + id
	case "refund":
		return "refund of " + id
	}
	return key
}

// promoGrantPending gives back every grant still in ToGrant, each to its
// original end; expired ones are skipped.
func (s *Service) promoGrantPending(ctx context.Context, rec *store.PromoRegrant) {
	now := time.Now().UTC()
	gctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	var done, left, skipped []store.PromoGrant
	for _, g := range rec.ToGrant {
		g.Error = ""
		if g.ExpiresAt != nil && !g.ExpiresAt.After(now) {
			skipped = append(skipped, g)
			continue
		}
		if err := s.RevenueCat.GrantPromotionalUntil(gctx, rec.UID, g.Entitlement, g.ExpiresAt); err != nil {
			g.Error = err.Error()
			left = append(left, g)
			continue
		}
		slog.InfoContext(ctx, "promo regranted", "uid", rec.UID, "event", rec.ID, "entitlement", g.Entitlement, "product", g.Product, "expires_at", g.ExpiresAt)
		done = append(done, g)
	}
	st := "done"
	if len(left) > 0 {
		st = "regrant_failed"
	}
	rec, err := s.Store.UpdatePromoRegrant(ctx, rec.ID, func(r *store.PromoRegrant) error {
		if r.Status != "regranting" && r.Status != "regrant_failed" {
			return errPromoSkip
		}
		r.Regranted = append(r.Regranted, done...)
		r.Skipped = append(r.Skipped, skipped...)
		r.ToGrant, r.Status, r.Attempts = left, st, r.Attempts+1
		r.LastError = ""
		if len(left) > 0 {
			r.LastError = left[0].Error
		}
		return nil
	})
	if err != nil {
		return
	}
	s.linkPromoCase(ctx, rec)
	if len(left) > 0 {
		s.Slack.Alert(ctx, "promo_regrant_failed", fmt.Sprintf("%s on `%s`: %d promotional grant(s) not given back (%s): %s; the nightly job retries",
			promoEventName(rec.ID), rec.UID, len(left), grantsText(left), left[0].Error))
	}
}

func (s *Service) promoFail(ctx context.Context, key, st, step string, err error) {
	rec, uerr := s.Store.UpdatePromoRegrant(ctx, key, func(r *store.PromoRegrant) error {
		r.Status, r.LastError, r.Attempts = st, err.Error(), r.Attempts+1
		return nil
	})
	uid := ""
	if uerr == nil {
		uid = rec.UID
	}
	s.Slack.Alert(ctx, "promo_regrant_failed", fmt.Sprintf("%s on `%s`: %s failed: %v; the nightly job retries", promoEventName(key), uid, step, err))
}

// promoMarkPlanRevoked records the revoke on the plan when its
// entitlement went (so M3 doesn't grant it again).
func (s *Service) promoMarkPlanRevoked(ctx context.Context, rec *store.PromoRegrant) {
	now := time.Now().UTC()
	s.Store.UpdateCustomer(ctx, rec.UID, func(c *store.Customer) error {
		if c.Plan == nil {
			return errPromoSkip
		}
		ent := c.Plan.Tier
		if ent != pricing.TierPro && ent != pricing.TierBusiness && ent != pricing.TierStudio {
			return errPromoSkip
		}
		if !containsStr(rec.Revoked, ent) {
			return errPromoSkip
		}
		c.Plan.RCRevokedAt, c.Plan.RCRevokeReason, c.Plan.RCGrantInvoice = &now, rec.Reason, ""
		return nil
	})
	slog.InfoContext(ctx, "promotional grants revoked", "uid", rec.UID, "event", rec.ID, "entitlements", rec.Revoked, "policy", rec.Policy)
}

// linkPromoCase keeps the dispute case's copy of the snapshot current.
func (s *Service) linkPromoCase(ctx context.Context, rec *store.PromoRegrant) {
	if rec == nil || rec.CaseID == "" {
		return
	}
	s.Store.UpdateCase(ctx, rec.CaseID, "system", func(c *store.Case) error {
		c.Promo = &store.CasePromo{RecordID: rec.ID, Snapshot: rec.Snapshot, Status: rec.Status}
		return nil
	})
}

// promoResolve ends a hold (key dispute:{id} | efw:{id}): won, withdrawn
// or cleared → everything from the snapshot back to its original end;
// lost → stays removed. A second delivery does nothing.
func (s *Service) promoResolve(ctx context.Context, key, outcome string) {
	if s.Store == nil {
		return
	}
	rec, err := s.Store.GetPromoRegrant(ctx, key)
	if err != nil || rec.Status != "held" {
		return
	}
	ctx = context.WithoutCancel(ctx)
	now := time.Now().UTC()
	if outcome == "lost" {
		rec, err = s.Store.UpdatePromoRegrant(ctx, key, func(r *store.PromoRegrant) error {
			if r.Status != "held" {
				return errPromoSkip
			}
			r.Status, r.Outcome, r.ResolvedAt = "kept_removed", "lost", &now
			return nil
		})
		if err != nil {
			return
		}
		s.linkPromoCase(ctx, rec)
		s.Slack.Alert(ctx, "promo_grants_kept_removed", fmt.Sprintf("%s on `%s` (%s) lost: promotional Pro stays removed (%s); restoring needs the owner (admin: Restore promotional grants)",
			promoEventName(key), rec.UID, money(rec.AmountCents), grantsText(activeGrants(rec.Snapshot, now))))
		return
	}
	// Another dispute or warning still open on the account: its hold
	// takes these grants too, and gives them back when it ends.
	if other := s.otherPromoHold(ctx, rec.UID, key); other != nil {
		if _, err := s.Store.UpdatePromoRegrant(ctx, other.ID, func(r *store.PromoRegrant) error {
			r.Snapshot = mergeGrants(r.Snapshot, rec.Snapshot)
			return nil
		}); err != nil {
			return
		}
		rec, err = s.Store.UpdatePromoRegrant(ctx, key, func(r *store.PromoRegrant) error {
			if r.Status != "held" {
				return errPromoSkip
			}
			r.Status, r.Outcome, r.MergedInto, r.ResolvedAt = "merged", outcome, other.ID, &now
			return nil
		})
		if err == nil {
			s.linkPromoCase(ctx, rec)
			s.Slack.Alert(ctx, "promo_grants_still_held", fmt.Sprintf("%s on `%s` %s, but %s is still open: promotional Pro stays removed until it ends",
				promoEventName(key), rec.UID, outcome, promoEventName(other.ID)))
		}
		return
	}
	s.promoGiveBack(ctx, key, outcome, "", "")
}

// casePromoRestored appends the owner's restore to the dispute case, which
// is closed by then (lost): the one write a closed case takes, once per
// restore.
func (s *Service) casePromoRestored(ctx context.Context, rec *store.PromoRegrant, who, note string, at time.Time) {
	list := func(gs []store.PromoGrant) []map[string]any {
		out := make([]map[string]any, 0, len(gs))
		for _, g := range gs {
			out = append(out, map[string]any{"entitlement": g.Entitlement, "ends_at": g.ExpiresAt})
		}
		return out
	}
	restoreID := "promo_restored_" + strings.ReplaceAll(rec.ID, ":", "_")
	e := store.CaseEvent{At: at, Who: who, Kind: store.CaseEventPromoRestored,
		Text: fmt.Sprintf("promotional Pro restored by %s: %s", who, note),
		Data: map[string]any{"type": store.CaseEventPromoRestored, "by": who, "at": at, "reason": note, "restore_id": restoreID,
			"regranted": list(rec.Regranted), "skipped": list(rec.Skipped)}}
	if _, err := s.Store.AppendClosedCaseEvent(ctx, rec.CaseID, restoreID, e); err != nil {
		slog.WarnContext(ctx, "promo restore not added to the case", "case_id", rec.CaseID, "err", err)
	}
}

// promoGiveBack re-grants a held or kept-removed record's snapshot.
func (s *Service) promoGiveBack(ctx context.Context, key, outcome, who, note string) *store.PromoRegrant {
	now := time.Now().UTC()
	rec, err := s.Store.UpdatePromoRegrant(ctx, key, func(r *store.PromoRegrant) error {
		if r.Status != "held" && !(outcome == "restored" && r.Status == "kept_removed") {
			return errPromoSkip
		}
		r.ToGrant, r.Status, r.Outcome, r.ResolvedAt = append([]store.PromoGrant(nil), r.Snapshot...), "regranting", outcome, &now
		r.RestoredBy, r.RestoreNote = who, note
		return nil
	})
	if err != nil {
		return nil
	}
	s.promoGrantPending(ctx, rec)
	s.Store.UpdateCustomer(ctx, rec.UID, func(c *store.Customer) error { // M3 looks after the plan's grant again
		if c.Plan == nil || c.Plan.RCRevokedAt == nil || c.Plan.RCRevokeReason != rec.Reason {
			return errPromoSkip
		}
		c.Plan.RCRevokedAt, c.Plan.RCRevokeReason = nil, ""
		return nil
	})
	got, _ := s.Store.GetPromoRegrant(ctx, key)
	if got == nil {
		got = rec
	}
	s.Slack.Alert(ctx, "promo_grants_restored", fmt.Sprintf("%s on `%s` (%s) %s: promotional Pro given back: %s; expired, skipped: %s",
		promoEventName(key), rec.UID, money(rec.AmountCents), outcome, grantsText(got.Regranted), grantsText(got.Skipped)))
	if outcome == "restored" && got.CaseID != "" {
		s.casePromoRestored(ctx, got, who, note, now)
	}
	return got
}

func mergeGrants(a, b []store.PromoGrant) []store.PromoGrant {
	out := append([]store.PromoGrant(nil), a...)
	for _, g := range b {
		dup := false
		for _, h := range out {
			if h.Entitlement == g.Entitlement && h.Product == g.Product && sameEnd(h.ExpiresAt, g.ExpiresAt) {
				dup = true
			}
		}
		if !dup {
			out = append(out, g)
		}
	}
	return out
}

func sameEnd(a, b *time.Time) bool {
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return a.Equal(*b)
}

func (s *Service) otherPromoHold(ctx context.Context, uid, except string) *store.PromoRegrant {
	recs, err := s.Store.ListUserPromoRegrants(ctx, uid, 200)
	if err != nil {
		return nil
	}
	for _, r := range recs {
		if r.ID != except && r.Policy == promoPolicyAll && (r.Status == "held" || r.Status == "started" || r.Status == "snapshotted" ||
			r.Status == "snapshot_failed" || r.Status == "revoke_failed") {
			return r
		}
	}
	return nil
}

// promoHeldFor: an open hold on the account (a plan invoice paid
// meanwhile adds its grants to it instead of granting them).
func (s *Service) promoHeldFor(ctx context.Context, uid string) *store.PromoRegrant {
	return s.otherPromoHold(ctx, uid, "")
}

// promoResolveEFWs ends every fraud-warning hold on the account (the
// review was cleared).
func (s *Service) promoResolveEFWs(ctx context.Context, uid string) {
	recs, err := s.Store.ListUserPromoRegrants(ctx, uid, 200)
	if err != nil {
		return
	}
	for _, r := range recs {
		if strings.HasPrefix(r.ID, "efw:") && r.Status == "held" {
			s.promoResolve(ctx, r.ID, "cleared")
		}
	}
}

// promoRestore is the owner's admin action: every hold or kept-removed
// record on the account gives its snapshot back.
func (s *Service) promoRestore(ctx context.Context, uid, who, note string) []*store.PromoRegrant {
	recs, err := s.Store.ListUserPromoRegrants(ctx, uid, 200)
	if err != nil {
		return nil
	}
	var out []*store.PromoRegrant
	for _, r := range recs {
		if r.Status != "kept_removed" && r.Status != "held" {
			continue
		}
		if got := s.promoGiveBack(ctx, r.ID, "restored", who, note); got != nil {
			out = append(out, got)
		}
	}
	return out
}

// m3PromoRegrants: records a failure left behind are taken up again.
func (s *Service) m3PromoRegrants(ctx context.Context, rep *M3Report, dryRun bool) {
	recs, err := s.Store.ListPromoRegrantsByStatus(ctx, append(store.PromoRetryStatuses, "snapshotted", "regranting"), 200)
	if err != nil {
		rep.fail("promo regrants", err)
		return
	}
	for _, r := range recs {
		if time.Since(r.UpdatedAt) < promoRetryAfter {
			continue // maybe still in flight
		}
		f := M3Flag{Flag: "promo_regrant_retry", Ref: r.ID, UID: r.UID, Detail: r.Status + ": " + r.LastError}
		if !dryRun {
			s.promoAdvance(ctx, r)
			if got, gerr := s.Store.GetPromoRegrant(ctx, r.ID); gerr == nil {
				f.Action = "now " + got.Status
			}
		}
		rep.add(f)
	}
}

// promoGrantsJSON: the account's records for the admin view.
func (s *Service) promoGrantsJSON(ctx context.Context, uid string) []*store.PromoRegrant {
	recs, err := s.Store.ListUserPromoRegrants(ctx, uid, 100)
	if err != nil {
		return nil
	}
	return recs
}
