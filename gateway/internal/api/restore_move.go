package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/emailcode"
	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Restore Purchases, part (b): a web plan from a deleted account (design
// 1b, owner 2026-11-06). A plan still valid when its account was deleted
// is recorded in plan_restores_{env} (by its emails, never a relay one,
// and its Apple and Google subjects, RP-04); a new account that proves
// one of them moves the plan onto itself.
//
//   - POST /v1/billing/restore/find {email, language?} → 202 {sent,
//     resend_after_s}: a code to that address, the same answer whether
//     anything is found (5 addresses a day per account, 20 an hour per
//     address).
//   - POST /v1/billing/restore/find/verify {email?, code?} → {proof_id,
//     found: [{offer_id, plan, plan_id, ends_at, renews, from, moves,
//     stays, carry_cents}]}. With an email, its code; without one, the
//     caller's own Apple or Google sign-in and its own verified emails.
//     found is [] ("We didn't find any purchases") when nothing matches
//     or the period has ended; 409 restored_elsewhere {providers} when
//     the only match went to another account.
//   - POST /v1/billing/restore/move {proof_id, offer_id} (fresh sign-in)
//     → {restored, plan, message}. 409 has_own_plan (RP-03: the account
//     has a paid plan of its own, "Contact support"), restored_elsewhere;
//     400 proof_invalid (15 minutes, this account, that offer); 502
//     restore_unavailable (Stripe failed: try again, it resumes).
//
// What moves: the plan to its period end (the subscription's
// metadata[user_id] points to the new account, restored_from to the old;
// it stays on the old Stripe customer and nothing is cancelled, DL-01),
// the app's entitlements, this period's unspent plan credit carried over
// once (RP-01), and a yearly plan's months not yet given (RP-02, never a
// month given on the deleted account). What stays: credit already
// spent or expired, the balance, App Store purchases, admin grants, past
// runs and files. A move twice is a no-op.

const (
	restoreFindPerAccountDay = 5
	restoreFindPerIPHour     = 20
)

// Plain keys for what a restore moves and what stays (the client words them).
var restoreStays = []string{"usage_already_used", "balance", "app_store_purchases", "past_runs_and_files"}

// A restored (or support-moved) plan never renews: its subscription stays
// on the other account's Stripe customer and card, so a resume, a "Keep
// plan" or a plan change would charge that card for this account. It
// runs to its end; the person buys a plan of their own after that.
func planNotRenewable(p *store.Plan) bool { return p != nil && p.RestoredFrom != "" }

func errNotRenewable(p *store.Plan) *httpx.APIError {
	end := "its period's end"
	if p != nil && p.CurrentPeriodEnd != nil {
		end = p.CurrentPeriodEnd.UTC().Format("January 2, 2006")
	}
	return httpx.Err(http.StatusConflict, "not_renewable",
		"This plan was restored from another account and ends on "+end+". Choose a plan to continue after that.")
}

// recordPlanRestore writes the restore record for a deleted account's
// plan still in its period (finishAccountDeletion, before the credit and
// the emails go).
func (s *Service) recordPlanRestore(ctx context.Context, uid string) {
	c, err := s.Store.GetCustomer(ctx, uid)
	now := time.Now().UTC()
	if err != nil || c.Plan == nil || c.Plan.SubscriptionID == "" || !c.Plan.Active(now) || c.Plan.CurrentPeriodEnd == nil {
		return
	}
	p := c.Plan
	if p.RestoredFrom != "" && p.RestoredFrom == uid {
		return
	}
	emails := []string{}
	add := func(e string) {
		e = normalEmail(e)
		if e != "" && !store.IsRelayEmail(e) && !slices.Contains(emails, store.EmailID(e)) {
			emails = append(emails, store.EmailID(e))
		}
	}
	add(c.Email)
	if list, err := s.Store.ListAccountEmails(ctx, uid); err == nil {
		for _, e := range list {
			if e.Verified || e.Main {
				add(e.Email)
			}
		}
	}
	subjects, providers := []string{}, []string{}
	if id, err := s.identityOrNil(ctx, uid); err == nil && id != nil {
		add(id.Email)
		for _, prov := range []string{providerApple, providerGoogle} {
			if sub := id.Subjects[prov]; sub != "" {
				subjects = append(subjects, store.SubjectHash(prov, sub))
			}
		}
		providers = signInMethods(id)
	}
	rec := &store.PlanRestore{ID: p.SubscriptionID, EmailHashes: emails, SubjectHashes: subjects, FromUID: uid, FromProviders: providers,
		Tier: p.Tier, PlanID: p.PlanID, Interval: p.Interval, PeriodEnd: *p.CurrentPeriodEnd, CancelAtPeriodEnd: p.CancelAtPeriodEnd,
		CreditMonthsGranted: []int{}, CreatedAt: now}
	if p.Yearly() {
		for k := 0; k < 12; k++ {
			if done, _ := s.Store.EntryExists(ctx, uid, planMonthEntry(p.SubscriptionID, k)); done {
				rec.CreditMonthsGranted = append(rec.CreditMonthsGranted, k)
			}
		}
	}
	if b, err := s.Store.GetBalance(ctx, uid); err == nil {
		for _, it := range b.Fifo {
			if !it.PlanCredit || it.ExpiresAt == nil || !it.ExpiresAt.After(now) {
				continue
			}
			if left := it.RemainingCents - it.FrozenCents; left > 0 {
				rec.CarryCents += left
				if rec.CarryExpiresAt == nil || it.ExpiresAt.After(*rec.CarryExpiresAt) {
					e := *it.ExpiresAt
					rec.CarryExpiresAt = &e
				}
			}
		}
	}
	if len(emails) == 0 && len(subjects) == 0 {
		slog.WarnContext(ctx, "plan restore not recorded: no email or sign-in to find it by", "plan", p.Tier)
		return
	}
	if _, err := s.Store.PutPlanRestore(ctx, rec); err != nil {
		slog.WarnContext(ctx, "plan restore not recorded", "err", err)
		return
	}
	slog.InfoContext(ctx, "plan kept for Restore Purchases", "plan", p.Tier, "until", p.CurrentPeriodEnd, "carry_cents", rec.CarryCents)
}

// callerSubjects are the caller's Apple and Google subject hashes.
func (s *Service) callerSubjects(ctx context.Context, uid string) []string {
	id, err := s.identityOrNil(ctx, uid)
	if err != nil || id == nil {
		return nil
	}
	out := []string{}
	for _, prov := range []string{providerApple, providerGoogle} {
		if sub := id.Subjects[prov]; sub != "" {
			out = append(out, store.SubjectHash(prov, sub))
		}
	}
	return out
}

func restoreMoves(r *store.PlanRestore, now time.Time) []string {
	moves := []string{"plan", "app_access"}
	if r.CarryCents > 0 && r.CarryExpiresAt != nil && r.CarryExpiresAt.After(now) {
		moves = append(moves, "current_usage")
	}
	if r.Interval == "year" && len(r.CreditMonthsGranted) < 12 {
		moves = append(moves, "months_not_yet_given")
	}
	return moves
}

func (s *Service) restoreOfferJSON(r *store.PlanRestore, now time.Time) map[string]any {
	carry := int64(0)
	if r.CarryExpiresAt != nil && r.CarryExpiresAt.After(now) {
		carry = r.CarryCents
	}
	from := r.FromProviders
	if from == nil {
		from = []string{}
	}
	return map[string]any{"offer_id": store.OfferID(r.ID), "plan": r.Tier, "plan_id": publicPlanOf(r), "ends_at": r.PeriodEnd.UTC().Format(time.RFC3339),
		"renews": !r.CancelAtPeriodEnd, "from": from, "moves": restoreMoves(r, now), "stays": restoreStays, "carry_cents": carry}
}

func publicPlanOf(r *store.PlanRestore) string {
	if r.PlanID != "" {
		return r.PlanID
	}
	return r.Tier
}

func errRestoredElsewhere(providers []string) *httpx.APIError {
	e := httpx.Err(http.StatusConflict, "restored_elsewhere", "That plan was restored on another account. Sign in to that account to use it.")
	if providers == nil {
		providers = []string{}
	}
	e.Details = map[string]any{"providers": providers}
	return e
}

// HandleRestoreFind is POST /v1/billing/restore/find.
func (s *Service) HandleRestoreFind(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	now := time.Now().UTC()
	var req struct {
		Email    string `json:"email"`
		Language string `json:"language"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("body must be a JSON object"))
		return
	}
	email, err := emailcode.NormalizeEmail(req.Email)
	if err != nil {
		httpx.WriteErr(ctx, w, emailcode.APIError(err))
		return
	}
	if s.refusedForDeletion(ctx, w, user.UID) {
		return
	}
	if s.EmailCodes == nil {
		httpx.WriteErr(ctx, w, errIdentityUnavailable())
		return
	}
	if ip := clientIP(r); ip != "" && !eventAllowed("restore-find-ip:"+ip, restoreFindPerIPHour, now) {
		writeRestoreLimited(ctx, w, time.Hour)
		return
	}
	ok, wait, err := s.Store.AllowSupport(ctx, "restore-find:"+user.UID, restoreFindPerAccountDay, 24*time.Hour, now)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	if !ok {
		writeRestoreLimited(ctx, w, wait)
		return
	}
	_, viaRelay, _ := httpx.TrustedClientIP(ctx)
	resend, err := s.EmailCodes.StartIn(ctx, email, emailcode.LangFor(r, viaRelay, req.Language))
	if err != nil {
		httpx.WriteErr(ctx, w, emailcode.APIError(err))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "sent": true, "resend_after_s": max(0, int(resend.Seconds()+0.999))})
}

// HandleRestoreFindVerify is POST /v1/billing/restore/find/verify.
func (s *Service) HandleRestoreFindVerify(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	now := time.Now().UTC()
	var req struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("body must be a JSON object"))
		return
	}
	if s.refusedForDeletion(ctx, w, user.UID) {
		return
	}
	if !identityAllowed(r, user.UID) {
		writeRateLimited(ctx, w)
		return
	}
	emailKeys := []string{}
	if strings.TrimSpace(req.Email) != "" {
		email, err := emailcode.NormalizeEmail(req.Email)
		if err != nil {
			httpx.WriteErr(ctx, w, emailcode.APIError(err))
			return
		}
		if s.EmailCodes == nil {
			httpx.WriteErr(ctx, w, errIdentityUnavailable())
			return
		}
		if err := s.EmailCodes.Check(ctx, email, req.Code); err != nil {
			httpx.WriteErr(ctx, w, emailcode.APIError(err))
			return
		}
		if !store.IsRelayEmail(email) { // never matched on a relay address
			emailKeys = append(emailKeys, store.EmailID(email))
		}
	} else if list, err := s.Store.ListAccountEmails(ctx, user.UID); err == nil {
		for _, e := range list { // the caller's own proven emails
			if e.Verified && !e.Relay() {
				emailKeys = append(emailKeys, store.EmailID(e.Email))
			}
		}
	}
	recs, err := s.Store.FindPlanRestores(ctx, emailKeys, s.callerSubjects(ctx, user.UID))
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	found := []map[string]any{}
	offers := map[string]string{}
	var elsewhere []string
	for _, rec := range recs {
		if !rec.PeriodEnd.After(now) || rec.FromUID == user.UID {
			continue // ended: nothing to restore
		}
		if rec.State != store.PlanRestoreAvailable && rec.ToUID != user.UID {
			if elsewhere == nil {
				elsewhere = []string{}
				if other, err := s.identityOrNil(ctx, rec.ToUID); err == nil && other != nil {
					elsewhere = signInMethods(other)
				}
			}
			continue
		}
		offers[store.OfferID(rec.ID)] = rec.ID
		found = append(found, s.restoreOfferJSON(rec, now))
	}
	if len(found) == 0 && elsewhere != nil {
		httpx.WriteErr(ctx, w, errRestoredElsewhere(elsewhere))
		return
	}
	out := map[string]any{"found": found, "proof_id": nil}
	if len(found) > 0 {
		id, err := s.Store.CreateRestoreProof(ctx, &store.RestoreProof{UID: user.UID, Offers: offers, ExpiresAt: now.Add(store.RestoreProofTTL), CreatedAt: now})
		if err != nil {
			httpx.WriteErr(ctx, w, httpx.ErrServer())
			return
		}
		out["proof_id"] = id
	} else {
		out["message"] = restoreMsgNone
	}
	slog.InfoContext(ctx, "restore find", "found", len(found), "by_email", len(emailKeys) > 0)
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, out)
}

// restoreStillRenews: a record not yet claimed whose subscription will
// renew (Stripe's own state; the record's when Stripe can't be read).
func (s *Service) restoreStillRenews(ctx context.Context, subID string) bool {
	rec, err := s.Store.GetPlanRestore(ctx, subID)
	if err != nil || rec.State != store.PlanRestoreAvailable {
		return false // a claimed one resumes as it was
	}
	if s.Stripe != nil {
		if sub, err := s.Stripe.GetSubscription(subID); err == nil {
			return sub.Live() && !sub.CancelAtPeriodEnd
		}
	}
	return !rec.CancelAtPeriodEnd
}

// hasOwnPlan: the account has a paid web plan of its own (RP-03).
func hasOwnPlan(c *store.Customer, subID string, now time.Time) bool {
	return c != nil && c.Plan != nil && c.Plan.SubscriptionID != "" && c.Plan.SubscriptionID != subID && c.Plan.Active(now)
}

// HandleRestoreMove is POST /v1/billing/restore/move.
func (s *Service) HandleRestoreMove(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	now := time.Now().UTC()
	var req struct {
		ProofID string `json:"proof_id"`
		OfferID string `json:"offer_id"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("body must be a JSON object"))
		return
	}
	if s.refusedForDeletion(ctx, w, user.UID) {
		return
	}
	subID, err := s.Store.UseRestoreProof(ctx, req.ProofID, user.UID, req.OfferID, now)
	if errors.Is(err, store.ErrProofInvalid) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "proof_invalid", "Find your purchases again, then restore within 15 minutes."))
		return
	}
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	if s.restoreStillRenews(ctx, subID) {
		// Only old deletion paths leave one (deletion now needs a cancel);
		// never cancelled on our own (DL-01): support moves it (RP-05).
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "plan_renewing_support", "This plan still renews on another account. Contact support to move it."))
		return
	}
	if hasOwnPlan(cust, subID, now) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "has_own_plan",
			"Your account has a plan of its own. Contact support to move the other one here."))
		return
	}
	rec, err := s.Store.ClaimPlanRestore(ctx, subID, user.UID, now)
	if errors.Is(err, store.ErrRestoredElsewhere) {
		var providers []string
		if rec != nil {
			if other, err := s.identityOrNil(ctx, rec.ToUID); err == nil && other != nil {
				providers = signInMethods(other)
			}
		}
		httpx.WriteErr(ctx, w, errRestoredElsewhere(providers))
		return
	}
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	if rec.State != store.PlanRestoreMoved {
		if !rec.PeriodEnd.After(now) {
			httpx.WriteOK(w, map[string]any{"restored": false, "message": restoreMsgNone})
			return
		}
		if err := s.movePlan(ctx, user.UID, rec, now); err != nil {
			slog.WarnContext(ctx, "restore move not finished", "step", err.Error())
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "restore_unavailable", "We couldn't restore it right now. Try again in a while."))
			return
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, map[string]any{"restored": true, "plan": s.planJSON(ctx, user.UID), "message": restoreMsgRestored})
}

// movePlan carries a claimed record onto uid; every step is idempotent,
// so a failed move resumes on a retry.
func (s *Service) movePlan(ctx context.Context, uid string, rec *store.PlanRestore, now time.Time) error {
	if s.Stripe == nil {
		return errors.New("stripe: not configured")
	}
	// 1. Stripe: later events land on the new account. Never cancelled.
	sub, err := s.Stripe.SetSubscriptionMetadata(rec.ID, map[string]string{"user_id": uid, "restored_from": rec.FromUID},
		"restore_"+s.Cfg.Env+"_"+rec.ID+"_"+uid)
	if err != nil {
		return errors.New("stripe: metadata")
	}
	if sub.Metadata["user_id"] != uid {
		if got, err := s.Stripe.GetSubscription(rec.ID); err == nil {
			sub = got
		}
	}
	// 2. The plan on the new account (its record kept from the deleted
	// one: the last invoice, so the resync applies nothing again).
	old, err := s.Store.GetCustomer(ctx, rec.FromUID)
	if err != nil {
		return errors.New("customers: the deleted account")
	}
	start, end := sub.Period()
	next := &store.Plan{Tier: rec.Tier, SubscriptionID: rec.ID, Status: sub.Status, CurrentPeriodStart: &start, CurrentPeriodEnd: &end,
		CancelAtPeriodEnd: sub.CancelAtPeriodEnd, UpdatedAt: now, Interval: sub.Interval(), PlanID: rec.PlanID, RestoredFrom: rec.FromUID}
	if old.Plan != nil && old.Plan.SubscriptionID == rec.ID {
		next.LastInvoiceID, next.LastCreditCents, next.StartedAt = old.Plan.LastInvoiceID, old.Plan.LastCreditCents, old.Plan.StartedAt
		next.PeriodPaidCents, next.Intro, next.AppProChecked = old.Plan.PeriodPaidCents, old.Plan.Intro, old.Plan.AppProChecked
	}
	if _, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil && c.Plan.SubscriptionID == rec.ID {
			next.RCGrantInvoice, next.RCGrantedUntil = c.Plan.RCGrantInvoice, c.Plan.RCGrantedUntil // a resumed move
		}
		if c.Email == "" {
			if list, err := s.Store.ListAccountEmails(ctx, uid); err == nil {
				if m := mainOf(list); m != nil {
					c.Email = m.Email
				}
			}
		}
		c.Plan = next
		return nil
	}); err != nil {
		if !errors.Is(err, store.ErrNotFound) {
			return errors.New("customers: the new account")
		}
		if err := s.Store.PutCustomer(ctx, uid, &store.Customer{Plan: next, CreatedAt: now}); err != nil {
			return errors.New("customers: the new account")
		}
	}
	// 3. RP-01: this period's unspent credit, once.
	if rec.CarryCents > 0 && rec.CarryExpiresAt != nil && rec.CarryExpiresAt.After(now) {
		entry := "plancredit_restore_" + rec.ID
		if done, err := s.Store.EntryExists(ctx, uid, entry); err != nil {
			return errors.New("balance: read")
		} else if !done {
			exp := *rec.CarryExpiresAt
			_, fx, err := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) {
				return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: rec.CarryCents, EntryID: entry, Ref: rec.ID, ExpiresAt: &exp,
					Note: tierLabel(rec.Tier) + " credit carried over (restored)"}}, nil
			})
			if err != nil {
				if done, _ := s.Store.EntryExists(ctx, uid, entry); !done {
					return errors.New("balance: carry")
				}
			} else {
				s.handleBalanceEffects(ctx, uid, fx)
			}
		}
	}
	// 4. RP-02: a yearly plan's due month not given on the deleted account.
	if next.Yearly() {
		if def, ok := s.rates(ctx).Plan(rec.Tier); ok {
			s.grantPlanMonth(ctx, uid, next, def, now)
		}
	}
	// 5. The app's entitlements to the period's end.
	if rec.Tier == pricing.TierBusiness || rec.Tier == pricing.TierStudio || rec.Tier == pricing.TierPro {
		inv := next.LastInvoiceID
		if inv == "" {
			inv = "restore_" + rec.ID
		}
		s.grantPlanEntitlements(ctx, uid, rec.Tier, inv, end)
	}
	// 6. Done: the record, the audit row, a note for the owner.
	if err := s.Store.FinishPlanRestore(ctx, rec.ID, now); err != nil {
		return errors.New("plan_restores: finish")
	}
	if err := s.Store.AddRestore(ctx, &store.Restore{UID: uid, Kind: "move", At: now, Restored: true, Repaired: restoreMoves(rec, now)}); err != nil {
		slog.WarnContext(ctx, "restore audit row not written", "err", err)
	}
	if s.Slack != nil {
		s.Slack.Alert(ctx, "plan_restored", fmt.Sprintf("Restore Purchases moved a %s plan from a deleted account (until %s); see plan_restores_%s",
			tierLabel(rec.Tier), rec.PeriodEnd.Format("2006-01-02"), s.Cfg.Env))
	}
	slog.InfoContext(ctx, "plan restored from a deleted account", "plan", rec.Tier, "carry_cents", rec.CarryCents)
	return nil
}
