package api

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/auth"
	"spatial-ai-labs/stereo3d-gateway/internal/emailcode"
	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/identity"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// fakeIdentities is Firebase Auth's user records, in memory.
type fakeIdentities struct {
	mu    sync.Mutex
	users map[string]*auth.Identity
	fed   map[string]string // provider|sub → uid
}

func newFakeIdentities() *fakeIdentities {
	return &fakeIdentities{users: map[string]*auth.Identity{}, fed: map[string]string{}}
}

func (f *fakeIdentities) add(uid, email string, providers ...string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.users[uid] = &auth.Identity{UID: uid, Email: email, EmailVerified: email != "", Providers: providers}
}

func (f *fakeIdentities) holds(provider, sub, uid string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.fed[provider+"|"+sub] = uid
	u := f.users[uid]
	u.Providers = append(u.Providers, provider)
}

func (f *fakeIdentities) IdentityOf(_ context.Context, uid string) (*auth.Identity, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	u, ok := f.users[uid]
	if !ok {
		return nil, fmt.Errorf("no user")
	}
	c := *u
	c.Providers = slices.Clone(u.Providers)
	return &c, nil
}

func (f *fakeIdentities) IdentityByEmail(_ context.Context, email string) (*auth.Identity, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, u := range f.users {
		if strings.EqualFold(u.Email, email) {
			c := *u
			return &c, nil
		}
	}
	return nil, nil
}

func (f *fakeIdentities) IdentityByProvider(ctx context.Context, provider, sub string) (*auth.Identity, error) {
	f.mu.Lock()
	uid, ok := f.fed[provider+"|"+sub]
	f.mu.Unlock()
	if !ok {
		return nil, nil
	}
	return f.IdentityOf(ctx, uid)
}

func (f *fakeIdentities) SetVerifiedEmail(_ context.Context, uid, email string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.users[uid].Email, f.users[uid].EmailVerified = email, true
	return nil
}

func (f *fakeIdentities) RemoveProviders(_ context.Context, uid string, providers []string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	u := f.users[uid]
	u.Providers = slices.DeleteFunc(u.Providers, func(p string) bool { return slices.Contains(providers, p) })
	return nil
}

// fakeSessions is Firebase's REST sign-in: custom tokens and IdP links
// against fakeIdentities (signInWithIdp's refusals by code).
type fakeSessions struct {
	ids *fakeIdentities
}

func (f *fakeSessions) Configured() bool { return true }

func (f *fakeSessions) SignInWithCustomToken(_ context.Context, token string) (*identity.Session, error) {
	uid := strings.TrimPrefix(token, "custom-")
	return &identity.Session{UID: uid, IDToken: "id-" + uid, RefreshToken: "rt-" + uid, ExpiresIn: 3600}, nil
}

func (f *fakeSessions) LinkWithIdP(_ context.Context, callerToken, provider, idpToken, _ string) (*identity.LinkResult, error) {
	uid := strings.TrimPrefix(callerToken, "caller-")
	c := unverifiedClaims(idpToken)
	f.ids.mu.Lock()
	holder, held := f.ids.fed[provider+"|"+c.Sub]
	f.ids.mu.Unlock()
	if c.Sub == "" {
		return nil, identity.ErrorCode(identity.OpLinkIdP, "INVALID_IDP_RESPONSE")
	}
	if held && holder != uid {
		return nil, identity.ErrorCode(identity.OpLinkIdP, "FEDERATED_USER_ID_ALREADY_LINKED")
	}
	if c.Email != "" {
		if other, _ := f.ids.IdentityByEmail(context.Background(), c.Email); other != nil && other.UID != uid {
			return nil, identity.ErrorCode(identity.OpLinkIdP, "EMAIL_EXISTS")
		}
	}
	if !held {
		f.ids.holds(provider, c.Sub, uid)
	}
	return &identity.LinkResult{Session: identity.Session{UID: uid, IDToken: "id-" + uid, RefreshToken: "rt-" + uid, ExpiresIn: 3600}}, nil
}

// fakeCodes: 123456 is right.
type fakeCodes struct{}

func (fakeCodes) Check(_ context.Context, _, code string) error {
	if code == "123456" {
		return nil
	}
	return &emailcode.WrongCodeError{AttemptsLeft: 4}
}

// idpToken is an unsigned provider ID token (the fake checks nothing).
func idpToken(sub, email string) string {
	part := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	return part(map[string]any{"alg": "none"}) + "." + part(map[string]any{"sub": sub, "email": email}) + ".sig"
}

func identityService(t *testing.T) (*Service, *fakeIdentities) {
	s := cpkService(t)
	ids := newFakeIdentities()
	s.Identities, s.Sessions, s.EmailCodes = ids, &fakeSessions{ids: ids}, fakeCodes{}
	return s, ids
}

func callIdentity(s *Service, uid, method, body, provider, ip string) (int, map[string]any, string) {
	r := httptest.NewRequest(method, "/v1/account/identities", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer caller-"+uid)
	r.Header.Set("X-Client-IP", ip)
	w := httptest.NewRecorder()
	u := &AuthedUser{UID: uid}
	switch {
	case method == http.MethodGet:
		s.HandleIdentities(w, r, u)
	case method == http.MethodPost:
		s.HandleLinkIdentity(w, r, u)
	default:
		s.HandleUnlinkIdentity(w, r, u, provider)
	}
	code, out := decode(w)
	return code, out, w.Body.String()
}

func providersOf(out map[string]any) []string {
	var ps []string
	for _, p := range out["providers"].([]any) {
		ps = append(ps, p.(string))
	}
	return ps
}

func uniqueIP() string { return fmt.Sprintf("192.0.2.%d", time.Now().UnixNano()%250+1) }

// GET lists the methods; an anonymous account has none. Linking Apple
// onto an anonymous account keeps its uid (and answers fresh tokens with
// session:true); Google from the same project links too.
func TestIdentitiesLinkKeepsUID(t *testing.T) {
	s, ids := identityService(t)
	anon := "u" + store.NewID()
	ids.add(anon, "")
	ip := uniqueIP()
	code, out, _ := callIdentity(s, anon, http.MethodGet, "", "", ip)
	if code != 200 || out["anonymous"] != true || len(providersOf(out)) != 0 || out["passkeys"] != float64(0) {
		t.Fatalf("anonymous %d %v", code, out)
	}
	code, out, _ = callIdentity(s, anon, http.MethodPost, `{"provider":"apple.com","id_token":"`+idpToken("apple-1", "")+`","nonce":"n","session":true}`, "", ip)
	sess, _ := out["session"].(map[string]any)
	if code != 200 || !slices.Equal(providersOf(out), []string{"apple.com"}) || out["anonymous"] != false ||
		sess["uid"] != anon || sess["id_token"] == "" || sess["refresh_token"] == "" {
		t.Fatalf("apple link %d %v", code, out)
	}
	code, out, _ = callIdentity(s, anon, http.MethodPost, `{"provider":"google.com","id_token":"`+idpToken("google-1", "")+`"}`, "", ip)
	if code != 200 || !slices.Equal(providersOf(out), []string{"apple.com", "google.com"}) || out["session"] != nil {
		t.Fatalf("google link %d %v", code, out)
	}
	if code, out, _ := callIdentity(s, anon, http.MethodPost, `{"provider":"facebook.com","id_token":"x"}`, "", ip); code != 400 {
		t.Fatalf("unknown provider %d %v", code, out)
	}
	if code, out, _ := callIdentity(s, anon, http.MethodPost, `{"provider":"apple.com","id_token":"garbage"}`, "", ip); code != 400 || out["error"] != "invalid_credential" {
		t.Fatalf("bad token %d %v", code, out)
	}
}

// A sign-in or address another account holds: 409 credential_in_use with
// that account's methods (passkeys included), never its uid.
func TestIdentitiesCredentialInUse(t *testing.T) {
	s, ids := identityService(t)
	ctx := context.Background()
	me, other := "u"+store.NewID(), "u"+store.NewID()
	ids.add(me, "")
	ids.add(other, "taken@example.com")
	ids.holds("apple.com", "apple-other", other)
	if err := s.Store.CreateCustomerPasskey(ctx, &store.Passkey{ID: "pk-" + other, UID: other, RPID: "stereo3d.studio", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	ip := uniqueIP()
	for name, body := range map[string]string{
		"apple held":    `{"provider":"apple.com","id_token":"` + idpToken("apple-other", "") + `"}`,
		"google email":  `{"provider":"google.com","id_token":"` + idpToken("google-2", "taken@example.com") + `"}`,
		"email address": `{"provider":"email","email":"Taken@Example.com","code":"123456"}`,
	} {
		code, out, raw := callIdentity(s, me, http.MethodPost, body, "", ip)
		d, _ := out["details"].(map[string]any)
		got := fmt.Sprint(d["providers"])
		if code != 409 || out["error"] != "credential_in_use" || got != "[apple.com email passkey]" || strings.Contains(raw, other) {
			t.Fatalf("%s: %d %v", name, code, out)
		}
	}
	if code, out, _ := callIdentity(s, me, http.MethodGet, "", "", ip); code != 200 || len(providersOf(out)) != 0 {
		t.Fatalf("nothing linked %v", out)
	}
}

// The email code links an address without signing in: a wrong code is
// refused, a right one puts it on the caller's account, verified.
func TestIdentitiesLinkEmail(t *testing.T) {
	s, ids := identityService(t)
	me := "u" + store.NewID()
	ids.add(me, "", "apple.com")
	ip := uniqueIP()
	if code, out, _ := callIdentity(s, me, http.MethodPost, `{"provider":"email","email":"me@example.com","code":"000000"}`, "", ip); code != 400 || out["error"] != "code_invalid" {
		t.Fatalf("wrong code %d %v", code, out)
	}
	if code, out, _ := callIdentity(s, me, http.MethodPost, `{"provider":"email","email":"not an email","code":"123456"}`, "", ip); code != 400 || out["error"] != "invalid_email" {
		t.Fatalf("bad address %d %v", code, out)
	}
	code, out, _ := callIdentity(s, me, http.MethodPost, `{"provider":"email","email":"Me@Example.com","code":"123456"}`, "", ip)
	if code != 200 || !slices.Equal(providersOf(out), []string{"apple.com", "email"}) || out["email"] != "me@example.com" || out["email_verified"] != true {
		t.Fatalf("email link %d %v", code, out)
	}
}

// Unlinking: never the last way in (passkeys count), never the email;
// a password goes (the email code still signs in); unknown or absent
// providers are refused.
func TestIdentitiesUnlink(t *testing.T) {
	s, ids := identityService(t)
	ctx := context.Background()
	ip := uniqueIP()
	only := "u" + store.NewID()
	ids.add(only, "", "apple.com")
	if code, out, _ := callIdentity(s, only, http.MethodDelete, "", "apple.com", ip); code != 409 || out["error"] != "last_method" {
		t.Fatalf("last method %d %v", code, out)
	}
	if code, out, _ := callIdentity(s, only, http.MethodDelete, "", "google.com", ip); code != 404 || out["error"] != "not_linked" {
		t.Fatalf("not linked %d %v", code, out)
	}
	if code, _, _ := callIdentity(s, only, http.MethodDelete, "", "github.com", ip); code != 400 {
		t.Fatalf("unknown provider %d", code)
	}
	// with a passkey, Apple can go
	if err := s.Store.CreateCustomerPasskey(ctx, &store.Passkey{ID: "pk-" + only, UID: only, RPID: "stereo3d.studio", CreatedAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	code, out, _ := callIdentity(s, only, http.MethodDelete, "", "apple.com", ip)
	if code != 200 || len(providersOf(out)) != 0 || out["passkeys"] != float64(1) || out["anonymous"] != false {
		t.Fatalf("unlink with a passkey %d %v", code, out)
	}
	// ...and now that passkey is the last way in
	w := httptest.NewRecorder()
	s.HandleCustomerPasskeyDelete(w, httptest.NewRequest(http.MethodDelete, "/", nil), &AuthedUser{UID: only}, "pk-"+only)
	if code, out := decode(w); code != 409 || out["error"] != "last_method" {
		t.Fatalf("last passkey %d %v", code, out)
	}

	pw := "u" + store.NewID()
	ids.add(pw, "pw@example.com", "password")
	if code, out, _ := callIdentity(s, pw, http.MethodDelete, "", "email", ip); code != 409 || out["error"] != "email_not_removable" {
		t.Fatalf("email %d %v", code, out)
	}
	code, out, _ = callIdentity(s, pw, http.MethodDelete, "", "password", ip)
	if code != 200 || out["password"] != false || !slices.Equal(providersOf(out), []string{"email"}) {
		t.Fatalf("password %d %v", code, out)
	}
}

// The app's passkeys: no Origin, X-SVS-Client: app/<ver> → the
// stereo3d.studio relying party; the client data's origin is still
// checked; session:true answers the session (also China mode on the
// web); native calls have their own per-IP bucket.
func TestNativePasskeys(t *testing.T) {
	s, ids := identityService(t)
	uid := "u" + store.NewID()
	ids.add(uid, "app@example.com")
	c := &cpkClient{t: t, s: s, uid: uid, authTime: time.Now(), origin: "https://stereo3d.studio", ip: uniqueIP(), native: "app/10.5.8"}
	v := newVAuth(t)
	if code, out := c.register(v, "iPhone"); code != 201 {
		t.Fatalf("native register %d %v", code, out)
	}
	code, out := c.open(s.HandleCustomerPasskeySignInOptions, `{}`)
	if code != 200 {
		t.Fatalf("native options %d %v", code, out)
	}
	v.count++
	resp := v.get(challengeFrom(t, out), "https://stereo3d.studio", "stereo3d.studio", uid)
	code, out = c.open(s.HandleCustomerPasskeySignInVerify, `{"session":true,"response":`+string(resp)+`}`)
	if code != 200 || out["uid"] != uid || out["id_token"] != "id-"+uid || out["refresh_token"] != "rt-"+uid ||
		out["expires_in"] != float64(3600) || out["is_new_user"] != false || out["custom_token"] != nil {
		t.Fatalf("native session %d %v", code, out)
	}
	// a client-data origin other than the relying party's is refused
	_, out = c.open(s.HandleCustomerPasskeySignInOptions, `{}`)
	v.count++
	resp = v.get(challengeFrom(t, out), "https://evil.example", "stereo3d.studio", uid)
	if code, out := c.open(s.HandleCustomerPasskeySignInVerify, `{"response":`+string(resp)+`}`); code != 401 {
		t.Fatalf("wrong client-data origin %d %v", code, out)
	}
	// no Origin and no app marker: refused as before
	for _, marker := range []string{"", "web/1", "app/", "app/10 5"} {
		c.native = marker
		if marker == "" {
			c.origin = ""
		}
		if code, out := c.open(s.HandleCustomerPasskeySignInOptions, `{}`); code != 403 || out["error"] != "origin_not_allowed" {
			t.Fatalf("marker %q: %d %v", marker, code, out)
		}
	}
	// native bucket: 30 an hour per address, apart from the web's 60
	c.native, c.origin, c.ip = "app/10.5.8", "https://stereo3d.studio", uniqueIP()
	last := 0
	for i := 0; i < cpkNativePerIPHour+1; i++ {
		last, _ = c.open(s.HandleCustomerPasskeySignInOptions, `{}`)
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("native limit %d", last)
	}
	c.native = ""
	if code, _ := c.open(s.HandleCustomerPasskeySignInOptions, `{}`); code != 200 {
		t.Fatalf("the web's bucket is apart: %d", code)
	}
}

// svs-backend's vouched-for address keys the limits (and only with the
// proxy key).
func TestTrustedProxyClientIP(t *testing.T) {
	var got string
	h := httpx.WithTrustedProxy("k", http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) { got = clientIP(r) }))
	r := httptest.NewRequest(http.MethodPost, "/v1/auth/passkey/options", nil)
	r.Header.Set("X-Forwarded-For", "198.51.100.1")
	r.Header.Set(httpx.HeaderProxyKey, "k")
	r.Header.Set(httpx.HeaderClientIP, "203.0.113.99")
	h.ServeHTTP(httptest.NewRecorder(), r)
	if got != "203.0.113.99" {
		t.Fatalf("trusted %q", got)
	}
	r = httptest.NewRequest(http.MethodPost, "/", nil)
	r.Header.Set("X-Forwarded-For", "198.51.100.1")
	r.Header.Set(httpx.HeaderProxyKey, "nope")
	r.Header.Set(httpx.HeaderClientIP, "203.0.113.99")
	h.ServeHTTP(httptest.NewRecorder(), r)
	if got != "198.51.100.1" {
		t.Fatalf("untrusted %q", got)
	}
}
