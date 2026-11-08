package identity

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

// appleStub answers signInWithIdp with reply and keeps the last request.
func appleStub(t *testing.T, status int, reply string) (*Handlers, *map[string]any) {
	t.Helper()
	got := map[string]any{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.Path, "accounts:signInWithIdp") {
			t.Errorf("unexpected call %s", r.URL.Path)
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(reply))
	}))
	t.Cleanup(srv.Close)
	c := New("web-key")
	c.toolkitURL = srv.URL + "/v1"
	return NewHandlers(c, NewIPPolicy("", "")), &got
}

func postApple(h *Handlers, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/v1/auth/apple", strings.NewReader(body))
	r.Header.Set("X-Forwarded-For", "1.1.1.1")
	w := httptest.NewRecorder()
	h.Apple(w, r)
	return w
}

func TestAppleSignsInWithoutACaller(t *testing.T) {
	h, got := appleStub(t, 200, `{"localId":"u-apple","email":"a@privaterelay.appleid.com","idToken":"id","refreshToken":"rt","expiresIn":"3600","isNewUser":true,"providerId":"apple.com"}`)
	w := postApple(h, `{"id_token":"apple-jwt","nonce":"raw-nonce"}`)
	if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	var ans map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &ans)
	if ans["uid"] != "u-apple" || ans["id_token"] != "id" || ans["refresh_token"] != "rt" || ans["expires_in"] != float64(3600) || ans["is_new_user"] != true {
		t.Fatalf("answer %v", ans)
	}
	post, _ := url.ParseQuery((*got)["postBody"].(string))
	if post.Get("id_token") != "apple-jwt" || post.Get("providerId") != "apple.com" || post.Get("nonce") != "raw-nonce" {
		t.Fatalf("postBody %v", post)
	}
	if _, ok := (*got)["idToken"]; ok {
		t.Fatal("a sign-in must not carry a caller's ID token (that would link)")
	}
}

func TestAppleAccountExistsNamesTheAddress(t *testing.T) {
	h, _ := appleStub(t, 200, `{"needConfirmation":true,"email":"a@example.com","providerId":"apple.com"}`)
	w := postApple(h, `{"id_token":"apple-jwt","nonce":"n"}`)
	if w.Code != 409 || !strings.Contains(w.Body.String(), `"account_exists"`) || !strings.Contains(w.Body.String(), `"email":"a@example.com"`) {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), "id_token") {
		t.Fatalf("no session on account_exists: %s", w.Body)
	}
}

func TestAppleRefusalsAndValidation(t *testing.T) {
	h, _ := appleStub(t, 400, `{"error":{"message":"INVALID_IDP_RESPONSE : bad token"}}`)
	if w := postApple(h, `{"id_token":"apple-jwt","nonce":"n"}`); w.Code != 401 || !strings.Contains(w.Body.String(), "apple_invalid") {
		t.Fatalf("bad token: %d %s", w.Code, w.Body)
	}
	h, _ = appleStub(t, 400, `{"error":{"message":"MISSING_OR_INVALID_NONCE : Duplicate credential"}}`)
	if w := postApple(h, `{"id_token":"apple-jwt","nonce":"n"}`); w.Code != 401 || !strings.Contains(w.Body.String(), "apple_invalid") {
		t.Fatalf("bad nonce: %d %s", w.Code, w.Body)
	}
	h, _ = appleStub(t, 400, `{"error":{"message":"USER_DISABLED"}}`)
	if w := postApple(h, `{"id_token":"apple-jwt"}`); w.Code != 403 || !strings.Contains(w.Body.String(), "user_disabled") {
		t.Fatalf("disabled: %d %s", w.Code, w.Body)
	}
	if w := postApple(h, `{"id_token":"  "}`); w.Code != 400 {
		t.Fatalf("empty token: %d %s", w.Code, w.Body)
	}
	if w := postApple(h, `nope`); w.Code != 400 {
		t.Fatalf("not JSON: %d %s", w.Code, w.Body)
	}
	if w := postApple(NewHandlers(New(""), NewIPPolicy("", "")), `{"id_token":"x"}`); w.Code != 502 {
		t.Fatalf("no key: %d %s", w.Code, w.Body)
	}
}
