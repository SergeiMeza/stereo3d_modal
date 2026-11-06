package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Fresh: a sign-in within FreshSignInWindow passes; a stale or missing
// auth_time answers 401 reauth_required {max_age_s: 300, method}.
func TestFreshSignIn(t *testing.T) {
	ran := false
	h := Fresh(func(w http.ResponseWriter, _ *http.Request, _ *AuthedUser) { ran = true; w.WriteHeader(204) })
	for name, tc := range map[string]struct {
		at   time.Time
		pass bool
	}{
		"fresh":   {time.Now().Add(-time.Minute), true},
		"edge":    {time.Now().Add(-FreshSignInWindow + 5*time.Second), true},
		"stale":   {time.Now().Add(-FreshSignInWindow - time.Second), false},
		"missing": {time.Time{}, false},
	} {
		ran = false
		w := httptest.NewRecorder()
		h(w, httptest.NewRequest("POST", "/", nil), &AuthedUser{UID: "u1", AuthTime: tc.at})
		if ran != tc.pass {
			t.Fatalf("%s: ran %v", name, ran)
		}
		if !tc.pass {
			var out map[string]any
			_ = json.Unmarshal(w.Body.Bytes(), &out)
			d, _ := out["details"].(map[string]any)
			if w.Code != 401 || out["error"] != "reauth_required" || d["max_age_s"] != float64(300) || d["method"] != "firebase" {
				t.Fatalf("%s: %d %v", name, w.Code, out)
			}
		}
	}
	if cpkFresh != FreshSignInWindow {
		t.Fatal("passkeys use the shared window")
	}
}
