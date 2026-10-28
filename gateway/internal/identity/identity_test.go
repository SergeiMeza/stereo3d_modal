package identity

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMapCode(t *testing.T) {
	cases := []struct {
		op     Op
		code   string
		status int
		want   string
	}{
		{OpSignIn, "INVALID_LOGIN_CREDENTIALS", 401, "invalid_credentials"},
		{OpSignIn, "INVALID_PASSWORD", 401, "invalid_credentials"},
		{OpSignIn, "EMAIL_NOT_FOUND", 401, "invalid_credentials"},
		{OpSignIn, "USER_DISABLED", 403, "user_disabled"},
		{OpSignIn, "TOO_MANY_ATTEMPTS_TRY_LATER", 429, "too_many_attempts"},
		{OpSignIn, "INVALID_EMAIL", 400, "invalid_email"},
		{OpSignIn, "MISSING_PASSWORD", 400, "missing_password"},
		{OpSignUp, "EMAIL_EXISTS", 409, "email_exists"},
		{OpSignUp, "WEAK_PASSWORD", 400, "weak_password"},
		{OpSignUp, "OPERATION_NOT_ALLOWED", 403, "operation_not_allowed"},
		{OpRefresh, "INVALID_REFRESH_TOKEN", 401, "invalid_refresh_token"},
		{OpRefresh, "TOKEN_EXPIRED", 401, "invalid_refresh_token"},
		{OpRefresh, "USER_NOT_FOUND", 401, "invalid_refresh_token"},
		{OpRefresh, "USER_DISABLED", 403, "user_disabled"},
		{OpProfile, "INVALID_ID_TOKEN", 401, "invalid_token"},
		{OpProfile, "TOKEN_EXPIRED", 401, "invalid_token"},
		{OpReset, "RESET_PASSWORD_EXCEED_LIMIT", 429, "too_many_attempts"},
		{OpReset, "EMAIL_NOT_FOUND", 502, "auth_unavailable"}, // swallowed earlier by SendPasswordReset
		{OpSignIn, "SOMETHING_NEW", 502, "auth_unavailable"},
		{OpSignIn, "", 502, "auth_unavailable"},
	}
	for _, c := range cases {
		got := mapCode(c.op, c.code)
		if got.Code != c.want || got.Status != c.status {
			t.Errorf("%s %s: got %s/%d, want %s/%d", c.op, c.code, got.Code, got.Status, c.want, c.status)
		}
		for _, banned := range []string{"firebase", "google"} {
			if strings.Contains(strings.ToLower(got.Message), banned) {
				t.Errorf("%s %s: message names %s: %q", c.op, c.code, banned, got.Message)
			}
		}
	}
}

func TestAPIErrorTransportFailureIsUnavailable(t *testing.T) {
	if got := APIError(errors.New("dial tcp: timeout")); got.Code != "auth_unavailable" || got.Status != 502 {
		t.Fatalf("got %s/%d", got.Code, got.Status)
	}
}

func TestErrorCodeLeadingWord(t *testing.T) {
	for msg, want := range map[string]string{
		"WEAK_PASSWORD : Password should be at least 6 characters": "WEAK_PASSWORD",
		"TOO_MANY_ATTEMPTS_TRY_LATER : Access disabled":            "TOO_MANY_ATTEMPTS_TRY_LATER",
		"INVALID_LOGIN_CREDENTIALS":                                "INVALID_LOGIN_CREDENTIALS",
		"":                                                         "",
	} {
		body := map[string]any{"error": map[string]any{"message": msg}}
		if got := errorCode(body); got != want {
			t.Errorf("%q: got %q, want %q", msg, got, want)
		}
	}
}

func fakeJWT(claims map[string]any) string {
	raw, _ := json.Marshal(claims)
	return "eyJhbGciOiJSUzI1NiJ9." + base64.RawURLEncoding.EncodeToString(raw) + ".sig"
}

// firebaseStub answers like Firebase Auth's REST API.
func firebaseStub(t *testing.T) (*Client, *[]string) {
	t.Helper()
	var calls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		if r.URL.Query().Get("key") != "web-key" {
			t.Errorf("missing api key on %s", r.URL.Path)
		}
		raw, _ := io.ReadAll(r.Body)
		fail := func(status int, msg string) {
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": status, "message": msg}})
		}
		switch {
		case strings.HasSuffix(r.URL.Path, "accounts:signInWithPassword"):
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			if body["password"] != "right" {
				fail(400, "INVALID_LOGIN_CREDENTIALS")
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"localId": "uid-1", "email": body["email"], "displayName": "Ann",
				"idToken": "id-1", "refreshToken": "rt-1", "expiresIn": "3600",
			})
		case strings.HasSuffix(r.URL.Path, "accounts:signUp"):
			fail(400, "EMAIL_EXISTS")
		case strings.HasSuffix(r.URL.Path, "accounts:sendOobCode"):
			fail(400, "EMAIL_NOT_FOUND")
		case strings.HasSuffix(r.URL.Path, "/token"):
			if r.Header.Get("Content-Type") != "application/x-www-form-urlencoded" || !strings.Contains(string(raw), "grant_type=refresh_token") {
				fail(400, "INVALID_GRANT_TYPE")
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"user_id": "uid-1", "refresh_token": "rt-2", "expires_in": "3600",
				"id_token": fakeJWT(map[string]any{"email": "a@example.com", "name": "Ann"}),
			})
		default:
			fail(404, "NOT_FOUND")
		}
	}))
	t.Cleanup(srv.Close)
	c := New("web-key")
	c.toolkitURL = srv.URL + "/v1"
	c.tokenURL = srv.URL + "/v1/token"
	return c, &calls
}

func TestClientSignInRefreshAndErrors(t *testing.T) {
	c, _ := firebaseStub(t)
	ctx := context.Background()

	s, err := c.SignIn(ctx, "a@example.com", "right")
	if err != nil {
		t.Fatal(err)
	}
	if s.UID != "uid-1" || s.IDToken != "id-1" || s.RefreshToken != "rt-1" || s.ExpiresIn != 3600 || s.DisplayName != "Ann" {
		t.Fatalf("session: %+v", s)
	}

	_, err = c.SignIn(ctx, "a@example.com", "wrong")
	if got := APIError(err); got.Code != "invalid_credentials" {
		t.Fatalf("wrong password: %v", got)
	}
	if strings.Contains(err.Error(), "wrong") {
		t.Fatalf("error leaks the password: %q", err)
	}

	_, err = c.SignUp(ctx, "a@example.com", "whatever")
	if got := APIError(err); got.Code != "email_exists" || got.Status != 409 {
		t.Fatalf("signup: %v", got)
	}

	r, err := c.Refresh(ctx, "rt-1")
	if err != nil {
		t.Fatal(err)
	}
	if r.UID != "uid-1" || r.RefreshToken != "rt-2" || r.Email != "a@example.com" || r.DisplayName != "Ann" {
		t.Fatalf("refresh: %+v", r)
	}

	if err := c.SendPasswordReset(ctx, "nobody@example.com"); err != nil {
		t.Fatalf("reset for an unknown email must look like success, got %v", err)
	}
}

func TestLimiterWindow(t *testing.T) {
	now := time.Unix(1000, 0)
	l := NewLimiter(2, time.Minute)
	l.now = func() time.Time { return now }

	for i := 0; i < 2; i++ {
		if ok, _ := l.Allow("1.2.3.4"); !ok {
			t.Fatalf("request %d refused", i+1)
		}
	}
	ok, retry := l.Allow("1.2.3.4")
	if ok || retry != time.Minute {
		t.Fatalf("third request: ok=%v retry=%v", ok, retry)
	}
	if ok, _ := l.Allow("5.6.7.8"); !ok {
		t.Fatal("another address shares the window")
	}
	now = now.Add(61 * time.Second)
	if ok, _ := l.Allow("1.2.3.4"); !ok {
		t.Fatal("window did not reset")
	}
}

func TestLimiterPrunesExpiredWindows(t *testing.T) {
	now := time.Unix(1000, 0)
	l := NewLimiter(1, time.Minute)
	l.now = func() time.Time { return now }
	for i := 0; i < pruneAt; i++ {
		l.Allow(fmt.Sprintf("10.0.%d.%d", i/256, i%256))
	}
	now = now.Add(2 * time.Minute)
	l.Allow("fresh")
	if len(l.hits) != 1 {
		t.Fatalf("expired windows kept: %d", len(l.hits))
	}
}

func TestClientIP(t *testing.T) {
	p := NewIPPolicy("", "")
	cases := []struct {
		name     string
		xff      string
		clientIP string
		want     string
		relay    bool
	}{
		{"relay via LB trusts X-Client-IP", "1.1.1.1, 101.47.76.86, 34.117.11.37", "8.8.4.4", "8.8.4.4", true},
		{"relay without X-Client-IP uses the hop before it", "1.1.1.1, 101.47.76.86, 34.117.11.37", "", "1.1.1.1", true},
		{"spoofed X-Client-IP from a direct caller is ignored", "9.9.9.9, 34.117.11.37", "8.8.4.4", "9.9.9.9", false},
		{"caller faking the relay in X-Forwarded-For", "101.47.76.86, 9.9.9.9, 34.117.11.37", "8.8.4.4", "9.9.9.9", false},
		{"straight to run.app", "7.7.7.7", "", "7.7.7.7", false},
		{"garbage hops dropped", "nonsense, 7.7.7.7, 34.117.11.37", "", "7.7.7.7", false},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodPost, "/v1/auth/signin", nil)
		r.Header.Set("X-Forwarded-For", c.xff)
		if c.clientIP != "" {
			r.Header.Set("X-Client-IP", c.clientIP)
		}
		ip, relay := p.ClientIP(r)
		if ip != c.want || relay != c.relay {
			t.Errorf("%s: got %s/%v, want %s/%v", c.name, ip, relay, c.want, c.relay)
		}
	}

	r := httptest.NewRequest(http.MethodPost, "/v1/auth/signin", nil)
	r.RemoteAddr = "10.0.0.5:1234"
	if ip, _ := p.ClientIP(r); ip != "10.0.0.5" {
		t.Errorf("no X-Forwarded-For: got %s", ip)
	}
}

func TestHandlersRateLimitAndValidation(t *testing.T) {
	c, calls := firebaseStub(t)
	h := NewHandlers(c, NewIPPolicy("", ""))
	h.signIn = NewLimiter(1, time.Minute)

	post := func(body string, xff string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/v1/auth/signin", strings.NewReader(body))
		r.Header.Set("X-Forwarded-For", xff)
		w := httptest.NewRecorder()
		h.SignIn(w, r)
		return w
	}

	w := post(`{"email":"a@example.com","password":"right"}`, "1.1.1.1, 34.117.11.37")
	if w.Code != 200 {
		t.Fatalf("first sign-in: %d %s", w.Code, w.Body)
	}
	var s Session
	_ = json.Unmarshal(w.Body.Bytes(), &s)
	if s.UID != "uid-1" || s.IDToken == "" || s.RefreshToken == "" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("answer: %+v", s)
	}

	w = post(`{"email":"a@example.com","password":"right"}`, "1.1.1.1, 34.117.11.37")
	if w.Code != 429 || w.Header().Get("Retry-After") == "" || !strings.Contains(w.Body.String(), "rate_limited") {
		t.Fatalf("second sign-in from the same address: %d %s", w.Code, w.Body)
	}

	// Two China users behind the relay are counted apart.
	for _, ip := range []string{"8.8.4.4", "8.8.8.8"} {
		r := httptest.NewRequest(http.MethodPost, "/v1/auth/signin", strings.NewReader(`{"email":"a@example.com","password":"right"}`))
		r.Header.Set("X-Forwarded-For", "2.2.2.2, 101.47.76.86, 34.117.11.37")
		r.Header.Set("X-Client-IP", ip)
		w := httptest.NewRecorder()
		h.SignIn(w, r)
		if w.Code != 200 {
			t.Fatalf("relay caller %s: %d", ip, w.Code)
		}
	}

	before := len(*calls)
	w = post(`{"email":"not-an-email","password":"x"}`, "3.3.3.3")
	if w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_email") {
		t.Fatalf("bad email: %d %s", w.Code, w.Body)
	}
	w = post(`{"email":"b@example.com","password":""}`, "4.4.4.4")
	if w.Code != 400 || !strings.Contains(w.Body.String(), "missing_password") {
		t.Fatalf("empty password: %d %s", w.Code, w.Body)
	}
	if len(*calls) != before {
		t.Fatal("invalid input reached Firebase")
	}
}

func TestHandlersWithoutKeyAreUnavailable(t *testing.T) {
	h := NewHandlers(New(""), NewIPPolicy("", ""))
	r := httptest.NewRequest(http.MethodPost, "/v1/auth/reset", strings.NewReader(`{"email":"a@example.com"}`))
	w := httptest.NewRecorder()
	h.Reset(w, r)
	if w.Code != 502 || !strings.Contains(w.Body.String(), "auth_unavailable") {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
}
