package identity

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

// The app's Google ID token (iOS OAuth client, 2026-11-06): the gateway
// passes it to signInWithIdp as it is, with the raw nonce whose SHA-256
// the token carries, and never checks the audience itself; Firebase
// accepts the project's own OAuth clients.
func TestLinkWithIdPPassesTheGoogleTokenAndRawNonce(t *testing.T) {
	const iosClient = "151335782809-6mrec2gcl7oecji1na7cn500v1vjg4mc.apps.googleusercontent.com"
	raw := "raw-nonce-7f3a"
	sum := sha256.Sum256([]byte(raw))
	part := func(v any) string { b, _ := json.Marshal(v); return base64.RawURLEncoding.EncodeToString(b) }
	token := part(map[string]any{"alg": "RS256"}) + "." +
		part(map[string]any{"iss": "https://accounts.google.com", "aud": iosClient, "azp": iosClient, "sub": "g-1", "nonce": hex.EncodeToString(sum[:])}) + ".sig"

	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &got)
		_ = json.NewEncoder(w).Encode(map[string]any{"localId": "anon-1", "idToken": "id", "refreshToken": "rt", "expiresIn": "3600"})
	}))
	t.Cleanup(srv.Close)
	c := New("web-key")
	c.toolkitURL = srv.URL + "/v1"

	res, err := c.LinkWithIdP(context.Background(), "caller-token", "google.com", token, raw)
	if err != nil || res.Session.UID != "anon-1" || res.Session.RefreshToken != "rt" || res.Session.ExpiresIn != 3600 {
		t.Fatalf("%+v %v", res, err)
	}
	post, _ := url.ParseQuery(got["postBody"].(string))
	if post.Get("id_token") != token || post.Get("providerId") != "google.com" || post.Get("nonce") != raw {
		t.Fatalf("postBody %v", post)
	}
	if got["idToken"] != "caller-token" || got["returnSecureToken"] != true {
		t.Fatalf("request %v", got)
	}
	// Firebase's refusal keeps its code
	srv.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":{"message":"FEDERATED_USER_ID_ALREADY_LINKED"}}`))
	})
	if _, err := c.LinkWithIdP(context.Background(), "caller-token", "google.com", token, raw); Code(err) != "FEDERATED_USER_ID_ALREADY_LINKED" {
		t.Fatalf("code %v", err)
	}
}
