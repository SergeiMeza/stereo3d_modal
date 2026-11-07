package api

import (
	"net/http"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
)

// FreshSignInWindow: sensitive operations need a sign-in this recent
// (owner 2026-11-06: "Sensitive operations require fresh sign ins"). The
// age is the verified ID token's auth_time: refreshing keeps it (Firebase
// carries the original sign-in time), and a China-mode session's tokens
// come from a custom-token sign-in at the gateway, so they carry its time.
const FreshSignInWindow = 5 * time.Minute

// errReauthRequired is 401 reauth_required {max_age_s, method:
// "firebase"}: sign in again (any method), then retry within max_age_s.
func errReauthRequired(message string) *httpx.APIError {
	e := httpx.Err(http.StatusUnauthorized, "reauth_required", message)
	e.Details = map[string]any{"max_age_s": int(FreshSignInWindow.Seconds()), "method": "firebase"}
	return e
}

// requireFreshSignIn: nil when user signed in within FreshSignInWindow; a
// missing auth_time counts as stale.
func requireFreshSignIn(user *AuthedUser) *httpx.APIError {
	if user == nil || user.AuthTime.IsZero() || time.Since(user.AuthTime) > FreshSignInWindow {
		return errReauthRequired("For your security, sign in again to do this.")
	}
	return nil
}

// Fresh wraps a signed-in route with requireFreshSignIn (the routes are
// listed in cmd/gateway/main.go).
func Fresh(h func(http.ResponseWriter, *http.Request, *AuthedUser)) func(http.ResponseWriter, *http.Request, *AuthedUser) {
	return func(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
		if err := requireFreshSignIn(user); err != nil {
			httpx.WriteErr(r.Context(), w, err)
			return
		}
		h(w, r, user)
	}
}
