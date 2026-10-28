package identity

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/mail"
)

type fakeCodes struct {
	calls []string
	known map[string]bool
	err   error
}

func (f *fakeCodes) PasswordResetCode(_ context.Context, email string) (string, bool, error) {
	f.calls = append(f.calls, email)
	if f.err != nil {
		return "", false, f.err
	}
	if !f.known[strings.ToLower(email)] {
		return "", false, nil
	}
	return "code/with+chars", true, nil
}

type fakeMailer struct {
	sent []mail.Message
	err  error
}

func (f *fakeMailer) Configured() bool { return true }
func (f *fakeMailer) Send(_ context.Context, m mail.Message) error {
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, m)
	return nil
}

const (
	relayXFF  = "2.2.2.2, 101.47.76.86, 34.117.11.37"
	directXFF = "9.9.9.9, 34.117.11.37"
)

func resetHandlers(t *testing.T) (*Handlers, *fakeCodes, *fakeMailer, *[]string) {
	t.Helper()
	c, calls := firebaseStub(t)
	h := NewHandlers(c, NewIPPolicy("", ""))
	codes := &fakeCodes{known: map[string]bool{"ann@example.com": true}}
	mailer := &fakeMailer{}
	h.SiteReset = &SiteReset{Codes: codes, Mail: mailer, PageURL: "https://www.stereo3d.studio/reset-password"}
	return h, codes, mailer, calls
}

func postReset(h *Handlers, email, xff string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/v1/auth/reset", strings.NewReader(`{"email":"`+email+`"}`))
	r.Header.Set("X-Forwarded-For", xff)
	r.Header.Set("X-Client-IP", "8.8.4.4")
	w := httptest.NewRecorder()
	h.Reset(w, r)
	return w
}

func TestResetThroughRelayMailsTheSiteLink(t *testing.T) {
	h, codes, mailer, calls := resetHandlers(t)

	w := postReset(h, "ann@example.com", relayXFF)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if len(*calls) != 0 {
		t.Fatalf("relay reset reached the provider's mail: %v", *calls)
	}
	if len(mailer.sent) != 1 {
		t.Fatalf("mails sent: %d", len(mailer.sent))
	}
	m := mailer.sent[0]
	link := "https://www.stereo3d.studio/reset-password?oob=code%2Fwith%2Bchars"
	if m.To != "ann@example.com" || !strings.Contains(m.Text, link) || !strings.Contains(m.HTML, link) {
		t.Fatalf("mail: %+v", m)
	}
	if !strings.Contains(m.Subject, "Stereo3D Studio") {
		t.Fatalf("subject must name the app: %q", m.Subject)
	}
	if len(codes.calls) != 1 || codes.calls[0] != "ann@example.com" {
		t.Fatalf("codes: %v", codes.calls)
	}
}

func TestResetThroughRelayUnknownEmailLooksTheSame(t *testing.T) {
	h, _, mailer, _ := resetHandlers(t)
	w := postReset(h, "nobody@example.com", relayXFF)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"ok":true`) {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if len(mailer.sent) != 0 {
		t.Fatal("mailed an unknown address")
	}
}

func TestResetDirectUsesTheProviderMail(t *testing.T) {
	h, codes, mailer, calls := resetHandlers(t)
	w := postReset(h, "ann@example.com", directXFF)
	if w.Code != 200 {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
	if len(codes.calls) != 0 || len(mailer.sent) != 0 {
		t.Fatal("a direct reset took the site path")
	}
	if len(*calls) != 1 || !strings.HasSuffix((*calls)[0], "accounts:sendOobCode") {
		t.Fatalf("provider calls: %v", *calls)
	}
}

func TestResetThroughRelayWithoutMailFallsBack(t *testing.T) {
	h, codes, _, calls := resetHandlers(t)
	h.SiteReset.Mail = mail.NewResend("", "")
	if w := postReset(h, "ann@example.com", relayXFF); w.Code != 200 {
		t.Fatalf("got %d", w.Code)
	}
	if len(codes.calls) != 0 || len(*calls) != 1 {
		t.Fatalf("unconfigured mail must fall back to the provider: codes=%v calls=%v", codes.calls, *calls)
	}
}

func TestResetThroughRelayPerAddressLimit(t *testing.T) {
	h, _, mailer, _ := resetHandlers(t)
	for i := 0; i < resetMailsPerHour+2; i++ {
		if w := postReset(h, "Ann@Example.com", relayXFF); w.Code != 200 {
			t.Fatalf("request %d: %d", i, w.Code)
		}
	}
	if len(mailer.sent) != resetMailsPerHour {
		t.Fatalf("mails sent: %d, want %d", len(mailer.sent), resetMailsPerHour)
	}
}

func TestResetThroughRelayFailuresAreUnavailable(t *testing.T) {
	h, codes, mailer, _ := resetHandlers(t)
	mailer.err = errors.New("mail: status 500")
	if w := postReset(h, "ann@example.com", relayXFF); w.Code != 502 || !strings.Contains(w.Body.String(), "auth_unavailable") {
		t.Fatalf("mail failure: %d %s", w.Code, w.Body)
	}
	codes.err = errors.New("boom")
	if w := postReset(h, "ann@example.com", relayXFF); w.Code != 502 {
		t.Fatalf("code failure: %d", w.Code)
	}
}

func TestResetMailWording(t *testing.T) {
	m := mail.PasswordReset("a@example.com", "https://www.stereo3d.studio/reset-password?oob=x")
	for _, part := range []string{m.Subject, m.Text, m.HTML} {
		low := strings.ToLower(part)
		for _, banned := range []string{"google", "firebase", "relay", "proxy", "hong kong"} {
			if strings.Contains(low, banned) {
				t.Errorf("reset mail names %q: %q", banned, part)
			}
		}
	}
	if m.Subject != "Reset your Stereo3D Studio password" {
		t.Errorf("subject: %q", m.Subject)
	}
}

// confirmStub answers accounts:resetPassword.
func confirmStub(t *testing.T) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasSuffix(r.URL.Path, "accounts:resetPassword") || r.URL.Query().Get("key") != "web-key" {
			w.WriteHeader(404)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		var body map[string]string
		_ = json.Unmarshal(raw, &body)
		fail := func(msg string) {
			w.WriteHeader(400)
			_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"code": 400, "message": msg}})
		}
		switch {
		case body["oobCode"] == "expired":
			fail("EXPIRED_OOB_CODE")
		case body["oobCode"] != "good":
			fail("INVALID_OOB_CODE")
		case len(body["newPassword"]) < 6:
			fail("WEAK_PASSWORD : Password should be at least 6 characters")
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"email": "ann@example.com", "requestType": "PASSWORD_RESET"})
		}
	}))
	t.Cleanup(srv.Close)
	c := New("web-key")
	c.toolkitURL = srv.URL + "/v1"
	return c
}

func TestResetConfirm(t *testing.T) {
	h := NewHandlers(confirmStub(t), NewIPPolicy("", ""))
	post := func(body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodPost, "/v1/auth/reset/confirm", strings.NewReader(body))
		r.Header.Set("X-Forwarded-For", relayXFF)
		w := httptest.NewRecorder()
		h.ResetConfirm(w, r)
		return w
	}
	cases := []struct {
		body   string
		status int
		want   string
	}{
		{`{"oob":"good","new_password":"secret1"}`, 200, `"email":"ann@example.com"`},
		{`{"oob":"expired","new_password":"secret1"}`, 400, "reset_link_expired"},
		{`{"oob":"used","new_password":"secret1"}`, 400, "reset_link_invalid"},
		{`{"oob":"good","new_password":"abc"}`, 400, "weak_password"},
		{`{"oob":"","new_password":"secret1"}`, 400, "reset_link_invalid"},
		{`{"oob":"good","new_password":""}`, 400, "missing_password"},
		{`not json`, 400, "invalid_request"},
	}
	for _, c := range cases {
		w := post(c.body)
		if w.Code != c.status || !strings.Contains(w.Body.String(), c.want) {
			t.Errorf("%s: got %d %s, want %d %s", c.body, w.Code, w.Body, c.status, c.want)
		}
		if strings.Contains(w.Body.String(), "secret1") {
			t.Errorf("%s: answer echoes the password", c.body)
		}
	}
}
