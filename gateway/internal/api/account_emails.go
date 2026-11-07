package api

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/auth"
	"spatial-ai-labs/stereo3d-gateway/internal/emailcode"
	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Main and additional emails (design 2, owner 2026-11-06). An account
// holds up to five emails, each on no other account; any of them signs in
// with the email code, and exactly one is main: Firebase's email,
// customers.email and the Stripe customer's email follow it (receipts
// and Restore Purchases use it).
//
//   - GET /v1/account/emails → {emails: [{id, email, main, relay,
//     added_at}], plan_email_needed}. plan_email_needed: a Business or
//     Studio plan whose main email is missing or an Apple relay address
//     ("Add an email for your plan").
//   - POST /v1/account/emails/start {email, language?} → 202 {sent,
//     resend_after_s}: a code to that address, whoever holds it.
//   - POST /v1/account/emails {email, code, make_main?} (fresh sign-in)
//     → the list. 409 credential_in_use {providers} (another account's),
//     relay_not_main, too_many_emails (five).
//   - POST /v1/account/emails/{id}/main (fresh) → the list, plus
//     refresh_token: true when the main changed (the ID token's email is
//     stale). 409 relay_not_main, email_unverified; 404 email_not_found.
//   - DELETE /v1/account/emails/{id} (fresh) → the list. 409
//     main_email_not_removable, last_method.
//
// EM-03: a relay address may be an additional email, never the main one
// on a Business or Studio account (an Apple account's own relay email
// stays its main until another is added and made main).
//
// A main switch commits the store and an email_syncs row first, then
// updates Firebase, customers.email and the Stripe customer, marks the row
// done and tells the old main address. The reconcile retries rows left
// pending and flags main_email_drift after five failed tries.

// emailSyncRetryAfter: the reconcile leaves a fresh row to its request.
var emailSyncRetryAfter = time.Minute

func normalEmail(raw string) string { return strings.ToLower(strings.TrimSpace(raw)) }

// accountGone: the account was deleted (or its Firebase user is gone), so
// its emails are free.
func (s *Service) accountGone(ctx context.Context, uid string) (bool, error) {
	if c, err := s.Store.GetCustomer(ctx, uid); err == nil && c.AccountDeleted {
		return true, nil
	}
	ok, err := s.userExists(ctx, uid)
	return err == nil && !ok, err
}

// addEmail is AddAccountEmail; an email still recorded on a gone account
// is freed first.
func (s *Service) addEmail(ctx context.Context, spec store.AddEmailSpec) (*store.AddAccountEmailResult, error) {
	res, err := s.Store.AddAccountEmail(ctx, spec)
	if owner, taken := store.IsEmailTaken(err); taken {
		if gone, gerr := s.accountGone(ctx, owner); gerr == nil && gone {
			if _, rerr := s.Store.ReleaseAllAccountEmails(ctx, owner, "gone"); rerr != nil {
				return nil, rerr
			}
			res, err = s.Store.AddAccountEmail(ctx, spec)
		}
	}
	return res, err
}

// accountEmails is uid's active emails. An account with none yet records
// its Firebase email as main, as it is (verified or not): the lazy form
// of the EM-01 backfill.
func (s *Service) storeEmails(ctx context.Context, uid string) ([]*store.AccountEmail, error) {
	list, err := s.Store.ListAccountEmails(ctx, uid)
	if err != nil || len(list) > 0 {
		return list, err
	}
	admin := s.identities()
	if admin == nil {
		return list, nil
	}
	id, err := admin.IdentityOf(ctx, uid)
	if err != nil {
		return nil, err
	}
	email := normalEmail(id.Email)
	if email == "" {
		return list, nil
	}
	if _, err := s.addEmail(ctx, store.AddEmailSpec{UID: uid, Email: email, Source: "firebase", Verified: id.EmailVerified,
		MainIfNone: true, Claim: true, Who: "claim"}); err != nil {
		if _, taken := store.IsEmailTaken(err); taken {
			// Firebase says one account, the store another: left for the
			// reconcile's drift report; the account still works.
			slog.WarnContext(ctx, "account email: Firebase email held by another account in the store")
			return list, nil
		}
		return nil, err
	}
	return s.Store.ListAccountEmails(ctx, uid)
}

func mainOf(list []*store.AccountEmail) *store.AccountEmail {
	for _, e := range list {
		if e.Main {
			return e
		}
	}
	return nil
}

// planEmailNeeded: a Business or Studio plan without a real main email.
func (s *Service) planEmailNeeded(ctx context.Context, uid string, list []*store.AccountEmail) bool {
	if !s.onBusinessPlan(ctx, uid) {
		return false
	}
	m := mainOf(list)
	return m == nil || m.Relay()
}

func (s *Service) emailsJSON(ctx context.Context, uid string, list []*store.AccountEmail) map[string]any {
	rows := make([]map[string]any, 0, len(list))
	for _, e := range list {
		rows = append(rows, map[string]any{"id": e.ID, "email": e.Email, "main": e.Main, "relay": e.Relay(),
			"added_at": e.AddedAt.UTC().Format(time.RFC3339)})
	}
	return map[string]any{"emails": rows, "plan_email_needed": s.planEmailNeeded(ctx, uid, list)}
}

func (s *Service) writeEmails(ctx context.Context, w http.ResponseWriter, uid string, extra map[string]any) {
	list, err := s.storeEmails(ctx, uid)
	if err != nil {
		httpx.WriteErr(ctx, w, identityErr(ctx, "emails", err))
		return
	}
	out := s.emailsJSON(ctx, uid, list)
	for k, v := range extra {
		out[k] = v
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, out)
}

// signInCount is how many ways uid signs in: Apple, Google, its emails
// (the store's, else Firebase's one) and passkeys.
func (s *Service) signInCount(ctx context.Context, id *auth.Identity) (int, error) {
	n := 0
	for _, m := range signInMethods(id) {
		if m != providerEmail {
			n++
		}
	}
	list, err := s.Store.ListAccountEmails(ctx, id.UID)
	if err != nil {
		return 0, err
	}
	switch {
	case len(list) > 0:
		n += len(list)
	case strings.TrimSpace(id.Email) != "":
		n++
	}
	pk, err := s.passkeyCount(ctx, id.UID)
	return n + pk, err
}

func errRelayNotMain() *httpx.APIError {
	return httpx.Err(http.StatusConflict, "relay_not_main", "Your plan needs a real email as its main one. Hide My Email addresses can be added as extra emails.")
}

func errTooManyEmails() *httpx.APIError {
	return httpx.Err(http.StatusConflict, "too_many_emails", "Your account has five emails. Remove one first.")
}

func errEmailNotFound() *httpx.APIError {
	return httpx.Err(http.StatusNotFound, "email_not_found", "That email isn't on your account.")
}

// emailStoreErr maps the store's refusals.
func (s *Service) emailStoreErr(ctx context.Context, err error) error {
	switch {
	case errors.Is(err, store.ErrTooManyEmails):
		return errTooManyEmails()
	case errors.Is(err, store.ErrEmailRelayNotMain):
		return errRelayNotMain()
	case errors.Is(err, store.ErrEmailNotOnAccount):
		return errEmailNotFound()
	case errors.Is(err, store.ErrEmailUnverified):
		return httpx.Err(http.StatusConflict, "email_unverified", "Confirm that email with a code first.")
	case errors.Is(err, store.ErrMainNotRemovable):
		return httpx.Err(http.StatusConflict, "main_email_not_removable", "Make another email main before removing this one.")
	}
	if owner, taken := store.IsEmailTaken(err); taken {
		other, _ := s.identityOrNil(ctx, owner)
		return s.credentialInUse(ctx, other)
	}
	return err
}

func (s *Service) identityOrNil(ctx context.Context, uid string) (*auth.Identity, error) {
	admin := s.identities()
	if admin == nil {
		return nil, nil
	}
	return admin.IdentityOf(ctx, uid)
}

// heldElsewhere refuses an email another live account holds: in the store
// or as its Firebase email.
func (s *Service) heldElsewhere(ctx context.Context, uid, email string) error {
	if owner, err := s.Store.EmailOwner(ctx, email); err != nil {
		return err
	} else if owner != "" && owner != uid {
		if gone, err := s.accountGone(ctx, owner); err != nil {
			return err
		} else if !gone {
			other, _ := s.identityOrNil(ctx, owner)
			return s.credentialInUse(ctx, other)
		}
	}
	admin := s.identities()
	if admin == nil {
		return nil
	}
	other, err := admin.IdentityByEmail(ctx, email)
	if err != nil {
		return err
	}
	if other != nil && other.UID != uid {
		return s.credentialInUse(ctx, other)
	}
	return nil
}

// putEmail checks an email code and puts the email on uid (main when
// makeMain, or when it's the account's first); a new main is synced at
// once. It answers whether the main changed. The code is spent only when
// the email goes on.
func (s *Service) putEmail(ctx context.Context, uid, rawEmail, code string, makeMain bool) (bool, error) {
	if s.EmailCodes == nil {
		return false, errIdentityUnavailable()
	}
	email, err := emailcode.NormalizeEmail(rawEmail)
	if err != nil {
		return false, emailcode.APIError(err)
	}
	if err := s.EmailCodes.Peek(ctx, email, code); err != nil {
		return false, emailcode.APIError(err)
	}
	if err := s.heldElsewhere(ctx, uid, email); err != nil {
		return false, err
	}
	list, err := s.storeEmails(ctx, uid)
	if err != nil {
		return false, err
	}
	plan := s.onBusinessPlan(ctx, uid)
	mine := false
	for _, e := range list {
		mine = mine || e.Email == email
	}
	if !mine && len(list) >= store.MaxAccountEmails {
		return false, errTooManyEmails()
	}
	if plan && store.IsRelayEmail(email) && (makeMain || len(list) == 0) {
		return false, errRelayNotMain()
	}
	if err := s.EmailCodes.Check(ctx, email, code); err != nil { // spent meanwhile: refused
		return false, emailcode.APIError(err)
	}
	res, err := s.addEmail(ctx, store.AddEmailSpec{UID: uid, Email: email, Source: "code", Verified: true, Main: makeMain,
		RelayNotMain: plan, Who: "customer"})
	if err != nil {
		return false, s.emailStoreErr(ctx, err)
	}
	s.passkeyEvent(ctx, uid, "email_added", map[string]any{"main": res.BecameMain, "relay": store.IsRelayEmail(email)})
	if res.SyncID != "" {
		s.runEmailSync(ctx, &store.EmailSync{ID: res.SyncID, UID: uid, Email: email, Previous: res.PreviousMain})
	}
	return res.BecameMain, nil
}

// syncMainEmail carries a main switch to Firebase, customers.email and
// the Stripe customer; a switch superseded meanwhile is done.
func (s *Service) syncMainEmail(ctx context.Context, sy *store.EmailSync) error {
	defer s.rcAttrsTouch(ctx, sy.UID, "email") // web_email (and $email where it has none)
	row, err := s.Store.GetAccountEmail(ctx, sy.Email)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		return err
	}
	if row == nil || row.UID != sy.UID || row.State != store.EmailActive || !row.Main {
		return nil // switched again or removed: the newer row carries it
	}
	if admin := s.identities(); admin != nil {
		id, err := admin.IdentityOf(ctx, sy.UID)
		if err != nil {
			return errors.New("firebase: read")
		}
		if normalEmail(id.Email) != sy.Email || !id.EmailVerified {
			if err := admin.SetVerifiedEmail(ctx, sy.UID, sy.Email); err != nil {
				if auth.IsEmailInUse(err) {
					return errors.New("firebase: email held by another user")
				}
				return errors.New("firebase: update")
			}
		}
	}
	cust, err := s.Store.GetCustomer(ctx, sy.UID)
	if err != nil {
		return nil // no customer record yet: it takes the main email when made
	}
	if cust.Email != sy.Email {
		if _, err := s.Store.UpdateCustomer(ctx, sy.UID, func(c *store.Customer) error { c.Email = sy.Email; return nil }); err != nil {
			return errors.New("customers: update")
		}
	}
	if cust.StripeCustomerID != "" && s.Stripe != nil {
		if err := s.Stripe.SetCustomerEmail(cust.StripeCustomerID, sy.Email); err != nil {
			return errors.New("stripe: update")
		}
	}
	return nil
}

// runEmailSync tries one sync and records how it went; a sync done tells
// the old main address.
func (s *Service) runEmailSync(ctx context.Context, sy *store.EmailSync) string {
	if err := s.syncMainEmail(ctx, sy); err != nil {
		state, ferr := s.Store.FinishEmailSync(ctx, sy.ID, err.Error())
		slog.WarnContext(ctx, "main email not synced yet", "step", err.Error(), "state", state, "err", ferr)
		return state
	}
	if _, err := s.Store.FinishEmailSync(ctx, sy.ID, ""); err != nil {
		slog.WarnContext(ctx, "main email sync not marked done", "err", err)
	}
	if sy.Previous != "" && sy.Previous != sy.Email {
		s.mailCustomer(ctx, "EM1_"+sy.ID, sy.UID, sy.Previous, mainEmailChangedMail(sy.Email))
	}
	return store.EmailSyncDone
}

// mainEmailChangedMail goes to the old main address.
func mainEmailChangedMail(newMain string) customerMail {
	return customerMail{Kind: "EM1", Subject: "Spatial Video Studio: your account's main email changed",
		Lines: []string{"Your Spatial Video Studio account now uses " + maskEmail(newMain) + " as its main email.",
			"This address still signs in until it's removed from the account.",
			"If you didn't make this change, reply to this email."}}
}

// emailSyncSweep retries main switches left pending (reconcile).
func (s *Service) emailSyncSweep(ctx context.Context) map[string]int {
	stats := map[string]int{}
	pending, err := s.Store.ListPendingEmailSyncs(ctx, 50)
	if err != nil {
		return stats
	}
	now := time.Now()
	drift := 0
	for _, sy := range pending {
		if now.Sub(sy.UpdatedAt) < emailSyncRetryAfter {
			continue // the request may still be on it
		}
		switch s.runEmailSync(ctx, sy) {
		case store.EmailSyncDone:
			stats["email_syncs_done"]++
		case store.EmailSyncDrift:
			drift++
		default:
			stats["email_syncs_retrying"]++
		}
	}
	if drift > 0 {
		stats["main_email_drift"] = drift
		if s.Slack != nil {
			s.Slack.Alert(ctx, "main_email_drift", "main email switch didn't reach Firebase or Stripe after 5 tries; see email_syncs_"+s.Cfg.Env+" state=drift")
		}
	}
	return stats
}

func emailsAllowed(r *http.Request, uid string) bool { return identityAllowed(r, uid) }

func writeRateLimited(ctx context.Context, w http.ResponseWriter) {
	httpx.WriteErr(ctx, w, httpx.Err(http.StatusTooManyRequests, "rate_limited", "Too many attempts. Try again in a while."))
}

// HandleAccountEmails is GET /v1/account/emails.
func (s *Service) HandleAccountEmails(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	s.writeEmails(r.Context(), w, user.UID, nil)
}

// HandleAccountEmailStart is POST /v1/account/emails/start.
func (s *Service) HandleAccountEmailStart(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		Email    string `json:"email"`
		Language string `json:"language"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("body must be a JSON object"))
		return
	}
	if s.EmailCodes == nil {
		httpx.WriteErr(ctx, w, errIdentityUnavailable())
		return
	}
	email, err := emailcode.NormalizeEmail(req.Email)
	if err != nil {
		httpx.WriteErr(ctx, w, emailcode.APIError(err))
		return
	}
	if !emailsAllowed(r, user.UID) {
		writeRateLimited(ctx, w)
		return
	}
	_, viaRelay, _ := httpx.TrustedClientIP(ctx)
	wait, err := s.EmailCodes.StartIn(ctx, email, emailcode.LangFor(r, viaRelay, req.Language))
	if err != nil {
		httpx.WriteErr(ctx, w, emailcode.APIError(err))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "sent": true, "resend_after_s": max(0, int(wait.Seconds()+0.999))})
}

// HandleAddAccountEmail is POST /v1/account/emails.
func (s *Service) HandleAddAccountEmail(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		Email    string `json:"email"`
		Code     string `json:"code"`
		MakeMain bool   `json:"make_main"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("body must be a JSON object"))
		return
	}
	if strings.TrimSpace(req.Email) == "" || strings.TrimSpace(req.Code) == "" {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("email and code are required"))
		return
	}
	if !emailsAllowed(r, user.UID) {
		writeRateLimited(ctx, w)
		return
	}
	changed, err := s.putEmail(ctx, user.UID, req.Email, req.Code, req.MakeMain)
	if err != nil {
		httpx.WriteErr(ctx, w, identityErr(ctx, "add_email", err))
		return
	}
	s.writeEmails(ctx, w, user.UID, map[string]any{"refresh_token": changed})
}

// HandleSetMainEmail is POST /v1/account/emails/{id}/main.
func (s *Service) HandleSetMainEmail(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	if !emailsAllowed(r, user.UID) {
		writeRateLimited(ctx, w)
		return
	}
	if _, err := s.storeEmails(ctx, user.UID); err != nil {
		httpx.WriteErr(ctx, w, identityErr(ctx, "emails", err))
		return
	}
	res, err := s.Store.SetMainEmail(ctx, user.UID, id, "customer", s.onBusinessPlan(ctx, user.UID))
	if err != nil {
		httpx.WriteErr(ctx, w, identityErr(ctx, "main_email", s.emailStoreErr(ctx, err)))
		return
	}
	if res.SyncID != "" {
		s.passkeyEvent(ctx, user.UID, "main_email_changed", map[string]any{"relay": res.Email.Relay()})
		s.runEmailSync(ctx, &store.EmailSync{ID: res.SyncID, UID: user.UID, Email: res.Email.Email, Previous: res.PreviousMain})
	}
	s.writeEmails(ctx, w, user.UID, map[string]any{"refresh_token": res.BecameMain})
}

// HandleRemoveAccountEmail is DELETE /v1/account/emails/{id}.
func (s *Service) HandleRemoveAccountEmail(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	if !emailsAllowed(r, user.UID) {
		writeRateLimited(ctx, w)
		return
	}
	list, err := s.storeEmails(ctx, user.UID)
	if err != nil {
		httpx.WriteErr(ctx, w, identityErr(ctx, "emails", err))
		return
	}
	var row *store.AccountEmail
	for _, e := range list {
		if e.ID == id {
			row = e
		}
	}
	if row == nil {
		httpx.WriteErr(ctx, w, errEmailNotFound())
		return
	}
	if row.Main {
		httpx.WriteErr(ctx, w, s.emailStoreErr(ctx, store.ErrMainNotRemovable))
		return
	}
	if me, err := s.identityOrNil(ctx, user.UID); err != nil {
		httpx.WriteErr(ctx, w, identityErr(ctx, "read", err))
		return
	} else if me != nil {
		n, err := s.signInCount(ctx, me)
		if err != nil {
			httpx.WriteErr(ctx, w, httpx.ErrServer())
			return
		}
		if n-1 < 1 {
			httpx.WriteErr(ctx, w, errLastMethod())
			return
		}
	}
	if err := s.Store.ReleaseAccountEmail(ctx, user.UID, id, "customer"); err != nil {
		httpx.WriteErr(ctx, w, identityErr(ctx, "remove_email", s.emailStoreErr(ctx, err)))
		return
	}
	s.passkeyEvent(ctx, user.UID, "email_removed", map[string]any{"relay": row.Relay()})
	s.writeEmails(ctx, w, user.UID, nil)
}

// emailOwners is the store side of the email-code sign-in (emailcode.Owners).
type emailOwners struct{ s *Service }

// EmailOwners lets /v1/auth/email/verify sign in with any active email.
func (s *Service) EmailOwners() emailcode.Owners { return emailOwners{s} }

func (o emailOwners) SignInOwner(ctx context.Context, email string) (string, error) {
	row, err := o.s.Store.GetAccountEmail(ctx, email)
	if errors.Is(err, store.ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if row.State != store.EmailActive {
		return "", nil
	}
	gone, err := o.s.accountGone(ctx, row.UID)
	if err != nil {
		return "", err
	}
	if gone {
		_, err := o.s.Store.ReleaseAllAccountEmails(ctx, row.UID, "gone")
		return "", err
	}
	id, err := o.s.identityOrNil(ctx, row.UID)
	if err != nil {
		return "", err
	}
	if id != nil {
		if id.Disabled {
			return "", auth.ErrUserDisabled
		}
		if normalEmail(id.Email) == normalEmail(email) {
			// Its Firebase email: the usual path, which also proves it
			// (an unverified email is marked verified, an unproven
			// password dropped), as long as Firebase's lookup lands on
			// this account too. Two Firebase users can share an email
			// (from before one account per email): the row decides.
			if admin := o.s.identities(); admin != nil {
				if hit, err := admin.IdentityByEmail(ctx, email); err == nil && hit != nil && hit.UID != row.UID {
					return row.UID, nil
				}
			}
			return "", nil
		}
	}
	return row.UID, nil
}

func (o emailOwners) SignedIn(ctx context.Context, uid, email string, created bool) {
	if _, err := o.s.addEmail(ctx, store.AddEmailSpec{UID: uid, Email: normalEmail(email), Source: "code", Verified: true,
		MainIfNone: true, Claim: true, Who: "signin"}); err != nil {
		slog.WarnContext(ctx, "email sign-in not recorded in the email store", "created", created, "err", err)
	}
}
