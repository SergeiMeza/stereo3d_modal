package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// RevenueCat subscriber attributes from the gateway (owner 2026-11-07).
// RevenueCat is ONE shared project (the app's prod data, TEST reads it
// too), so writes go only where rc_attr_sync allows: off prod, the uids in
// rc_attr_allow_uids (every other account is a dry run that logs the
// names it would send); on prod nothing until the release turns it on.
//
// The gateway owns the web_* attributes. The app owns $email,
// $displayName, newsletter, locale, free_tier_arm, svs_simulated,
// delete_account and every $ attribution attribute: never written, except
// $email and $displayName when the customer has no value yet (web-only
// customers; read first). No IPs, tokens or payment details; the web
// stores no marketing consent, so none is sent. Changes are debounced
// (rcAttrDebounce) and sent by the reconcile sweep, only the attributes
// that changed. A completed deletion clears the web_* attributes, never
// delete_account or newsletter (svs-backend sets that flag).

// rcAttrDebounce: changes wait this long (a variable for tests).
var rcAttrDebounce = time.Minute

const (
	rcAttrLease     = 2 * time.Minute
	rcAttrActiveGap = 6 * time.Hour
)

// rcWebAttrs are the gateway's own attributes.
var rcWebAttrs = []string{"web_email", "web_display_name", "web_account_created_at", "web_sign_in_methods", "web_country", "web_locale",
	"web_plan", "web_plan_renews_at", "web_lifetime_spend_usd", "web_credit_balance_usd", "web_last_active_at"}

// rcPersonal are kept as hashes in the sync record, never in clear.
var rcPersonal = map[string]bool{"web_email": true, "web_display_name": true, "$email": true, "$displayName": true}

func (s *Service) rcAttrMode(ctx context.Context) string {
	if s.Pricing == nil || s.Store == nil || !s.RevenueCat.CanGrant() {
		return "off"
	}
	return s.Pricing.Rates(ctx).RCAttrMode(s.Cfg.Env)
}

// rcAttrsTouch marks uid's attributes due (debounced). Never fails the
// caller.
func (s *Service) rcAttrsTouch(ctx context.Context, uid, reason string) {
	s.rcAttrsTouchWith(ctx, uid, reason, nil)
}

func (s *Service) rcAttrsTouchWith(ctx context.Context, uid, reason string, extra map[string]any) {
	if uid == "" || s.rcAttrMode(ctx) == "off" {
		return
	}
	if err := s.Store.TouchRCAttrs(context.WithoutCancel(ctx), uid, reason, time.Now().UTC().Add(rcAttrDebounce), extra); err != nil {
		slog.WarnContext(ctx, "rc attributes not marked", "reason", reason, "err", err)
	}
}

var rcActiveSeen sync.Map // uid → last time marked on this instance

// rcAttrsActive notes a web visit (at most every 6 h per instance): when,
// and the edge's country (never the IP).
func (s *Service) rcAttrsActive(ctx context.Context, r *http.Request, uid string) {
	now := time.Now().UTC()
	if v, ok := rcActiveSeen.Load(uid); ok && now.Sub(v.(time.Time)) < rcAttrActiveGap {
		return
	}
	rcActiveSeen.Store(uid, now)
	extra := map[string]any{"last_active_at": now}
	if c := requestCountry(r); c != "" {
		extra["country"] = c
	}
	s.rcAttrsTouchWith(ctx, uid, "active", extra)
}

// rcAttrsClear removes the web_* attributes once the deletion completed.
func (s *Service) rcAttrsClear(ctx context.Context, uid string) {
	if uid == "" || s.rcAttrMode(ctx) == "off" {
		return
	}
	if err := s.Store.TouchRCAttrs(context.WithoutCancel(ctx), uid, "deleted", time.Now().UTC(), map[string]any{"clear": true}); err != nil {
		slog.WarnContext(ctx, "rc attributes clear not marked", "err", err)
	}
}

// rcAttrsOf is the account's web_* attributes now ("" = none, removed).
func (s *Service) rcAttrsOf(ctx context.Context, uid string, rec *store.RCAttrSync) map[string]string {
	out := map[string]string{}
	for _, k := range rcWebAttrs {
		out[k] = ""
	}
	iso := func(t time.Time) string {
		if t.IsZero() {
			return ""
		}
		return t.UTC().Format(time.RFC3339)
	}
	if admin := s.identities(); admin != nil {
		if id, err := admin.IdentityOf(ctx, uid); err == nil && id != nil {
			out["web_email"] = strings.TrimSpace(id.Email)
			out["web_display_name"] = strings.TrimSpace(id.DisplayName)
			out["web_account_created_at"] = iso(id.CreatedAt)
			methods := signInMethods(id)
			if n, err := s.passkeyCount(ctx, uid); err == nil && n > 0 {
				methods = append(methods, "passkey")
			}
			sort.Strings(methods)
			out["web_sign_in_methods"] = strings.Join(methods, ",")
		}
	}
	out["web_plan"] = "none"
	if cust, err := s.Store.GetCustomer(ctx, uid); err == nil && cust != nil {
		out["web_locale"] = cust.Locale
		out["web_lifetime_spend_usd"] = fmt.Sprintf("%.2f", float64(cust.LifetimePaidCents)/100)
		if p := cust.Plan; p != nil && p.Active(time.Now()) {
			out["web_plan"] = publicPlanID(p.Key())
			if planRenewing(cust) && p.CurrentPeriodEnd != nil {
				out["web_plan_renews_at"] = iso(*p.CurrentPeriodEnd)
			}
		}
	}
	if b, err := s.Store.GetBalance(ctx, uid); err == nil && b.Exists() {
		out["web_credit_balance_usd"] = fmt.Sprintf("%.2f", float64(max(b.Available(), 0))/100)
	} else {
		out["web_credit_balance_usd"] = "0.00"
	}
	if rec != nil {
		out["web_country"] = rec.Country
		if rec.LastActiveAt != nil {
			out["web_last_active_at"] = iso(*rec.LastActiveAt)
		}
	}
	return out
}

func rcSentValue(k, v string) string {
	if v == "" || !rcPersonal[k] {
		return v
	}
	sum := sha256.Sum256([]byte(v))
	return "h:" + hex.EncodeToString(sum[:8])
}

// syncRCAttributes sends the due accounts' changed attributes (the
// reconcile sweep). Returns how many were sent or dry-run.
func (s *Service) syncRCAttributes(ctx context.Context) int {
	mode := s.rcAttrMode(ctx)
	if mode == "off" {
		return 0
	}
	now := time.Now().UTC()
	due, err := s.Store.ClaimDueRCAttrs(ctx, now, rcAttrLease, 25)
	if err != nil {
		slog.WarnContext(ctx, "rc attributes sweep failed", "err", err)
		return 0
	}
	allow := s.Pricing.Rates(ctx).RCAttrAllowUIDs
	n := 0
	for _, rec := range due {
		real := mode == "on" || (mode == "allowlist" && slices.Contains(allow, rec.UID))
		s.syncRCAttrsOne(ctx, rec, real, now.Add(rcAttrLease))
		n++
	}
	return n
}

func (s *Service) syncRCAttrsOne(ctx context.Context, rec *store.RCAttrSync, real bool, leaseEnd time.Time) {
	uid := rec.UID
	var attrs map[string]string
	if rec.Clear {
		attrs = map[string]string{}
		for _, k := range rcWebAttrs {
			attrs[k] = "" // only ours: never delete_account, newsletter or the app's
		}
	} else {
		attrs = s.rcAttrsOf(ctx, uid, rec)
	}
	changed, marks := map[string]string{}, map[string]string{}
	for k, v := range attrs {
		if rec.Sent[k] != rcSentValue(k, v) { // never-set and empty: nothing to send
			changed[k] = v
		}
	}
	if rec.Clear {
		changed = attrs // a deletion clears them all, whatever was sent
		if rec.Sent["cleared"] != "" {
			changed = map[string]string{} // already cleared: a deleted account never gets them back
		}
	}
	// $email / $displayName: only where the customer has none yet
	if real && !rec.Clear && (rec.Sent["$email"] == "" || rec.Sent["$displayName"] == "") && (attrs["web_email"] != "" || attrs["web_display_name"] != "") {
		if have, err := s.RevenueCat.SubscriberAttributes(ctx, uid); err == nil {
			for _, k := range []struct{ rc, ours string }{{"$email", "web_email"}, {"$displayName", "web_display_name"}} {
				switch {
				case rec.Sent[k.rc] != "":
				case have[k.rc] != "":
					marks[k.rc] = "app" // the app's value: never ours to write, not read again
				case attrs[k.ours] != "":
					changed[k.rc] = attrs[k.ours]
				}
			}
		}
	}
	names := make([]string, 0, len(changed))
	for k := range changed {
		names = append(names, k)
	}
	sort.Strings(names)
	var sendErr error
	if len(changed) > 0 {
		if real {
			sendErr = s.RevenueCat.SetAttributes(ctx, uid, changed, time.Now())
		} else {
			slog.InfoContext(ctx, "rc attributes: dry run (not allowlisted)", "attributes", strings.Join(names, ","), "clear", rec.Clear)
		}
	}
	err := s.Store.FinishRCAttrSync(ctx, uid, leaseEnd, func(r *store.RCAttrSync) {
		now := time.Now().UTC()
		if sendErr != nil {
			r.Attempts++
			r.LastError = sendErr.Error()
			retry := now.Add(time.Duration(min(r.Attempts, 10)) * 5 * time.Minute)
			r.DueAt = &retry
			if r.Attempts > 12 { // a day of tries: give up until the next change
				r.DueAt = nil
			}
			return
		}
		r.DueAt, r.Reasons, r.LastError, r.Attempts, r.SentAt = nil, nil, "", 0, &now
		r.Mode = "dry_run"
		if real {
			r.Mode = "sent"
			if r.Sent == nil {
				r.Sent = map[string]string{}
			}
			for k, v := range changed {
				r.Sent[k] = rcSentValue(k, v)
			}
			for k, v := range marks {
				r.Sent[k] = v
			}
			if rec.Clear {
				r.Sent, r.Country, r.LastActiveAt = map[string]string{"cleared": now.Format(time.RFC3339)}, "", nil
			}
		}
	})
	if err != nil {
		slog.WarnContext(ctx, "rc attributes sync not recorded", "err", err)
	}
	if sendErr != nil {
		slog.WarnContext(ctx, "rc attributes not sent", "attributes", strings.Join(names, ","), "err", sendErr)
	} else if real && len(changed) > 0 {
		slog.InfoContext(ctx, "rc attributes sent", "attributes", strings.Join(names, ","), "clear", rec.Clear)
	}
}
