package api

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// vAuth is a software authenticator: an ES256 key, a credential id and
// a sign counter; it answers create and get the way a platform
// authenticator does (attestation none, user present and verified).
type vAuth struct {
	key   *ecdsa.PrivateKey
	id    []byte
	count uint32
}

func newVAuth(t *testing.T) *vAuth {
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	id := make([]byte, 16)
	rand.Read(id)
	return &vAuth{key: k, id: id}
}

var b64 = base64.RawURLEncoding.EncodeToString

func rpHash(rpID string) []byte { h := sha256.Sum256([]byte(rpID)); return h[:] }

func (v *vAuth) create(challenge, origin, rpID string) json.RawMessage {
	cd, _ := json.Marshal(map[string]any{"type": "webauthn.create", "challenge": challenge, "origin": origin, "crossOrigin": false})
	x, y := v.key.PublicKey.X.FillBytes(make([]byte, 32)), v.key.PublicKey.Y.FillBytes(make([]byte, 32))
	cose, _ := webauthncbor.Marshal(map[int]any{1: 2, 3: -7, -1: 1, -2: x, -3: y})
	ad := append([]byte{}, rpHash(rpID)...)
	ad = append(ad, 0x01|0x04|0x40) // user present, verified, attested credential data
	ad = binary.BigEndian.AppendUint32(ad, v.count)
	ad = append(ad, make([]byte, 16)...) // AAGUID
	ad = binary.BigEndian.AppendUint16(ad, uint16(len(v.id)))
	ad = append(ad, v.id...)
	ad = append(ad, cose...)
	att, _ := webauthncbor.Marshal(map[string]any{"fmt": "none", "attStmt": map[string]any{}, "authData": ad})
	out, _ := json.Marshal(map[string]any{"id": b64(v.id), "rawId": b64(v.id), "type": "public-key", "clientExtensionResults": map[string]any{},
		"response": map[string]any{"clientDataJSON": b64(cd), "attestationObject": b64(att), "transports": []string{"internal"}}})
	return out
}

func (v *vAuth) get(challenge, origin, rpID, uid string) json.RawMessage {
	cd, _ := json.Marshal(map[string]any{"type": "webauthn.get", "challenge": challenge, "origin": origin, "crossOrigin": false})
	ad := append([]byte{}, rpHash(rpID)...)
	ad = append(ad, 0x01|0x04)
	ad = binary.BigEndian.AppendUint32(ad, v.count)
	cdh := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte{}, ad...), cdh[:]...))
	sig, _ := ecdsa.SignASN1(rand.Reader, v.key, digest[:])
	out, _ := json.Marshal(map[string]any{"id": b64(v.id), "rawId": b64(v.id), "type": "public-key", "clientExtensionResults": map[string]any{},
		"response": map[string]any{"clientDataJSON": b64(cd), "authenticatorData": b64(ad), "signature": b64(sig), "userHandle": b64([]byte(uid))}})
	return out
}

const (
	pkOrigin = "http://localhost:5174"
	pkRPID   = "localhost"
)

type pkClient struct {
	t        *testing.T
	s        *Service
	uid      string
	authTime time.Time
	session  string
	origin   string
}

func (c *pkClient) call(h func(http.ResponseWriter, *http.Request, *AdminUser), method, body string) (int, map[string]any) {
	r := httptest.NewRequest(method, "/v1/admin/x", strings.NewReader(body))
	r.Header.Set("Origin", c.origin)
	if c.session != "" {
		r.Header.Set("X-Admin-Session", c.session)
	}
	a, _, _ := c.s.AdminUserFor(r, c.uid, "owner@x", c.authTime, false)
	w := httptest.NewRecorder()
	h(w, r, a)
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func challengeFrom(t *testing.T, out map[string]any) string {
	opts, _ := out["options"].(map[string]any)
	pk, _ := opts["publicKey"].(map[string]any)
	ch, _ := pk["challenge"].(string)
	if ch == "" {
		t.Fatalf("no challenge in %v", out)
	}
	return strings.TrimRight(ch, "=")
}

func (c *pkClient) register(v *vAuth, name string) (int, map[string]any) {
	code, out := c.call(c.s.HandlePasskeyRegisterOptions, http.MethodPost, `{"name":"`+name+`"}`)
	if code != 200 {
		return code, out
	}
	cred := v.create(challengeFrom(c.t, out), c.origin, pkRPID)
	return c.call(c.s.HandlePasskeyRegisterVerify, http.MethodPost, `{"name":"`+name+`","credential":`+string(cred)+`}`)
}

// assert runs session/options then h (verify or reassert) with v's answer.
func (c *pkClient) assert(v *vAuth, h func(http.ResponseWriter, *http.Request, *AdminUser), signOrigin, signRP string) (int, map[string]any, json.RawMessage) {
	code, out := c.call(c.s.HandleAdminSessionOptions, http.MethodPost, `{}`)
	if code != 200 {
		return code, out, nil
	}
	v.count++
	cred := v.get(challengeFrom(c.t, out), signOrigin, signRP, c.uid)
	code, out = c.call(h, http.MethodPost, `{"credential":`+string(cred)+`}`)
	return code, out, cred
}

func pkService(t *testing.T) *Service {
	s, _ := e0Service(t)
	s.Cfg.AdminOrigins = []string{"https://admin.stereo3d.studio", "https://admin-test.stereo3d.studio", pkOrigin}
	s.Cfg.AdminSessionKey = "test-session-key"
	return s
}

func errMethod(out map[string]any) any {
	d, _ := out["details"].(map[string]any)
	return d["method"]
}

// Enrolment: the first passkey needs a fresh Google sign-in, a second one
// a fresh passkey assertion; an assertion gives a session; money actions
// need a recent assertion, reassert refreshes it; the last passkey can't
// be removed; a break-glass epoch bump ends every session.
func TestAdminPasskeys(t *testing.T) {
	s := pkService(t)
	ctx := context.Background()
	c := &pkClient{t: t, s: s, uid: "admin" + store.NewID(), authTime: time.Now().Add(-10 * time.Minute), origin: pkOrigin}
	v1, v2 := newVAuth(t), newVAuth(t)

	if code, out := c.register(v1, "MacBook"); code != 401 || errMethod(out) != "google" {
		t.Fatalf("stale sign-in, first passkey: %d %v", code, out)
	}
	c.authTime = time.Now()
	if code, out := c.register(v1, "MacBook"); code != 201 || out["passkey"].(map[string]any)["name"] != "MacBook" {
		t.Fatalf("first passkey: %d %v", code, out)
	}
	if code, out := c.register(v2, "iPhone"); code != 401 || errMethod(out) != "passkey" {
		t.Fatalf("second passkey without a session: %d %v", code, out)
	}
	code, out, _ := c.assert(v1, s.HandleAdminSessionVerify, pkOrigin, pkRPID)
	tok, _ := out["session"].(string)
	if code != 200 || tok == "" || out["last_assertion_at"] == nil {
		t.Fatalf("session: %d %v", code, out)
	}
	c.session = tok
	if code, out := c.register(v2, "iPhone"); code != 201 {
		t.Fatalf("second passkey with a fresh session: %d %v", code, out)
	}
	if code, out := c.call(s.HandleAdminPasskeys, http.MethodGet, ""); code != 200 || len(out["passkeys"].([]any)) != 2 {
		t.Fatalf("list %d %v", code, out)
	}

	// Money freshness: a session whose last assertion is 10 minutes old.
	r := httptest.NewRequest(http.MethodPost, "/", nil)
	r.Header.Set("X-Admin-Session", tok)
	a, ok, err := s.AdminUserFor(r, c.uid, "owner@x", time.Now(), false)
	if !ok || err != nil || a.Method != "passkey" || !a.FreshAuth() {
		t.Fatalf("fresh session %+v %v %v", a, ok, err)
	}
	stale := *a.Session
	stale.LastAssertionAt = time.Now().Add(-10 * time.Minute).Unix()
	staleTok, _ := s.signAdminSession(stale)
	c.session = staleTok
	s.Store.PutCustomer(ctx, c.uid, &store.Customer{StripeCustomerID: "cus_1"})
	code, out = c.call(func(w http.ResponseWriter, r *http.Request, a *AdminUser) { s.HandleAdminGrantPro(w, r, a, c.uid) }, http.MethodPost,
		`{"entitlement":"pro","ends_at":"`+time.Now().Add(48*time.Hour).Format(time.RFC3339)+`","reason":"x"}`)
	if code != 401 || out["error"] != "reauth_required" || errMethod(out) != "passkey" {
		t.Fatalf("money action on a stale assertion: %d %v", code, out)
	}
	if code, out := c.call(func(w http.ResponseWriter, r *http.Request, a *AdminUser) { s.HandleAdminDeletePasskey(w, r, a, b64(v2.id)) }, http.MethodDelete, ""); code != 401 {
		t.Fatalf("delete on a stale assertion: %d %v", code, out)
	}
	code, out, _ = c.assert(v1, s.HandleAdminSessionReassert, pkOrigin, pkRPID)
	if code != 200 || out["session"] == nil {
		t.Fatalf("reassert %d %v", code, out)
	}
	c.session = out["session"].(string)
	r.Header.Set("X-Admin-Session", c.session)
	if a, _, _ := s.AdminUserFor(r, c.uid, "", time.Now(), false); !a.FreshAuth() || a.Session.ID != stale.ID || a.Session.ExpiresAt != stale.ExpiresAt {
		t.Fatalf("reasserted session %+v", a.Session)
	}

	// The last passkey stays.
	if code, out := c.call(func(w http.ResponseWriter, r *http.Request, a *AdminUser) { s.HandleAdminDeletePasskey(w, r, a, b64(v2.id)) }, http.MethodDelete, ""); code != 200 {
		t.Fatalf("delete %d %v", code, out)
	}
	if code, out := c.call(func(w http.ResponseWriter, r *http.Request, a *AdminUser) { s.HandleAdminDeletePasskey(w, r, a, b64(v1.id)) }, http.MethodDelete, ""); code != 409 || out["error"] != "last_passkey" {
		t.Fatalf("last passkey %d %v", code, out)
	}

	// Break-glass: the epoch bump ends every session.
	if err := s.Store.BumpSessionEpoch(ctx, c.uid); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.AdminUserFor(r, c.uid, "", time.Now(), false); ok || err == nil {
		t.Fatal("session after the epoch bump")
	}
}

// Refused: a replayed challenge, a wrong origin or RP, a counter that
// goes backwards.
func TestAdminPasskeyRefusals(t *testing.T) {
	s := pkService(t)
	c := &pkClient{t: t, s: s, uid: "admin" + store.NewID(), authTime: time.Now(), origin: pkOrigin}
	v := newVAuth(t)
	if code, out := c.register(v, "Key"); code != 201 {
		t.Fatalf("register %d %v", code, out)
	}
	code, out, cred := c.assert(v, s.HandleAdminSessionVerify, pkOrigin, pkRPID)
	if code != 200 {
		t.Fatalf("assert %d %v", code, out)
	}
	if code, out := c.call(s.HandleAdminSessionVerify, http.MethodPost, `{"credential":`+string(cred)+`}`); code != 400 || out["error"] != "challenge_invalid" {
		t.Fatalf("replay %d %v", code, out)
	}
	// A request from an origin with no relying party.
	c.origin = "https://admin.stereo3d.studio"
	if code, out := c.call(s.HandleAdminSessionOptions, http.MethodPost, `{}`); code != 403 || out["error"] != "origin_not_allowed" {
		t.Fatalf("origin without an RP %d %v", code, out)
	}
	c.origin = pkOrigin
	if code, out, _ := c.assert(v, s.HandleAdminSessionVerify, "https://evil.example", pkRPID); code != 401 {
		t.Fatalf("signed for another origin %d %v", code, out)
	}
	if code, out, _ := c.assert(v, s.HandleAdminSessionVerify, pkOrigin, "evil.example"); code != 401 {
		t.Fatalf("signed for another RP %d %v", code, out)
	}
	// Counter: up to 10, then an answer at 3.
	v.count = 9
	if code, out, _ := c.assert(v, s.HandleAdminSessionVerify, pkOrigin, pkRPID); code != 200 {
		t.Fatalf("count 10 %d %v", code, out)
	}
	v.count = 2
	if code, out, _ := c.assert(v, s.HandleAdminSessionVerify, pkOrigin, pkRPID); code != 401 || out["error"] != "passkey_clone_suspected" {
		t.Fatalf("counter regression %d %v", code, out)
	}
	// A registration challenge can't serve a session assertion.
	c.session = out["session"].(string)
	code, opt := c.call(s.HandlePasskeyRegisterOptions, http.MethodPost, `{}`)
	if code != 200 {
		t.Fatalf("register options %d %v", code, opt)
	}
	v.count = 20
	wrong := v.get(challengeFrom(t, opt), pkOrigin, pkRPID, c.uid)
	if code, out := c.call(s.HandleAdminSessionVerify, http.MethodPost, `{"credential":`+string(wrong)+`}`); code != 400 || out["error"] != "challenge_invalid" {
		t.Fatalf("register challenge as a session %d %v", code, out)
	}
}
