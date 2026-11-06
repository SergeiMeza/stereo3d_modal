package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/auth"
	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/identity"
	"spatial-ai-labs/stereo3d-gateway/internal/mail"
)

// Linked sign-in methods, server-side (the app's sign-in contract,
// 2026-11-06: the Firebase SDK's linking doesn't reach Google from China,
// and svs-backend proxies these routes for the app):
//
//   - GET /v1/account/identities → {providers, email, email_verified,
//     password, passkeys, anonymous, other_account}. other_account (or
//     null): this account's email is another account's in the email
//     store, so an Apple or Google sign-in made a second account; the web
//     offers "Sign in to that account" (see otherAccountFor). providers are the sign-in methods:
//     apple.com, google.com, email (the account has an email, so the
//     email code signs in to it). A password is reported apart; the email
//     code covers a password account too.
//   - POST /v1/account/identities/link {provider: apple.com|google.com,
//     id_token, nonce?} links that sign-in onto the caller's account
//     (Firebase signInWithIdp with the caller's ID token: the uid stays,
//     an anonymous account included). A Google ID token's audience must
//     be an OAuth client of this project. {provider: email, email, code}
//     checks an email code (/v1/auth/email/start) without signing in and
//     puts the address on the caller's account through the email store
//     (account_emails.go): an additional email, or with replace: true the
//     main one, the old main kept as additional; the same address again
//     is a no-op. session: true
//     also answers fresh tokens for the caller (Apple/Google links).
//   - DELETE /v1/account/identities/{provider} unlinks apple.com,
//     google.com or password. email can't be removed (409
//     email_not_removable): it is the account's address.
//   - 409 last_method: removing it (or the last passkey) would leave no
//     way to sign in; passkeys count. 409 credential_in_use {providers}:
//     that sign-in or address belongs to another account, named only by
//     how it signs in (never its uid).

// IdentityAdmin reads and changes an account's sign-in methods
// (auth.Verifier).
type IdentityAdmin interface {
	IdentityOf(ctx context.Context, uid string) (*auth.Identity, error)
	IdentityByEmail(ctx context.Context, email string) (*auth.Identity, error)
	IdentityByProvider(ctx context.Context, providerID, providerUID string) (*auth.Identity, error)
	SetVerifiedEmail(ctx context.Context, uid, email string) error
	RemoveProviders(ctx context.Context, uid string, providers []string) error
}

// SessionIssuer makes sessions without the SDK (identity.Client).
type SessionIssuer interface {
	Configured() bool
	SignInWithCustomToken(ctx context.Context, token string) (*identity.Session, error)
	LinkWithIdP(ctx context.Context, callerIDToken, providerID, idpToken, nonce string) (*identity.LinkResult, error)
}

// EmailCodeChecker spends an email code without signing in
// (emailcode.Service).
type EmailCodeChecker interface {
	Peek(ctx context.Context, email, code string) error
	Check(ctx context.Context, email, code string) error
	StartIn(ctx context.Context, email string, lang mail.Lang) (time.Duration, error)
}

const (
	providerApple    = "apple.com"
	providerGoogle   = "google.com"
	providerPassword = "password"
	providerEmail    = "email"
	providerPasskey  = "passkey"

	identityLinksPerUIDHour = 20
	identityCallsPerIPHour  = 60
)

func (s *Service) identities() IdentityAdmin {
	if s.Identities != nil {
		return s.Identities
	}
	if s.Auth != nil {
		return s.Auth
	}
	return nil
}

// signInMethods are the ways id signs in, passkeys apart.
func signInMethods(id *auth.Identity) []string {
	out := []string{}
	for _, p := range id.Providers {
		if (p == providerApple || p == providerGoogle) && !slices.Contains(out, p) {
			out = append(out, p)
		}
	}
	if strings.TrimSpace(id.Email) != "" {
		out = append(out, providerEmail)
	}
	return out
}

func (s *Service) passkeyCount(ctx context.Context, uid string) (int, error) {
	all, err := s.Store.ListCustomerPasskeys(ctx, uid)
	return len(all), err
}

func (s *Service) identitiesJSON(ctx context.Context, uid string) (map[string]any, error) {
	admin := s.identities()
	if admin == nil {
		return nil, errIdentityUnavailable()
	}
	id, err := admin.IdentityOf(ctx, uid)
	if err != nil {
		return nil, err
	}
	n, err := s.passkeyCount(ctx, uid)
	if err != nil {
		return nil, err
	}
	methods := signInMethods(id)
	return map[string]any{"providers": methods, "email": id.Email, "email_verified": id.EmailVerified,
		"password": slices.Contains(id.Providers, providerPassword), "passkeys": n,
		"anonymous": len(methods) == 0 && n == 0, "other_account": s.otherAccountFor(ctx, id)}, nil
}

// otherAccountFor spots an Apple or Google sign-in that made a new account
// although its email is another account's (an additional email there:
// Firebase only knows main emails). → {email_masked, providers,
// sign_in_with: "email_code"}: "This email belongs to another account.
// Sign in to it?" (the email code to that address signs in there); nil
// otherwise. The other account is named only by how it signs in.
func (s *Service) otherAccountFor(ctx context.Context, id *auth.Identity) any {
	email := normalEmail(id.Email)
	if email == "" || s.Store == nil {
		return nil
	}
	owner, err := s.Store.EmailOwner(ctx, email)
	if err != nil || owner == "" || owner == id.UID {
		return nil
	}
	if gone, err := s.accountGone(ctx, owner); err != nil || gone {
		return nil
	}
	providers := []string{}
	if other, err := s.identityOrNil(ctx, owner); err == nil && other != nil {
		providers = signInMethods(other)
		if n, err := s.passkeyCount(ctx, owner); err == nil && n > 0 {
			providers = append(providers, providerPasskey)
		}
	}
	return map[string]any{"email_masked": maskEmail(email), "providers": providers, "sign_in_with": "email_code"}
}

func errIdentityUnavailable() *httpx.APIError {
	return httpx.Err(http.StatusServiceUnavailable, "identity_unavailable", "Sign-in methods can't be changed right now. Try again later.")
}

func errLastMethod() *httpx.APIError {
	return httpx.Err(http.StatusConflict, "last_method", "That's your only way to sign in. Add another first.")
}

// credentialInUse names the other account only by how it signs in.
func (s *Service) credentialInUse(ctx context.Context, other *auth.Identity) *httpx.APIError {
	e := httpx.Err(http.StatusConflict, "credential_in_use", "That sign-in belongs to another account.")
	providers := []string{}
	if other != nil {
		providers = signInMethods(other)
		if n, err := s.passkeyCount(ctx, other.UID); err == nil && n > 0 {
			providers = append(providers, providerPasskey)
		}
	}
	e.Details = map[string]any{"providers": providers}
	return e
}

func identityAllowed(r *http.Request, uid string) bool {
	now := time.Now()
	return eventAllowed("idn-ip:"+clientIP(r), identityCallsPerIPHour, now) &&
		eventAllowed("idn-uid:"+uid, identityLinksPerUIDHour, now)
}

// GET /v1/account/identities.
func (s *Service) HandleIdentities(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	out, err := s.identitiesJSON(r.Context(), user.UID)
	if err != nil {
		httpx.WriteErr(r.Context(), w, identityErr(r.Context(), "read", err))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, out)
}

func identityErr(ctx context.Context, op string, err error) error {
	var api *httpx.APIError
	if errors.As(err, &api) {
		return api
	}
	slog.WarnContext(ctx, "identity call failed", "op", op, "err", err)
	return errIdentityUnavailable()
}

// POST /v1/account/identities/link.
func (s *Service) HandleLinkIdentity(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		Provider string `json:"provider"`
		IDToken  string `json:"id_token"`
		Nonce    string `json:"nonce"`
		Email    string `json:"email"`
		Code     string `json:"code"`
		Session  bool   `json:"session"`
		// Replace: the linked email becomes main (the old one stays).
		Replace bool `json:"replace"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("body must be a JSON object"))
		return
	}
	admin := s.identities()
	if admin == nil {
		httpx.WriteErr(ctx, w, errIdentityUnavailable())
		return
	}
	switch req.Provider {
	case providerApple, providerGoogle:
		if req.IDToken == "" || len(req.IDToken) > 8192 || len(req.Nonce) > 256 {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("id_token is required"))
			return
		}
	case providerEmail:
		if strings.TrimSpace(req.Email) == "" || strings.TrimSpace(req.Code) == "" {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("email and code are required"))
			return
		}
	default:
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("provider is apple.com, google.com or email"))
		return
	}
	if !identityAllowed(r, user.UID) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusTooManyRequests, "rate_limited", "Too many attempts. Try again in a while."))
		return
	}
	var session *identity.Session
	if req.Provider == providerEmail {
		if err := s.linkEmail(ctx, user.UID, req.Email, req.Code, req.Replace); err != nil {
			httpx.WriteErr(ctx, w, identityErr(ctx, "link_email", err))
			return
		}
	} else {
		sess, err := s.linkIdP(ctx, admin, r, user.UID, req.Provider, req.IDToken, req.Nonce)
		if err != nil {
			httpx.WriteErr(ctx, w, identityErr(ctx, "link_idp", err))
			return
		}
		session = sess
	}
	out, err := s.identitiesJSON(ctx, user.UID)
	if err != nil {
		httpx.WriteErr(ctx, w, identityErr(ctx, "read", err))
		return
	}
	if req.Session && session != nil {
		out["session"] = session
	}
	s.passkeyEvent(ctx, user.UID, "link_provider", map[string]any{"method": req.Provider})
	slog.InfoContext(ctx, "sign-in method linked", "provider", req.Provider)
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, out)
}

// linkEmail puts a code-checked email on uid through the email store:
// an additional email, or with replace the main one (the old main stays
// as an additional email). The same email again is a no-op.
func (s *Service) linkEmail(ctx context.Context, uid, rawEmail, code string, replace bool) error {
	_, err := s.putEmail(ctx, uid, rawEmail, code, replace)
	return err
}

func (s *Service) linkIdP(ctx context.Context, admin IdentityAdmin, r *http.Request, uid, provider, idpToken, nonce string) (*identity.Session, error) {
	if s.Sessions == nil || !s.Sessions.Configured() {
		return nil, errIdentityUnavailable()
	}
	callerToken := bearerToken(r)
	res, err := s.Sessions.LinkWithIdP(ctx, callerToken, provider, idpToken, nonce)
	claims := unverifiedClaims(idpToken)
	if err != nil {
		switch identity.Code(err) {
		case "FEDERATED_USER_ID_ALREADY_LINKED":
			other, lerr := admin.IdentityByProvider(ctx, provider, claims.Sub)
			if lerr != nil {
				return nil, lerr
			}
			return nil, s.credentialInUse(ctx, other)
		case "EMAIL_EXISTS":
			other, lerr := admin.IdentityByEmail(ctx, claims.Email)
			if lerr != nil {
				return nil, lerr
			}
			return nil, s.credentialInUse(ctx, other)
		case "INVALID_IDP_RESPONSE", "INVALID_CREDENTIAL_OR_PROVIDER_ID", "MISSING_OR_INVALID_NONCE", "INVALID_PROVIDER_ID", "OPERATION_NOT_ALLOWED":
			return nil, httpx.Err(http.StatusBadRequest, "invalid_credential", "That sign-in couldn't be verified. Try again.")
		case "INVALID_ID_TOKEN", "TOKEN_EXPIRED", "CREDENTIAL_TOO_OLD_LOGIN_AGAIN", "USER_NOT_FOUND":
			return nil, httpx.Err(http.StatusUnauthorized, "reauth_required", "Sign in again, then link it.")
		}
		return nil, err
	}
	if res.NeedConfirmation {
		other, lerr := admin.IdentityByEmail(ctx, cmpOr(res.Email, claims.Email))
		if lerr != nil {
			return nil, lerr
		}
		return nil, s.credentialInUse(ctx, other)
	}
	if res.Session.UID != uid { // Firebase signed into the holder instead of linking
		other, lerr := admin.IdentityOf(ctx, res.Session.UID)
		if lerr != nil {
			return nil, lerr
		}
		return nil, s.credentialInUse(ctx, other)
	}
	if id, err := admin.IdentityOf(ctx, uid); err == nil && !slices.Contains(id.Providers, provider) {
		return nil, errors.New("link answered but the provider isn't on the account")
	}
	sess := res.Session
	return &sess, nil
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// DELETE /v1/account/identities/{provider}.
func (s *Service) HandleUnlinkIdentity(w http.ResponseWriter, r *http.Request, user *AuthedUser, provider string) {
	ctx := r.Context()
	admin := s.identities()
	if admin == nil {
		httpx.WriteErr(ctx, w, errIdentityUnavailable())
		return
	}
	switch provider {
	case providerApple, providerGoogle, providerPassword:
	case providerEmail:
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "email_not_removable", "Your email stays as your account's address."))
		return
	default:
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("provider is apple.com, google.com or password"))
		return
	}
	if !identityAllowed(r, user.UID) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusTooManyRequests, "rate_limited", "Too many attempts. Try again in a while."))
		return
	}
	id, err := admin.IdentityOf(ctx, user.UID)
	if err != nil {
		httpx.WriteErr(ctx, w, identityErr(ctx, "read", err))
		return
	}
	if !slices.Contains(id.Providers, provider) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusNotFound, "not_linked", "That sign-in isn't on your account."))
		return
	}
	if provider != providerPassword { // the email code still signs a password account in
		n, err := s.signInCount(ctx, id)
		if err != nil {
			httpx.WriteErr(ctx, w, httpx.ErrServer())
			return
		}
		if n-1 < 1 {
			httpx.WriteErr(ctx, w, errLastMethod())
			return
		}
	}
	if err := admin.RemoveProviders(ctx, user.UID, []string{provider}); err != nil {
		httpx.WriteErr(ctx, w, identityErr(ctx, "unlink", err))
		return
	}
	s.passkeyEvent(ctx, user.UID, "unlink_provider", map[string]any{"method": provider})
	out, err := s.identitiesJSON(ctx, user.UID)
	if err != nil {
		httpx.WriteErr(ctx, w, identityErr(ctx, "read", err))
		return
	}
	httpx.WriteOK(w, out)
}

// lastSignInMethod: removing one passkey would leave uid no way in.
func (s *Service) lastSignInMethod(ctx context.Context, uid string) (bool, error) {
	admin := s.identities()
	if admin == nil {
		return false, nil
	}
	id, err := admin.IdentityOf(ctx, uid)
	if err != nil {
		return false, err
	}
	n, err := s.signInCount(ctx, id)
	if err != nil {
		return false, err
	}
	return n-1 < 1, nil
}

func bearerToken(r *http.Request) string {
	parts := strings.SplitN(r.Header.Get("Authorization"), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

type idpClaims struct {
	Sub   string `json:"sub"`
	Email string `json:"email"`
}

// unverifiedClaims reads a provider ID token's sub and email without
// checking it: only to find which account already holds a credential
// Firebase has just verified and refused.
func unverifiedClaims(tok string) idpClaims {
	var c idpClaims
	parts := strings.Split(tok, ".")
	if len(parts) != 3 {
		return c
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return c
	}
	_ = json.Unmarshal(raw, &c)
	return c
}
