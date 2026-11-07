package api

import (
	"context"
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
	"spatial-ai-labs/stereo3d-gateway/internal/identity"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Customer passkeys (ADR 0136): an extra way to sign in to an existing
// account (made with Apple, Google or email first). The gateway runs the
// WebAuthn ceremonies with the admin code but its own relying party and
// store (customer_passkeys_{env}; test and prod apart):
//
//   - RP ID stereo3d.studio for https://stereo3d.studio, www and staging;
//     on test also RP localhost for the web's dev server
//     (http://localhost:3000). User verification required, discoverable
//     credentials (sign-in is usernameless), attestation none, the sign
//     counter checked (a regression is logged and refused).
//   - Adding a passkey needs a Firebase sign-in from the last 5 minutes
//     (401 reauth_required {method: "firebase"}). A verified sign-in
//     assertion returns a Firebase custom token for the passkey's uid; the
//     web calls signInWithCustomToken.
//   - Rate limits per IP and per account; events for every add, remove,
//     rename and sign-in (sign_in {method}); a plain security mail when a
//     passkey is added or removed; account deletion removes them.

const (
	cpkPurposeRegister = "register"
	cpkPurposeSignIn   = "sign_in"
	cpkPerIPHour       = 60
	cpkPerUIDHour      = 20
	cpkNativePerIPHour = 30 // the app's calls (nativeClient), their own bucket
	cpkFresh           = FreshSignInWindow
)

// customerRPFor is the customers' relying party for a request's Origin.
func (s *Service) customerRPFor(origin string) *passkeyRP {
	s.cpkOnce.Do(func() {
		specs := []rpSpec{{id: "stereo3d.studio", origins: []string{"https://stereo3d.studio", "https://www.stereo3d.studio", "https://staging.stereo3d.studio"}}}
		if s.Cfg.Env != "prod" {
			specs = append(specs, rpSpec{id: "localhost", origins: []string{"http://localhost:3000"}})
		}
		s.cpkRPs = buildPasskeyRPs("Spatial Video Studio", specs, func(string) bool { return true }, protocol.ResidentKeyRequirementRequired)
	})
	return s.cpkRPs[origin]
}

// nativeOrigin is the relying party the app's native passkeys use: Apple's
// passkey API signs client data with origin https://<RP ID>, the same
// stereo3d.studio relying party the web uses (one passkey for both).
const nativeOrigin = "https://stereo3d.studio"

// nativeClient: the app (X-SVS-Client: app/<version>), which sends no
// Origin. Its calls get their own rate-limit buckets; the client data's
// origin is still checked against the relying party.
func nativeClient(r *http.Request) bool {
	if r.Header.Get("Origin") != "" {
		return false
	}
	v := strings.TrimSpace(r.Header.Get("X-SVS-Client"))
	ver, ok := strings.CutPrefix(v, "app/")
	if !ok || ver == "" || len(ver) > 32 {
		return false
	}
	return strings.Trim(ver, "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-+") == ""
}

func (s *Service) requireCustomerRP(w http.ResponseWriter, r *http.Request) *passkeyRP {
	origin := r.Header.Get("Origin")
	if origin == "" && nativeClient(r) {
		origin = nativeOrigin
	}
	rp := s.customerRPFor(origin)
	if rp == nil {
		httpx.WriteErr(r.Context(), w, httpx.Err(http.StatusForbidden, "origin_not_allowed", "Passkeys work on stereo3d.studio only."))
	}
	return rp
}

func errRateLimited() error {
	return httpx.Err(http.StatusTooManyRequests, "rate_limited", "Too many passkey attempts. Try again in a while.")
}

// cpkAllowed applies the per-IP and (with a uid) per-account limits.
func cpkAllowed(r *http.Request, uid string) bool {
	now := time.Now()
	if nativeClient(r) {
		if !eventAllowed("cpk-native-ip:"+clientIP(r), cpkNativePerIPHour, now) {
			return false
		}
	} else if !eventAllowed("cpk-ip:"+clientIP(r), cpkPerIPHour, now) {
		return false
	}
	return uid == "" || eventAllowed("cpk-uid:"+uid, cpkPerUIDHour, now)
}

func (s *Service) mintCustomToken(ctx context.Context, uid string) (string, error) {
	if s.MintToken != nil {
		return s.MintToken(ctx, uid)
	}
	if s.Auth == nil {
		return "", errors.New("no auth client")
	}
	return s.Auth.CustomToken(ctx, uid)
}

// aaguidNames are the authenticators a device hint can name (others fall
// back to the browser and system).
var aaguidNames = map[string]string{
	"fbfc3007154e4ecc8c0b6e020557d7bd": "iCloud Keychain",
	"dd4ec289e01d41c9bb8970fa845d4bf2": "iCloud Keychain",
	"ea9b8d664d011d213ce4b6b48cb575d4": "Google Password Manager",
	"adce000235bcc60a648b0b25f1f05503": "Chrome on Mac",
	"08987058cadc4b81b6e130de50dcbe96": "Windows Hello",
	"9ddd1817af5a4672a2b93e3dd95000a9": "Windows Hello",
	"6028b017b1d44c02b4b3afcdafc96bb2": "Windows Hello",
	"bada5566a7aa401fbd9645619a55120d": "1Password",
	"d548826e79b4db40a3d811116f7e8349": "Bitwarden",
	"531126d6e717415c93203d9aa6981239": "Dashlane",
	"53414d53554e47000000000000000000": "Samsung Pass",
	"cb69481e8ff7403993ec0a2729a154a8": "YubiKey 5",
	"ee882879721c491397753dfcce97072a": "YubiKey 5",
	"fa2b99dc9e3942578f924a30d23c4118": "YubiKey 5 NFC",
}

// deviceHint names where a passkey lives: the authenticator by AAGUID,
// else the browser and system from the user agent.
func deviceHint(aaguid []byte, ua string) string {
	if n := aaguidNames[hex.EncodeToString(aaguid)]; n != "" {
		return n
	}
	browser := ""
	switch {
	case strings.Contains(ua, "Edg/"):
		browser = "Edge"
	case strings.Contains(ua, "Firefox/"):
		browser = "Firefox"
	case strings.Contains(ua, "Chrome/") || strings.Contains(ua, "CriOS/"):
		browser = "Chrome"
	case strings.Contains(ua, "Safari/"):
		browser = "Safari"
	}
	system := ""
	switch {
	case strings.Contains(ua, "iPhone"):
		system = "iPhone"
	case strings.Contains(ua, "iPad"):
		system = "iPad"
	case strings.Contains(ua, "Android"):
		system = "Android"
	case strings.Contains(ua, "Windows"):
		system = "Windows"
	case strings.Contains(ua, "CrOS"):
		system = "ChromeOS"
	case strings.Contains(ua, "Macintosh"):
		system = "Mac"
	case strings.Contains(ua, "Linux"):
		system = "Linux"
	}
	switch {
	case browser != "" && system != "":
		return browser + " on " + system
	case system != "":
		return system
	case browser != "":
		return browser
	}
	return "Passkey"
}

func customerPasskeyJSON(p *store.Passkey) map[string]any {
	return map[string]any{"id": p.ID, "name": p.Name, "device_hint": p.DeviceHint, "created_at": p.CreatedAt, "last_used_at": p.LastUsedAt}
}

func (s *Service) passkeyEvent(ctx context.Context, uid, name string, props map[string]any) {
	if err := s.Store.AddEvent(ctx, store.Event{UID: uid, Name: name, Props: props, At: time.Now().UTC()}); err != nil {
		slog.WarnContext(ctx, "passkey event not stored", "name", name, "err", err)
	}
}

// customerWAUser: the account as WebAuthn sees it (user handle = uid),
// with its passkeys on rp.
func (s *Service) customerWAUser(ctx context.Context, uid, email string, rp *passkeyRP) (*adminWAUser, []*store.Passkey, error) {
	all, err := s.Store.ListCustomerPasskeys(ctx, uid)
	if err != nil {
		return nil, nil, err
	}
	u := &adminWAUser{uid: uid, email: firstNonEmpty(email, "Spatial Video Studio account")}
	for _, p := range all {
		if rp != nil && p.RPID != rp.id {
			continue
		}
		if c, ok := credentialOf(p); ok {
			u.creds = append(u.creds, c)
		}
	}
	return u, all, nil
}

func reauthFirebase() error {
	return errReauthRequired("Sign in again, then add your passkey within 5 minutes.")
}

func cleanPasskeyName(n string) (string, bool) {
	n = strings.TrimSpace(n)
	if utf8.RuneCountInString(n) > passkeyNameMax || strings.ContainsAny(n, "\n\r\t") {
		return "", false
	}
	return n, true
}

// POST /v1/account/passkeys/register/options {name?} (signed in within 5
// minutes) → {options: {publicKey}, expires_at}.
func (s *Service) HandleCustomerPasskeyRegisterOptions(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	rp := s.requireCustomerRP(w, r)
	if rp == nil {
		return
	}
	if !cpkAllowed(r, user.UID) {
		httpx.WriteErr(ctx, w, errRateLimited())
		return
	}
	if user.AuthTime.IsZero() || time.Since(user.AuthTime) > cpkFresh {
		httpx.WriteErr(ctx, w, reauthFirebase())
		return
	}
	var req struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req)
	name, ok := cleanPasskeyName(req.Name)
	if !ok {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid(fmt.Sprintf("name: one line, at most %d characters", passkeyNameMax)))
		return
	}
	u, _, err := s.customerWAUser(ctx, user.UID, user.Email, rp)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	excl := make([]protocol.CredentialDescriptor, 0, len(u.creds))
	for _, c := range u.creds {
		excl = append(excl, c.Descriptor())
	}
	creation, session, err := rp.wa.BeginRegistration(u, webauthn.WithExclusions(excl),
		webauthn.WithResidentKeyRequirement(protocol.ResidentKeyRequirementRequired), webauthn.WithRegistrationOrigin(rp.origin))
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	if err := s.saveCustomerChallenge(ctx, user.UID, rp, cpkPurposeRegister, name, session); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	httpx.WriteOK(w, map[string]any{"options": creation, "expires_at": time.Now().Add(passkeyTTL).UTC()})
}

func (s *Service) saveCustomerChallenge(ctx context.Context, uid string, rp *passkeyRP, purpose, name string, session *webauthn.SessionData) error {
	raw, err := json.Marshal(session)
	if err != nil {
		return err
	}
	return s.Store.PutCustomerPasskeyChallenge(ctx, session.Challenge, &store.PasskeyChallenge{UID: uid, Purpose: purpose, RPID: rp.id,
		Origin: rp.origin, Session: string(raw), Name: name, ExpiresAt: time.Now().Add(passkeyTTL).UTC()})
}

func (s *Service) takeCustomerChallenge(ctx context.Context, uid string, rp *passkeyRP, purpose, challenge string) (*store.PasskeyChallenge, *webauthn.SessionData, error) {
	bad := httpx.Err(http.StatusBadRequest, "challenge_invalid", "That passkey request expired or was already used. Start again.")
	c, err := s.Store.ConsumeCustomerPasskeyChallenge(ctx, challenge)
	if err != nil || c.UID != uid || c.Purpose != purpose || c.RPID != rp.id || c.Origin != rp.origin || time.Now().After(c.ExpiresAt) {
		return nil, nil, bad
	}
	var session webauthn.SessionData
	if json.Unmarshal([]byte(c.Session), &session) != nil {
		return nil, nil, bad
	}
	return c, &session, nil
}

// POST /v1/account/passkeys/register/verify {response, name?} (signed in within
// 5 minutes) → 201 {passkey: {id, name, device_hint, created_at,
// last_used_at}}.
func (s *Service) HandleCustomerPasskeyRegisterVerify(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	rp := s.requireCustomerRP(w, r)
	if rp == nil {
		return
	}
	if !cpkAllowed(r, user.UID) {
		httpx.WriteErr(ctx, w, errRateLimited())
		return
	}
	if user.AuthTime.IsZero() || time.Since(user.AuthTime) > cpkFresh {
		httpx.WriteErr(ctx, w, reauthFirebase())
		return
	}
	var req struct {
		Name     string          `json:"name"`
		Response json.RawMessage `json:"response"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil || len(req.Response) == 0 {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("response is required"))
		return
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(req.Response)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "passkey_invalid", "That passkey response couldn't be read."))
		return
	}
	ch, session, err := s.takeCustomerChallenge(ctx, user.UID, rp, cpkPurposeRegister, parsed.Response.CollectedClientData.Challenge)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	u, _, err := s.customerWAUser(ctx, user.UID, user.Email, rp)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	cred, err := rp.wa.CreateCredential(u, *session, parsed)
	if err != nil {
		slog.WarnContext(ctx, "customer passkey registration refused", "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "passkey_invalid", "That passkey couldn't be verified."))
		return
	}
	hint := deviceHint(cred.Authenticator.AAGUID, r.UserAgent())
	name, ok := cleanPasskeyName(req.Name)
	if !ok || name == "" {
		name = firstNonEmpty(ch.Name, hint)
	}
	raw, _ := json.Marshal(cred)
	transports := make([]string, 0, len(cred.Transport))
	for _, t := range cred.Transport {
		transports = append(transports, string(t))
	}
	p := &store.Passkey{ID: base64.RawURLEncoding.EncodeToString(cred.ID), UID: user.UID, Name: name, DeviceHint: hint, PublicKey: cred.PublicKey,
		SignCount: int64(cred.Authenticator.SignCount), AAGUID: hex.EncodeToString(cred.Authenticator.AAGUID), Transports: transports,
		RPID: rp.id, CreatedAt: time.Now().UTC(), Credential: string(raw)}
	if err := s.Store.CreateCustomerPasskey(ctx, p); err != nil {
		if errors.Is(err, store.ErrAlreadyExists) {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "passkey_exists", "That passkey is already added."))
			return
		}
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	s.passkeyEvent(ctx, user.UID, "passkey_added", map[string]any{"passkey_id": p.ID, "device_hint": hint, "rp_id": rp.id})
	s.rcAttrsTouch(ctx, user.UID, "sign_in")
	s.mailPasskeyChange(ctx, user.UID, user.Email, p, true)
	writeJSON(w, http.StatusCreated, map[string]any{"passkey": customerPasskeyJSON(p)})
}

// POST /v1/auth/passkey/options (no sign-in) → {options: {publicKey},
// expires_at}: usernameless (no allowCredentials), so it also serves
// passkey autofill (mediation "conditional", set by the web).
func (s *Service) HandleCustomerPasskeySignInOptions(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rp := s.requireCustomerRP(w, r)
	if rp == nil {
		return
	}
	if !cpkAllowed(r, "") {
		httpx.WriteErr(ctx, w, errRateLimited())
		return
	}
	assertion, session, err := rp.wa.BeginDiscoverableLogin(webauthn.WithUserVerification(protocol.VerificationRequired), webauthn.WithLoginOrigin(rp.origin))
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	if err := s.saveCustomerChallenge(ctx, "", rp, cpkPurposeSignIn, "", session); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	httpx.WriteOK(w, map[string]any{"options": assertion, "expires_at": time.Now().Add(passkeyTTL).UTC()})
}

// POST /v1/auth/passkey/verify {response} (no sign-in) →
// {uid, custom_token}; 404 passkey_not_registered for a passkey this
// environment doesn't know.
func (s *Service) HandleCustomerPasskeySignInVerify(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	rp := s.requireCustomerRP(w, r)
	if rp == nil {
		return
	}
	if !cpkAllowed(r, "") {
		httpx.WriteErr(ctx, w, errRateLimited())
		return
	}
	var req struct {
		Response json.RawMessage `json:"response"`
		// Session: answer the ID and refresh tokens instead of a custom
		// token (China mode on the web, the app through svs-backend), as
		// /v1/auth/email/verify does.
		Session bool `json:"session"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&req); err != nil || len(req.Response) == 0 {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("response is required"))
		return
	}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(req.Response)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "passkey_invalid", "That passkey response couldn't be read."))
		return
	}
	_, session, err := s.takeCustomerChallenge(ctx, "", rp, cpkPurposeSignIn, parsed.Response.CollectedClientData.Challenge)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	notHere := httpx.Err(http.StatusNotFound, "passkey_not_registered", "This passkey isn't registered here.")
	id := base64.RawURLEncoding.EncodeToString(parsed.RawID)
	p, err := s.Store.GetCustomerPasskey(ctx, id)
	if err != nil || p.RPID != rp.id {
		httpx.WriteErr(ctx, w, notHere)
		return
	}
	if uh := parsed.Response.UserHandle; len(uh) > 0 && string(uh) != p.UID {
		httpx.WriteErr(ctx, w, notHere)
		return
	}
	if !cpkAllowed(r, p.UID) {
		httpx.WriteErr(ctx, w, errRateLimited())
		return
	}
	c, ok := credentialOf(p)
	if !ok {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	u := &adminWAUser{uid: p.UID, creds: []webauthn.Credential{c}}
	cred, err := rp.wa.ValidateDiscoverableLogin(func(rawID, userHandle []byte) (webauthn.User, error) { return u, nil }, *session, parsed)
	if err != nil {
		slog.WarnContext(ctx, "customer passkey sign-in refused", "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusUnauthorized, "passkey_invalid", "That passkey couldn't be verified."))
		return
	}
	if cred.Authenticator.CloneWarning {
		slog.WarnContext(ctx, "customer passkey counter went backwards", "passkey_id", p.ID, "reported", parsed.Response.AuthenticatorData.Counter, "stored", p.SignCount)
		s.Slack.Alert(ctx, "customer_passkey_clone_suspected", fmt.Sprintf("customer passkey %s of `%s` reported sign count %d (stored %d): sign-in refused",
			p.ID, p.UID, parsed.Response.AuthenticatorData.Counter, p.SignCount))
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusUnauthorized, "passkey_clone_suspected", "That passkey couldn't be used. Sign in another way."))
		return
	}
	if cust, err := s.Store.GetCustomer(ctx, p.UID); err == nil && (cust.AccountDeleted || cust.Blocked) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusForbidden, "account_unavailable", "This account can't sign in."))
		return
	}
	raw, _ := json.Marshal(cred)
	if err := s.Store.UseCustomerPasskey(ctx, p.ID, p.SignCount, int64(cred.Authenticator.SignCount), string(raw), time.Now().UTC()); err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusUnauthorized, "passkey_invalid", "That passkey was used meanwhile. Try again."))
		return
	}
	tok, err := s.mintCustomToken(ctx, p.UID)
	if err != nil {
		slog.ErrorContext(ctx, "custom token not minted", "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "sign_in_unavailable", "Passkey sign-in isn't available right now. Sign in another way."))
		return
	}
	if req.Session {
		if s.Sessions == nil || !s.Sessions.Configured() {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "sign_in_unavailable", "Passkey sign-in isn't available right now. Sign in another way."))
			return
		}
		sess, err := s.Sessions.SignInWithCustomToken(ctx, tok)
		if err != nil {
			slog.ErrorContext(ctx, "passkey session not made", "err", err)
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "sign_in_unavailable", "Passkey sign-in isn't available right now. Sign in another way."))
			return
		}
		s.passkeyEvent(ctx, p.UID, "sign_in", map[string]any{"method": "passkey", "passkey_id": p.ID, "native": nativeClient(r)})
		w.Header().Set("Cache-Control", "no-store")
		httpx.WriteOK(w, struct {
			*identity.Session
			IsNewUser bool `json:"is_new_user"`
		}{sess, false})
		return
	}
	s.passkeyEvent(ctx, p.UID, "sign_in", map[string]any{"method": "passkey", "passkey_id": p.ID, "native": nativeClient(r)})
	httpx.WriteOK(w, map[string]any{"uid": p.UID, "custom_token": tok})
}

// GET /v1/account/passkeys → {passkeys: [{id, name, device_hint, created_at,
// last_used_at}]}, oldest first.
func (s *Service) HandleCustomerPasskeys(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	all, err := s.Store.ListCustomerPasskeys(r.Context(), user.UID)
	if err != nil {
		httpx.WriteErr(r.Context(), w, httpx.ErrServer())
		return
	}
	sort.Slice(all, func(i, j int) bool { return all[i].CreatedAt.Before(all[j].CreatedAt) })
	out := make([]map[string]any, 0, len(all))
	for _, p := range all {
		out = append(out, customerPasskeyJSON(p))
	}
	httpx.WriteOK(w, map[string]any{"passkeys": out})
}

func (s *Service) ownCustomerPasskey(ctx context.Context, uid, id string) (*store.Passkey, error) {
	p, err := s.Store.GetCustomerPasskey(ctx, id)
	if err != nil || p.UID != uid {
		return nil, httpx.ErrNotFound("passkey")
	}
	return p, nil
}

// PATCH /v1/account/passkeys/{id} {name} → {passkey}.
func (s *Service) HandleCustomerPasskeyRename(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	var req struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req)
	name, ok := cleanPasskeyName(req.Name)
	if !ok || name == "" {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid(fmt.Sprintf("name: one line, 1 to %d characters", passkeyNameMax)))
		return
	}
	p, err := s.ownCustomerPasskey(ctx, user.UID, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if err := s.Store.RenameCustomerPasskey(ctx, id, name); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	s.passkeyEvent(ctx, user.UID, "passkey_renamed", map[string]any{"passkey_id": id})
	p.Name = name
	httpx.WriteOK(w, map[string]any{"passkey": customerPasskeyJSON(p)})
}

// DELETE /v1/account/passkeys/{id} → {removed: id}.
func (s *Service) HandleCustomerPasskeyDelete(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	p, err := s.ownCustomerPasskey(ctx, user.UID, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	// passkeys count as sign-in methods: the last way in stays
	if last, err := s.lastSignInMethod(ctx, user.UID); err != nil {
		httpx.WriteErr(ctx, w, identityErr(ctx, "read", err))
		return
	} else if last {
		httpx.WriteErr(ctx, w, errLastMethod())
		return
	}
	if err := s.Store.DeleteCustomerPasskey(ctx, id); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	s.passkeyEvent(ctx, user.UID, "passkey_removed", map[string]any{"passkey_id": id})
	s.rcAttrsTouch(ctx, user.UID, "sign_in")
	s.mailPasskeyChange(ctx, user.UID, user.Email, p, false)
	httpx.WriteOK(w, map[string]any{"removed": id})
}

// passkeySuggestionKey: the web dismisses the "Add a passkey"
// suggestion through /v1/account/settings dismissed.passkey_suggestion.
const passkeySuggestionKey = "passkey_suggestion"

// mailPasskeyChange is the security notice (added | removed).
func (s *Service) mailPasskeyChange(ctx context.Context, uid, email string, p *store.Passkey, added bool) {
	if email == "" {
		email = s.accountEmail(ctx, uid)
	}
	kind := "S1"
	if !added {
		kind = "S2"
	}
	now := time.Now()
	s.mailCustomer(ctx, fmt.Sprintf("%s_%s_%d", kind, p.ID, now.Unix()), uid, email,
		passkeyMail(added, p.Name, p.DeviceHint, now, s.Cfg.SiteURL+"/account"))
}

// GET /v1/admin/passkey-adoption → {accounts_with_passkey, passkeys,
// sign_ins: {"7d": {method: count}, "30d": {…}}, generated_at}.
func (s *Service) HandleAdminPasskeyAdoption(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	all, err := s.Store.ListAllCustomerPasskeys(ctx, 20000)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	accounts := map[string]bool{}
	for _, p := range all {
		accounts[p.UID] = true
	}
	now := time.Now().UTC()
	evs, err := s.Store.ListEventsByName(ctx, "sign_in", now.AddDate(0, 0, -30), 50000)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	d7, d30 := map[string]int{}, map[string]int{}
	for _, e := range evs {
		m, _ := e.Props["method"].(string)
		if m == "" {
			m = "unknown"
		}
		d30[m]++
		if !e.At.Before(now.AddDate(0, 0, -7)) {
			d7[m]++
		}
	}
	s.audit(ctx, a, "passkey_adoption", nil)
	httpx.WriteOK(w, map[string]any{"accounts_with_passkey": len(accounts), "passkeys": len(all),
		"sign_ins": map[string]any{"7d": d7, "30d": d30}, "generated_at": now})
}
