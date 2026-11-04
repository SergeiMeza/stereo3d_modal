package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

const iphoneUA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"

type cpkClient struct {
	t        *testing.T
	s        *Service
	uid      string
	authTime time.Time
	origin   string
	ip       string
}

func (c *cpkClient) req(method, body string) *http.Request {
	r := httptest.NewRequest(method, "/v1/passkeys/x", strings.NewReader(body))
	r.Header.Set("Origin", c.origin)
	r.Header.Set("User-Agent", iphoneUA)
	r.Header.Set("X-Client-IP", c.ip)
	return r
}

func decode(w *httptest.ResponseRecorder) (int, map[string]any) {
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func (c *cpkClient) authed(h func(http.ResponseWriter, *http.Request, *AuthedUser), method, body string) (int, map[string]any) {
	w := httptest.NewRecorder()
	h(w, c.req(method, body), &AuthedUser{UID: c.uid, Email: "owner@example.com", AuthTime: c.authTime})
	return decode(w)
}

func (c *cpkClient) open(h func(http.ResponseWriter, *http.Request), body string) (int, map[string]any) {
	w := httptest.NewRecorder()
	h(w, c.req(http.MethodPost, body))
	return decode(w)
}

func (c *cpkClient) register(v *vAuth, name string) (int, map[string]any) {
	code, out := c.authed(c.s.HandleCustomerPasskeyRegisterOptions, http.MethodPost, `{"name":"`+name+`"}`)
	if code != 200 {
		return code, out
	}
	return c.authed(c.s.HandleCustomerPasskeyRegisterVerify, http.MethodPost,
		`{"name":"`+name+`","response":`+string(v.create(challengeFrom(c.t, out), c.origin, "stereo3d.studio"))+`}`)
}

func (c *cpkClient) signIn(v *vAuth, rpID string) (int, map[string]any, json.RawMessage) {
	code, out := c.open(c.s.HandleCustomerPasskeySignInOptions, `{}`)
	if code != 200 {
		return code, out, nil
	}
	v.count++
	resp := v.get(challengeFrom(c.t, out), c.origin, rpID, c.uid)
	code, out = c.open(c.s.HandleCustomerPasskeySignInVerify, `{"response":`+string(resp)+`}`)
	return code, out, resp
}

func cpkService(t *testing.T) *Service {
	s, _ := e0Service(t)
	s.MintToken = func(_ context.Context, uid string) (string, error) { return "custom-" + uid, nil }
	return s
}

// Add (fresh sign-in only), usernameless sign-in from another origin of
// the same RP → a custom token; list, rename, delete; account deletion
// takes the passkeys; adoption counts; the suggestion's dismissed key.
func TestCustomerPasskeys(t *testing.T) {
	s := cpkService(t)
	ctx := context.Background()
	c := &cpkClient{t: t, s: s, uid: "u" + store.NewID(), authTime: time.Now().Add(-10 * time.Minute), origin: "https://stereo3d.studio", ip: "203.0.113.7"}
	v := newVAuth(t)

	if code, out := c.register(v, "My iPhone"); code != 401 || out["error"] != "reauth_required" || errMethod(out) != "firebase" {
		t.Fatalf("stale sign-in %d %v", code, out)
	}
	c.authTime = time.Now()
	code, out := c.register(v, "My iPhone")
	pk, _ := out["passkey"].(map[string]any)
	if code != 201 || pk["name"] != "My iPhone" || pk["device_hint"] != "Safari on iPhone" {
		t.Fatalf("register %d %v", code, out)
	}
	id := pk["id"].(string)

	c.origin = "https://www.stereo3d.studio" // the same RP ID
	code, out, _ = c.signIn(v, "stereo3d.studio")
	if code != 200 || out["custom_token"] != "custom-"+c.uid || out["uid"] != c.uid {
		t.Fatalf("sign-in %d %v", code, out)
	}
	code, out = c.authed(s.HandleCustomerPasskeys, http.MethodGet, "")
	list, _ := out["passkeys"].([]any)
	if code != 200 || len(list) != 1 || list[0].(map[string]any)["last_used_at"] == nil {
		t.Fatalf("list %d %v", code, out)
	}
	rename := func(uid, pid, body string) (int, map[string]any) {
		w := httptest.NewRecorder()
		s.HandleCustomerPasskeyRename(w, c.req(http.MethodPatch, body), &AuthedUser{UID: uid}, pid)
		return decode(w)
	}
	if code, out := rename(c.uid, id, `{"name":"Work phone"}`); code != 200 || out["passkey"].(map[string]any)["name"] != "Work phone" {
		t.Fatalf("rename %d %v", code, out)
	}
	if code, _ := rename("someone-else", id, `{"name":"x"}`); code != 404 {
		t.Fatalf("another account's passkey %d", code)
	}
	evs, _ := s.Store.ListUserEvents(ctx, c.uid, time.Now().Add(-time.Hour), 50)
	names := map[string]int{}
	for _, e := range evs {
		names[e.Name]++
	}
	if names["passkey_added"] != 1 || names["sign_in"] != 1 || names["passkey_renamed"] != 1 {
		t.Fatalf("events %v", names)
	}

	// Adoption, with a web sign-in by another method.
	s.Store.AddEvent(ctx, store.Event{UID: "u2", Name: "sign_in", Props: map[string]any{"method": "google"}, At: time.Now().Add(-10 * 24 * time.Hour)})
	w := httptest.NewRecorder()
	s.HandleAdminPasskeyAdoption(w, httptest.NewRequest(http.MethodGet, "/", nil), &AdminUser{UID: "admin", Method: "passkey", AssertedAt: time.Now()})
	_, ad := decode(w)
	si := ad["sign_ins"].(map[string]any)
	if ad["accounts_with_passkey"] != float64(1) || si["7d"].(map[string]any)["passkey"] != float64(1) || si["30d"].(map[string]any)["google"] != float64(1) || si["7d"].(map[string]any)["google"] != nil {
		t.Fatalf("adoption %v", ad)
	}

	// Delete; then account deletion takes any left.
	w = httptest.NewRecorder()
	s.HandleCustomerPasskeyDelete(w, c.req(http.MethodDelete, ""), &AuthedUser{UID: c.uid}, id)
	if w.Code != 200 {
		t.Fatalf("delete %d %s", w.Code, w.Body)
	}
	c.origin = "https://stereo3d.studio"
	if code, _ := c.register(newVAuth(t), "Second"); code != 201 {
		t.Fatalf("second %d", code)
	}
	if err := s.finishAccountDeletion(ctx, c.uid); err != nil {
		t.Fatal(err)
	}
	if ps, _ := s.Store.ListCustomerPasskeys(ctx, c.uid); len(ps) != 0 {
		t.Fatalf("passkeys after account deletion: %d", len(ps))
	}

	// The suggestion is dismissed through the settings.
	if !validDismissedKey("passkey_suggestion") {
		t.Fatal("dismissed.passkey_suggestion refused")
	}
}

// Refused: an unknown passkey (404 passkey_not_registered), a replayed
// challenge, another origin, a wrong RP, a counter going backwards; and
// the per-IP limit.
func TestCustomerPasskeyRefusals(t *testing.T) {
	s := cpkService(t)
	c := &cpkClient{t: t, s: s, uid: "u" + store.NewID(), authTime: time.Now(), origin: "https://stereo3d.studio", ip: "203.0.113.8"}
	v := newVAuth(t)
	if code, out := c.register(v, "Key"); code != 201 {
		t.Fatalf("register %d %v", code, out)
	}
	if code, out, _ := c.signIn(newVAuth(t), "stereo3d.studio"); code != 404 || out["error"] != "passkey_not_registered" {
		t.Fatalf("unknown passkey %d %v", code, out)
	}
	code, out, resp := c.signIn(v, "stereo3d.studio")
	if code != 200 {
		t.Fatalf("sign-in %d %v", code, out)
	}
	if code, out := c.open(s.HandleCustomerPasskeySignInVerify, `{"response":`+string(resp)+`}`); code != 400 || out["error"] != "challenge_invalid" {
		t.Fatalf("replay %d %v", code, out)
	}
	if code, out, _ := c.signIn(v, "evil.example"); code != 401 {
		t.Fatalf("wrong RP %d %v", code, out)
	}
	c.origin = "https://stereo3d.example"
	if code, out := c.open(s.HandleCustomerPasskeySignInOptions, `{}`); code != 403 || out["error"] != "origin_not_allowed" {
		t.Fatalf("other origin %d %v", code, out)
	}
	c.origin = "https://stereo3d.studio"
	v.count = 9
	if code, out, _ := c.signIn(v, "stereo3d.studio"); code != 200 {
		t.Fatalf("count 10 %d %v", code, out)
	}
	v.count = 3
	if code, out, _ := c.signIn(v, "stereo3d.studio"); code != 401 || out["error"] != "passkey_clone_suspected" {
		t.Fatalf("counter regression %d %v", code, out)
	}
	// Per-IP limit: a fresh address gets 60 an hour.
	c.ip = fmt.Sprintf("198.51.100.%d", time.Now().UnixNano()%250+1)
	last := 0
	for i := 0; i < cpkPerIPHour+1; i++ {
		last, _ = c.open(s.HandleCustomerPasskeySignInOptions, `{}`)
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("limit: %d", last)
	}
}

func TestDeviceHint(t *testing.T) {
	icloud := []byte{0xfb, 0xfc, 0x30, 0x07, 0x15, 0x4e, 0x4e, 0xcc, 0x8c, 0x0b, 0x6e, 0x02, 0x05, 0x57, 0xd7, 0xbd}
	cases := map[string]string{
		deviceHint(icloud, iphoneUA):           "iCloud Keychain",
		deviceHint(make([]byte, 16), iphoneUA): "Safari on iPhone",
		deviceHint(nil, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0"): "Edge on Windows",
		deviceHint(nil, ""): "Passkey",
	}
	for got, want := range cases {
		if got != want {
			t.Fatalf("hint %q, want %q", got, want)
		}
	}
}

// The web logs its other sign-ins as sign_in {method}.
func TestSignInEventValidator(t *testing.T) {
	v := eventValidators["sign_in"]
	if out, ok := v(map[string]any{"method": "google", "x": 1}); !ok || len(out) != 1 || out["method"] != "google" {
		t.Fatalf("google %v %v", out, ok)
	}
	if _, ok := v(map[string]any{"method": "passkey"}); ok {
		t.Fatal("passkey sign-ins are logged by the gateway, not the web")
	}
}
