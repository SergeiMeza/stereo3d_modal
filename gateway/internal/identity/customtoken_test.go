package identity

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSignInWithCustomToken(t *testing.T) {
	payload := base64.RawURLEncoding.EncodeToString([]byte(`{"user_id":"u1","sub":"u1","email":"a@example.com","name":"A"}`))
	idToken := "h." + payload + ".s"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if !strings.HasSuffix(r.URL.Path, "/accounts:signInWithCustomToken") || !strings.Contains(string(body), `"token":"ct"`) {
			t.Errorf("unexpected call %s %s", r.URL.Path, body)
		}
		_, _ = w.Write([]byte(`{"idToken":"` + idToken + `","refreshToken":"rt","expiresIn":"3600"}`))
	}))
	defer srv.Close()
	c := New("key")
	c.toolkitURL = srv.URL
	s, err := c.SignInWithCustomToken(context.Background(), "ct")
	if err != nil {
		t.Fatal(err)
	}
	if s.UID != "u1" || s.Email != "a@example.com" || s.DisplayName != "A" || s.RefreshToken != "rt" || s.ExpiresIn != 3600 {
		t.Fatalf("session %+v", s)
	}
}
