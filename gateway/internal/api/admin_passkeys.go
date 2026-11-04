package api

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-webauthn/webauthn/protocol"
	"github.com/go-webauthn/webauthn/webauthn"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Admin passkeys (ADR 0135): the admin console's second factor, in place
// of the Identity Platform TOTP plan (which keeps working as an
// alternative until the owner retires it).
//
//   - Relying parties: prod admin.stereo3d.studio; test
//     admin-test.stereo3d.studio and localhost (http://localhost:5174);
//     each accepts its own origin only. userVerification required,
//     residentKey preferred, attestation none.
//   - The first passkey of a uid needs a fresh Google sign-in (token
//     auth_time within 5 minutes); any further one also needs a passkey
//     session whose last assertion is within 5 minutes.
//   - A passkey assertion yields an admin session token (HMAC-SHA256 with
//     ADMIN_SESSION_KEY; claims uid, iat, exp = 12 h, last_assertion_at,
//     the uid's session epoch), sent as X-Admin-Session. Money actions
//     need last_assertion_at within 5 minutes (else 401 reauth_required
//     {method: "passkey"}); POST /v1/admin/session/reassert refreshes it.
//   - Challenges are single-use (deleted when read), 5 minutes, bound to
//     the uid, the purpose and the origin. A sign count that doesn't go
//     up (where the authenticator counts) is refused as a possible clone.

const (
	passkeyTTL      = 5 * time.Minute
	adminSessionTTL = 12 * time.Hour
	passkeyNameMax  = 60
	purposeRegister = "register"
	purposeSession  = "session"  // sign_in
	purposeReassert = "reassert" // a fresh assertion for an existing session
)

// sessionPurpose reads the console's purpose (sign_in | reassert; ""
// is sign_in).
func sessionPurpose(p string) (string, bool) {
	switch p {
	case "", "sign_in", "session":
		return purposeSession, true
	case "reassert":
		return purposeReassert, true
	}
	return "", false
}

type passkeyRP struct {
	id     string
	origin string
	wa     *webauthn.WebAuthn
}

// passkeyRPFor is the relying party for a request's Origin (nil: the
// origin may not use passkeys).
func (s *Service) passkeyRPFor(origin string) *passkeyRP {
	s.pkOnce.Do(func() {
		s.pkRPs = map[string]*passkeyRP{}
		pairs := [][2]string{{"admin.stereo3d.studio", "https://admin.stereo3d.studio"}}
		if s.Cfg.Env != "prod" {
			pairs = [][2]string{{"admin-test.stereo3d.studio", "https://admin-test.stereo3d.studio"}, {"localhost", "http://localhost:5174"}}
		}
		for _, p := range pairs {
			allowed := false
			for _, o := range s.Cfg.AdminOrigins {
				allowed = allowed || o == p[1]
			}
			if !allowed {
				continue
			}
			wa, err := webauthn.New(&webauthn.Config{
				RPID: p[0], RPDisplayName: "Spatial Video Studio Admin", RPOrigins: []string{p[1]},
				AttestationPreference: protocol.PreferNoAttestation,
				AuthenticatorSelection: protocol.AuthenticatorSelection{
					ResidentKey: protocol.ResidentKeyRequirementPreferred, UserVerification: protocol.VerificationRequired,
				},
				Timeouts: webauthn.TimeoutsConfig{
					Login:        webauthn.TimeoutConfig{Enforce: true, Timeout: passkeyTTL, TimeoutUVD: passkeyTTL},
					Registration: webauthn.TimeoutConfig{Enforce: true, Timeout: passkeyTTL, TimeoutUVD: passkeyTTL},
				},
			})
			if err != nil {
				slog.Error("passkey relying party not configured", "rp_id", p[0], "err", err)
				continue
			}
			s.pkRPs[p[1]] = &passkeyRP{id: p[0], origin: p[1], wa: wa}
		}
	})
	return s.pkRPs[origin]
}

// adminWAUser is an admin as the WebAuthn library sees them: the user
// handle is the uid; the credentials are their passkeys on this RP.
type adminWAUser struct {
	uid, email string
	creds      []webauthn.Credential
}

func (u *adminWAUser) WebAuthnID() []byte                         { return []byte(u.uid) }
func (u *adminWAUser) WebAuthnName() string                       { return firstNonEmpty(u.email, "admin") }
func (u *adminWAUser) WebAuthnDisplayName() string                { return firstNonEmpty(u.email, "Admin") }
func (u *adminWAUser) WebAuthnCredentials() []webauthn.Credential { return u.creds }

func credentialOf(p *store.AdminPasskey) (webauthn.Credential, bool) {
	var c webauthn.Credential
	if json.Unmarshal([]byte(p.Credential), &c) != nil {
		return c, false
	}
	return c, true
}

// adminWAUserFor loads uid's passkeys (on rp; all of them when rp is nil).
func (s *Service) adminWAUserFor(ctx context.Context, a *AdminUser, rp *passkeyRP) (*adminWAUser, []*store.AdminPasskey, error) {
	all, err := s.Store.ListAdminPasskeys(ctx, a.UID)
	if err != nil {
		return nil, nil, err
	}
	u := &adminWAUser{uid: a.UID, email: a.Email}
	var mine []*store.AdminPasskey
	for _, p := range all {
		if rp != nil && p.RPID != rp.id {
			continue
		}
		if c, ok := credentialOf(p); ok {
			u.creds = append(u.creds, c)
			mine = append(mine, p)
		}
	}
	return u, all, nil
}

// ----------------------------------------------------------- sessions

// AdminSession is a verified X-Admin-Session.
type AdminSession struct {
	UID             string `json:"uid"`
	IssuedAt        int64  `json:"iat"`
	ExpiresAt       int64  `json:"exp"`
	LastAssertionAt int64  `json:"last_assertion_at"`
	Epoch           int64  `json:"ep"`
	ID              string `json:"sid"`
}

// Session errors, as the console reads them: session_required (none
// sent), session_expired, invalid_session (bad signature, another
// account's, revoked by a break-glass reset); the console drops its token
// on any of them.
var (
	errNoSession      = errors.New("session_required")
	errSessionExpired = errors.New("session_expired")
	errSessionInvalid = errors.New("invalid_session")
)

// SessionErrCode is the error code for a session error.
func SessionErrCode(err error) string {
	switch {
	case errors.Is(err, errNoSession):
		return "session_required"
	case errors.Is(err, errSessionExpired):
		return "session_expired"
	}
	return "invalid_session"
}

func (s *Service) signAdminSession(sess AdminSession) (string, error) {
	if s.Cfg.AdminSessionKey == "" {
		return "", errors.New("admin sessions not configured")
	}
	raw, _ := json.Marshal(sess)
	payload := base64.RawURLEncoding.EncodeToString(raw)
	mac := hmac.New(sha256.New, []byte(s.Cfg.AdminSessionKey))
	mac.Write([]byte("v1." + payload))
	return "v1." + payload + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil)), nil
}

// AdminSessionOf verifies the X-Admin-Session header for uid
// (errNoSession when there is none).
func (s *Service) AdminSessionOf(ctx context.Context, r *http.Request, uid string) (*AdminSession, error) {
	tok := strings.TrimSpace(r.Header.Get("X-Admin-Session"))
	if tok == "" {
		return nil, errNoSession
	}
	if s.Cfg.AdminSessionKey == "" {
		return nil, errSessionInvalid
	}
	parts := strings.Split(tok, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return nil, errSessionInvalid
	}
	mac := hmac.New(sha256.New, []byte(s.Cfg.AdminSessionKey))
	mac.Write([]byte("v1." + parts[1]))
	sig, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil || !hmac.Equal(sig, mac.Sum(nil)) {
		return nil, errSessionInvalid
	}
	raw, err := base64.RawURLEncoding.DecodeString(parts[1])
	var sess AdminSession
	if err != nil || json.Unmarshal(raw, &sess) != nil || sess.UID != uid {
		return nil, errSessionInvalid
	}
	if time.Now().Unix() >= sess.ExpiresAt {
		return nil, errSessionExpired
	}
	ep, err := s.Store.SessionEpoch(ctx, uid)
	if err != nil {
		return nil, err
	}
	if ep != sess.Epoch {
		return nil, errSessionInvalid
	}
	return &sess, nil
}

// AdminUserFor builds the caller of an admin route from a verified
// Firebase admin token: a valid X-Admin-Session makes the method
// "passkey"; without one, totp says whether the token carries the old
// second factor. ok=false: no second factor at all; sessErr: a session
// header that didn't verify.
func (s *Service) AdminUserFor(r *http.Request, uid, email string, authTime time.Time, totp bool) (a *AdminUser, ok bool, sessErr error) {
	a = &AdminUser{UID: uid, Email: email, AuthTime: authTime, Method: "totp"}
	sess, err := s.AdminSessionOf(r.Context(), r, uid)
	switch {
	case err == nil:
		a.Method, a.AssertedAt, a.Session = "passkey", time.Unix(sess.LastAssertionAt, 0).UTC(), sess
		return a, true, nil
	case errors.Is(err, errNoSession):
		return a, totp, nil
	}
	return a, false, err
}

func newSessionID() string {
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

// ------------------------------------------------------------- handlers

func passkeyReauth(method, msg string) error {
	e := httpx.Err(http.StatusUnauthorized, "reauth_required", msg)
	e.Details = map[string]any{"method": method}
	return e
}

func (s *Service) requirePasskeyRP(w http.ResponseWriter, r *http.Request) *passkeyRP {
	rp := s.passkeyRPFor(r.Header.Get("Origin"))
	if rp == nil {
		httpx.WriteErr(r.Context(), w, httpx.Err(http.StatusForbidden, "origin_not_allowed", "Passkeys work from the admin console's own address only."))
	}
	return rp
}

// enrolmentAllowed: the first passkey needs a fresh Google sign-in; a
// further one also needs a fresh passkey assertion.
func (s *Service) enrolmentAllowed(a *AdminUser, existing int) error {
	if existing == 0 {
		if time.Since(a.AuthTime) > adminFresh {
			return passkeyReauth("google", "Sign in with Google again, then add your first passkey within 5 minutes.")
		}
		return nil
	}
	if a.Method != "passkey" || time.Since(a.AssertedAt) > adminFresh {
		return passkeyReauth("passkey", "Confirm with one of your passkeys first.")
	}
	return nil
}

func challengeOf(c protocol.URLEncodedBase64) string { return base64.RawURLEncoding.EncodeToString(c) }

// POST /v1/admin/passkeys/register/options {name?} → {options
// (PublicKeyCredentialCreationOptions as {publicKey}), expires_at}.
func (s *Service) HandlePasskeyRegisterOptions(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	rp := s.requirePasskeyRP(w, r)
	if rp == nil {
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req)
	name := strings.TrimSpace(req.Name)
	if utf8.RuneCountInString(name) > passkeyNameMax {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid(fmt.Sprintf("name: at most %d characters", passkeyNameMax)))
		return
	}
	u, all, err := s.adminWAUserFor(ctx, a, rp)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	if err := s.enrolmentAllowed(a, len(all)); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	excl := make([]protocol.CredentialDescriptor, 0, len(u.creds))
	for _, c := range u.creds {
		excl = append(excl, c.Descriptor())
	}
	creation, session, err := rp.wa.BeginRegistration(u, webauthn.WithExclusions(excl),
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementPreferred), webauthn.WithRegistrationOrigin(rp.origin))
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	if err := s.saveChallenge(ctx, a, rp, purposeRegister, name, session); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	httpx.WriteOK(w, map[string]any{"options": creation, "expires_at": time.Now().Add(passkeyTTL).UTC()})
}

func (s *Service) saveChallenge(ctx context.Context, a *AdminUser, rp *passkeyRP, purpose, name string, session *webauthn.SessionData) error {
	raw, err := json.Marshal(session)
	if err != nil {
		return err
	}
	return s.Store.PutPasskeyChallenge(ctx, session.Challenge, &store.PasskeyChallenge{UID: a.UID, Purpose: purpose, RPID: rp.id, Origin: rp.origin,
		Session: string(raw), Name: name, ExpiresAt: time.Now().Add(passkeyTTL).UTC()})
}

// takeChallenge consumes the response's challenge and checks it was made
// for this uid, purpose and origin, and hasn't expired.
func (s *Service) takeChallenge(ctx context.Context, a *AdminUser, rp *passkeyRP, purpose, challenge string) (*store.PasskeyChallenge, *webauthn.SessionData, error) {
	bad := httpx.Err(http.StatusBadRequest, "challenge_invalid", "That passkey request expired or was already used. Start again.")
	c, err := s.Store.ConsumePasskeyChallenge(ctx, challenge)
	if err != nil || c.UID != a.UID || c.Purpose != purpose || c.RPID != rp.id || c.Origin != rp.origin || time.Now().After(c.ExpiresAt) {
		return nil, nil, bad
	}
	var session webauthn.SessionData
	if json.Unmarshal([]byte(c.Session), &session) != nil {
		return nil, nil, bad
	}
	return c, &session, nil
}

func passkeyJSON(p *store.AdminPasskey) map[string]any {
	return map[string]any{"id": p.ID, "name": p.Name, "created_at": p.CreatedAt, "last_used_at": p.LastUsedAt}
}

// POST /v1/admin/passkeys/register/verify {name?, credential} → 201
// {passkey {id, name, created_at, last_used_at}}.
func (s *Service) HandlePasskeyRegisterVerify(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	rp := s.requirePasskeyRP(w, r)
	if rp == nil {
		return
	}
	var req struct {
		Name       string          `json:"name"`
		Response   json.RawMessage `json:"response"`
		Credential json.RawMessage `json:"credential"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil || (len(req.Response) == 0 && len(req.Credential) == 0) {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("response is required"))
		return
	}
	if len(req.Response) > 0 {
		req.Credential = req.Response
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(req.Credential)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "passkey_invalid", "That passkey response couldn't be read."))
		return
	}
	ch, session, err := s.takeChallenge(ctx, a, rp, purposeRegister, parsed.Response.CollectedClientData.Challenge)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	u, all, err := s.adminWAUserFor(ctx, a, rp)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	if err := s.enrolmentAllowed(a, len(all)); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	cred, err := rp.wa.CreateCredential(u, *session, parsed)
	if err != nil {
		slog.WarnContext(ctx, "passkey registration refused", "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "passkey_invalid", "That passkey couldn't be verified."))
		return
	}
	name := firstNonEmpty(strings.TrimSpace(req.Name), firstNonEmpty(ch.Name, "Passkey"))
	if utf8.RuneCountInString(name) > passkeyNameMax {
		name = string([]rune(name)[:passkeyNameMax])
	}
	raw, _ := json.Marshal(cred)
	transports := make([]string, 0, len(cred.Transport))
	for _, t := range cred.Transport {
		transports = append(transports, string(t))
	}
	p := &store.AdminPasskey{ID: base64.RawURLEncoding.EncodeToString(cred.ID), UID: a.UID, Name: name, PublicKey: cred.PublicKey,
		SignCount: int64(cred.Authenticator.SignCount), AAGUID: hex.EncodeToString(cred.Authenticator.AAGUID), Transports: transports,
		RPID: rp.id, CreatedAt: time.Now().UTC(), Credential: string(raw)}
	if err := s.Store.CreateAdminPasskey(ctx, p); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "passkey_exists", "That passkey is already registered."))
			return
		}
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	s.audit(ctx, a, "admin_passkey_added", map[string]any{"passkey_id": p.ID, "name": name, "rp_id": rp.id})
	s.Slack.Alert(ctx, "admin_passkey_added", fmt.Sprintf("admin passkey added for `%s`: %q · origin %s · country %s", a.UID, name, rp.origin, orDash(requestCountry(r))))
	writeJSON(w, http.StatusCreated, map[string]any{"passkey": passkeyJSON(p)})
}

// POST /v1/admin/session/options {purpose?: sign_in | reassert} →
// {options ({publicKey}), expires_at}; 409 no_passkey when the account
// has none on this origin; reassert needs the session (401
// session_required).
func (s *Service) HandleAdminSessionOptions(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	rp := s.requirePasskeyRP(w, r)
	if rp == nil {
		return
	}
	var req struct {
		Purpose string `json:"purpose"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req)
	purpose, ok := sessionPurpose(req.Purpose)
	if !ok {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("purpose: sign_in or reassert"))
		return
	}
	if purpose == purposeReassert && a.Session == nil {
		httpx.WriteErr(ctx, w, sessionRequired())
		return
	}
	u, _, err := s.adminWAUserFor(ctx, a, rp)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	if len(u.creds) == 0 {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "no_passkey", "Add a passkey first."))
		return
	}
	assertion, session, err := rp.wa.BeginLogin(u, webauthn.WithUserVerification(protocol.VerificationRequired), webauthn.WithLoginOrigin(rp.origin))
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	if err := s.saveChallenge(ctx, a, rp, purpose, "", session); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	httpx.WriteOK(w, map[string]any{"options": assertion, "expires_at": time.Now().Add(passkeyTTL).UTC()})
}

func sessionRequired() error {
	return httpx.Err(http.StatusUnauthorized, "session_required", "Start a passkey session first.")
}

// assertionReq is a session verify body: {purpose?, response} (the
// console) or {credential} (the same PublicKeyCredential JSON).
type assertionReq struct {
	Purpose    string          `json:"purpose"`
	Response   json.RawMessage `json:"response"`
	Credential json.RawMessage `json:"credential"`
}

func (q assertionReq) cred() json.RawMessage {
	if len(q.Response) > 0 {
		return q.Response
	}
	return q.Credential
}

// verifyAssertion checks an assertion made for purpose and records the
// use.
func (s *Service) verifyAssertion(w http.ResponseWriter, r *http.Request, a *AdminUser, purpose string, body json.RawMessage) bool {
	ctx := r.Context()
	rp := s.requirePasskeyRP(w, r)
	if rp == nil {
		return false
	}
	if len(body) == 0 {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("response is required"))
		return false
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(body)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "passkey_invalid", "That passkey response couldn't be read."))
		return false
	}
	_, session, err := s.takeChallenge(ctx, a, rp, purpose, parsed.Response.CollectedClientData.Challenge)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return false
	}
	u, all, err := s.adminWAUserFor(ctx, a, rp)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return false
	}
	cred, err := rp.wa.ValidateLogin(u, *session, parsed)
	if err != nil {
		slog.WarnContext(ctx, "passkey assertion refused", "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusUnauthorized, "passkey_invalid", "That passkey couldn't be verified."))
		return false
	}
	id := base64.RawURLEncoding.EncodeToString(cred.ID)
	var stored *store.AdminPasskey
	for _, p := range all {
		if p.ID == id {
			stored = p
		}
	}
	if stored == nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusUnauthorized, "passkey_invalid", "That passkey couldn't be verified."))
		return false
	}
	if cred.Authenticator.CloneWarning { // the counter didn't go up
		s.Slack.Alert(ctx, "admin_passkey_clone_suspected", fmt.Sprintf("admin passkey %q of `%s` reported sign count %d (stored %d): refused",
			stored.Name, a.UID, parsed.Response.AuthenticatorData.Counter, stored.SignCount))
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusUnauthorized, "passkey_clone_suspected", "That passkey's counter went backwards. Use another passkey and tell the owner."))
		return false
	}
	raw, _ := json.Marshal(cred)
	if err := s.Store.UseAdminPasskey(ctx, id, stored.SignCount, int64(cred.Authenticator.SignCount), string(raw), time.Now().UTC()); err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusUnauthorized, "passkey_invalid", "That passkey was used meanwhile. Try again."))
		return false
	}
	return true
}

func (s *Service) writeSession(w http.ResponseWriter, r *http.Request, sess AdminSession) {
	tok, err := s.signAdminSession(sess)
	if err != nil {
		httpx.WriteErr(r.Context(), w, httpx.Err(http.StatusServiceUnavailable, "sessions_unavailable", "Passkey sessions aren't configured here."))
		return
	}
	httpx.WriteOK(w, map[string]any{"session": tok, "expires_at": time.Unix(sess.ExpiresAt, 0).UTC(),
		"last_assertion_at": time.Unix(sess.LastAssertionAt, 0).UTC()})
}

// POST /v1/admin/session/verify {purpose?: sign_in | reassert,
// response} → {session, expires_at, last_assertion_at}. sign_in starts a
// session; reassert (with X-Admin-Session) returns the same session with
// last_assertion_at now.
func (s *Service) HandleAdminSessionVerify(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	var req assertionReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		httpx.WriteErr(r.Context(), w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	purpose, ok := sessionPurpose(req.Purpose)
	if !ok {
		httpx.WriteErr(r.Context(), w, httpx.ErrInvalid("purpose: sign_in or reassert"))
		return
	}
	if purpose == purposeReassert {
		s.reassert(w, r, a, req)
		return
	}
	if s.Cfg.AdminSessionKey == "" {
		httpx.WriteErr(r.Context(), w, httpx.Err(http.StatusServiceUnavailable, "sessions_unavailable", "Passkey sessions aren't configured here."))
		return
	}
	if !s.verifyAssertion(w, r, a, purposeSession, req.cred()) {
		return
	}
	ep, err := s.Store.SessionEpoch(r.Context(), a.UID)
	if err != nil {
		httpx.WriteErr(r.Context(), w, httpx.ErrServer())
		return
	}
	now := time.Now().UTC()
	s.writeSession(w, r, AdminSession{UID: a.UID, IssuedAt: now.Unix(), ExpiresAt: now.Add(adminSessionTTL).Unix(), LastAssertionAt: now.Unix(),
		Epoch: ep, ID: newSessionID()})
}

// POST /v1/admin/session/reassert {response} with X-Admin-Session: the
// same as verify with purpose reassert (options from purpose reassert;
// a sign_in challenge is accepted here too).
func (s *Service) HandleAdminSessionReassert(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	var req assertionReq
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil {
		httpx.WriteErr(r.Context(), w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	s.reassert(w, r, a, req)
}

func (s *Service) reassert(w http.ResponseWriter, r *http.Request, a *AdminUser, req assertionReq) {
	if a.Session == nil {
		httpx.WriteErr(r.Context(), w, sessionRequired())
		return
	}
	purpose := purposeReassert
	if req.Purpose == "" { // the older reassert route reads options made for sign_in
		purpose = s.challengePurposeOf(r.Context(), req.cred())
	}
	if !s.verifyAssertion(w, r, a, purpose, req.cred()) {
		return
	}
	sess := *a.Session
	sess.LastAssertionAt = time.Now().Unix()
	s.writeSession(w, r, sess)
}

// challengePurposeOf peeks at the purpose a response's challenge was made
// for (reassert or session; it is consumed and checked by the verify).
func (s *Service) challengePurposeOf(ctx context.Context, body json.RawMessage) string {
	parsed, err := protocol.ParseCredentialRequestResponseBytes(body)
	if err != nil {
		return purposeReassert
	}
	if c, err := s.Store.PeekPasskeyChallenge(ctx, parsed.Response.CollectedClientData.Challenge); err == nil && c.Purpose == purposeSession {
		return purposeSession
	}
	return purposeReassert
}

// GET /v1/admin/passkeys → {passkeys: [{id, name, created_at,
// last_used_at}]}, oldest first.
func (s *Service) HandleAdminPasskeys(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	all, err := s.Store.ListAdminPasskeys(r.Context(), a.UID)
	if err != nil {
		httpx.WriteErr(r.Context(), w, httpx.ErrServer())
		return
	}
	sort.Slice(all, func(i, j int) bool { return all[i].CreatedAt.Before(all[j].CreatedAt) })
	out := make([]map[string]any, 0, len(all))
	for _, p := range all {
		out = append(out, passkeyJSON(p))
	}
	httpx.WriteOK(w, map[string]any{"passkeys": out})
}

// DELETE /v1/admin/passkeys/{id}: a passkey assertion within 5 minutes;
// never the last one (409 last_passkey).
func (s *Service) HandleAdminDeletePasskey(w http.ResponseWriter, r *http.Request, a *AdminUser, id string) {
	ctx := r.Context()
	if a.Method != "passkey" || time.Since(a.AssertedAt) > adminFresh {
		httpx.WriteErr(ctx, w, passkeyReauth("passkey", "Confirm with one of your passkeys first."))
		return
	}
	all, err := s.Store.ListAdminPasskeys(ctx, a.UID)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	var target *store.AdminPasskey
	for _, p := range all {
		if p.ID == id {
			target = p
		}
	}
	if target == nil {
		httpx.WriteErr(ctx, w, httpx.ErrNotFound("passkey"))
		return
	}
	if len(all) <= 1 {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "last_passkey", "That's your only passkey. Add another before removing it."))
		return
	}
	if err := s.Store.DeleteAdminPasskey(ctx, id); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	s.audit(ctx, a, "admin_passkey_removed", map[string]any{"passkey_id": id, "name": target.Name})
	s.Slack.Alert(ctx, "admin_passkey_removed", fmt.Sprintf("admin passkey removed for `%s`: %q · origin %s · country %s", a.UID, target.Name,
		orDash(r.Header.Get("Origin")), orDash(requestCountry(r))))
	httpx.WriteOK(w, map[string]any{"removed": id})
}

// ValidPasskeyID: a credential id as stored (base64url).
func ValidPasskeyID(id string) bool {
	return id != "" && len(id) <= 1400 && !strings.ContainsFunc(id, func(c rune) bool {
		return !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '-' || c == '_')
	})
}
