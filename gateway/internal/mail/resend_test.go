package mail

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestResendSend(t *testing.T) {
	var got map[string]any
	var auth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth = r.Header.Get("Authorization")
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &got)
		_, _ = w.Write([]byte(`{"id":"m1"}`))
	}))
	defer srv.Close()

	r := NewResend("re_test", "").WithEndpoint(srv.URL)
	if err := r.Send(context.Background(), PasswordReset("delivered@resend.dev", "https://www.stereo3d.studio/reset-password?oob=x")); err != nil {
		t.Fatal(err)
	}
	if auth != "Bearer re_test" || got["from"] != DefaultFrom || got["subject"] != ResetSubject {
		t.Fatalf("request: %s %v", auth, got)
	}
	if to, _ := got["to"].([]any); len(to) != 1 || to[0] != "delivered@resend.dev" {
		t.Fatalf("to: %v", got["to"])
	}
	if !strings.Contains(got["text"].(string), "reset-password?oob=x") || !strings.Contains(got["html"].(string), "reset-password?oob=x") {
		t.Fatalf("body: %v", got)
	}
}

func TestResendErrorsCarryNoSecrets(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	err := NewResend("re_secret", "").WithEndpoint(srv.URL).Send(context.Background(), Message{To: "delivered@resend.dev", Subject: "s", Text: "t"})
	if err == nil || strings.Contains(err.Error(), "re_secret") || strings.Contains(err.Error(), "delivered@") {
		t.Fatalf("got %v", err)
	}
	if NewResend("", "").Configured() {
		t.Fatal("empty key configured")
	}
}
