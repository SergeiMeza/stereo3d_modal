// Package identity signs web users in through the gateway, for browsers
// that cannot reach Google (mainland China, through the shared relay).
//
// The gateway, which does reach Google, calls Firebase Auth's REST API on
// the user's behalf and hands back the Firebase ID token and refresh token
// the JS SDK would have held. The browser then calls every other route with
// that ID token, which the gateway verifies exactly as before (auth.Verifier).
// So there is one identity (the same uid), no second token type and no
// secret of our own; the web API key is public by design. Mirrors Spatial
// Video Studio's backend (firebase/functions/src/identity.ts).
//
// Passwords and tokens are never logged.
package identity

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
)

const (
	identityToolkitURL = "https://identitytoolkit.googleapis.com/v1"
	secureTokenURL     = "https://securetoken.googleapis.com/v1/token"
	requestTimeout     = 10 * time.Second
	maxAnswerBytes     = 1 << 20
)

// Session is what the browser keeps, in the SDK's terms.
type Session struct {
	UID          string `json:"uid"`
	Email        string `json:"email"`
	DisplayName  string `json:"display_name"`
	IDToken      string `json:"id_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"` // seconds; Firebase issues 3600
}

// Op names the call, because Firebase's codes mean different things per
// call (EMAIL_NOT_FOUND is a bad sign-in but a quiet reset).
type Op string

const (
	OpSignIn  Op = "signin"
	OpSignUp  Op = "signup"
	OpRefresh Op = "refresh"
	OpReset   Op = "reset"
	OpProfile Op = "profile"
)

// Client calls Firebase Auth's REST API with the project's web API key.
type Client struct {
	apiKey     string
	http       *http.Client
	toolkitURL string
	tokenURL   string
}

func New(apiKey string) *Client {
	return &Client{
		apiKey:     apiKey,
		http:       &http.Client{Timeout: requestTimeout},
		toolkitURL: identityToolkitURL,
		tokenURL:   secureTokenURL,
	}
}

// Configured reports whether the API key is set; without it every route
// answers auth_unavailable.
func (c *Client) Configured() bool { return c != nil && c.apiKey != "" }

// SignIn is signInWithEmailAndPassword.
func (c *Client) SignIn(ctx context.Context, email, password string) (*Session, error) {
	body, err := c.postJSON(ctx, OpSignIn, "accounts:signInWithPassword", map[string]any{
		"email": email, "password": password, "returnSecureToken": true,
	})
	if err != nil {
		return nil, err
	}
	return sessionFromSignIn(body)
}

// SignUp is createUserWithEmailAndPassword.
func (c *Client) SignUp(ctx context.Context, email, password string) (*Session, error) {
	body, err := c.postJSON(ctx, OpSignUp, "accounts:signUp", map[string]any{
		"email": email, "password": password, "returnSecureToken": true,
	})
	if err != nil {
		return nil, err
	}
	return sessionFromSignIn(body)
}

// Refresh trades a refresh token for a fresh ID token, as the SDK does.
func (c *Client) Refresh(ctx context.Context, refreshToken string) (*Session, error) {
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {refreshToken}}
	body, err := c.post(ctx, OpRefresh, c.tokenURL+"?key="+url.QueryEscape(c.apiKey),
		"application/x-www-form-urlencoded", []byte(form.Encode()))
	if err != nil {
		return nil, err
	}
	return sessionFromRefresh(body)
}

// SendPasswordReset is sendPasswordResetEmail. An unknown email is not an
// error: the answer never says whether an account exists.
func (c *Client) SendPasswordReset(ctx context.Context, email string) error {
	_, err := c.postJSON(ctx, OpReset, "accounts:sendOobCode", map[string]any{
		"requestType": "PASSWORD_RESET", "email": email,
	})
	var fe *firebaseError
	if errors.As(err, &fe) && fe.code == "EMAIL_NOT_FOUND" {
		return nil
	}
	return err
}

// UpdateDisplayName is updateProfile({displayName}) for the user whose ID
// token this is. Firebase answers with fresh tokens carrying the new name.
func (c *Client) UpdateDisplayName(ctx context.Context, idToken, name string) (*Session, error) {
	body, err := c.postJSON(ctx, OpProfile, "accounts:update", map[string]any{
		"idToken": idToken, "displayName": name, "returnSecureToken": true,
	})
	if err != nil {
		return nil, err
	}
	s := &Session{
		UID:          str(body["localId"]),
		Email:        str(body["email"]),
		DisplayName:  str(body["displayName"]),
		IDToken:      str(body["idToken"]),
		RefreshToken: str(body["refreshToken"]),
		ExpiresIn:    seconds(body["expiresIn"]),
	}
	if s.UID == "" {
		return nil, errIncomplete(OpProfile)
	}
	if s.IDToken == "" {
		s.ExpiresIn = 0
	}
	return s, nil
}

// ---------------------------------------------------------------- transport

// firebaseError is Firebase's refusal: the op and its code
// (INVALID_LOGIN_CREDENTIALS…). It never carries the request.
type firebaseError struct {
	op     Op
	status int
	code   string
}

func (e *firebaseError) Error() string {
	return fmt.Sprintf("firebase auth %s: %d %s", e.op, e.status, e.code)
}

// Code is Firebase's error code, for logs ("" for a transport failure).
func Code(err error) string {
	var fe *firebaseError
	if errors.As(err, &fe) {
		return fe.code
	}
	return ""
}

func errIncomplete(op Op) error {
	return &firebaseError{op: op, status: http.StatusOK, code: "INCOMPLETE"}
}

func (c *Client) postJSON(ctx context.Context, op Op, method string, payload map[string]any) (map[string]any, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	return c.post(ctx, op, c.toolkitURL+"/"+method+"?key="+url.QueryEscape(c.apiKey), "application/json", raw)
}

func (c *Client) post(ctx context.Context, op Op, endpoint, contentType string, payload []byte) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", contentType)
	res, err := c.http.Do(req)
	if err != nil {
		// The URL carries the key; keep it (and anything else) out of logs.
		return nil, fmt.Errorf("firebase auth %s: transport failure", op)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, maxAnswerBytes))
	var body map[string]any
	_ = json.Unmarshal(raw, &body)
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return nil, &firebaseError{op: op, status: res.StatusCode, code: errorCode(body)}
	}
	if body == nil {
		return nil, errIncomplete(op)
	}
	return body, nil
}

// errorCode is the leading word of Firebase's error message:
// "WEAK_PASSWORD : Password should be at least 6 characters" → WEAK_PASSWORD.
func errorCode(body map[string]any) string {
	e, _ := body["error"].(map[string]any)
	msg := strings.TrimSpace(str(e["message"]))
	if i := strings.IndexAny(msg, " :"); i >= 0 {
		msg = msg[:i]
	}
	return msg
}

func sessionFromSignIn(body map[string]any) (*Session, error) {
	s := &Session{
		UID:          str(body["localId"]),
		Email:        str(body["email"]),
		DisplayName:  str(body["displayName"]),
		IDToken:      str(body["idToken"]),
		RefreshToken: str(body["refreshToken"]),
		ExpiresIn:    seconds(body["expiresIn"]),
	}
	if s.UID == "" || s.IDToken == "" || s.RefreshToken == "" {
		return nil, errIncomplete(OpSignIn)
	}
	return s, nil
}

// sessionFromRefresh reads securetoken's snake_case answer. It names only
// the uid, so the email and name come from the new ID token's own claims
// (it came straight from Google over TLS; the gateway verifies it on use).
func sessionFromRefresh(body map[string]any) (*Session, error) {
	s := &Session{
		UID:          str(body["user_id"]),
		IDToken:      str(body["id_token"]),
		RefreshToken: str(body["refresh_token"]),
		ExpiresIn:    seconds(body["expires_in"]),
	}
	if s.UID == "" || s.IDToken == "" || s.RefreshToken == "" {
		return nil, errIncomplete(OpRefresh)
	}
	s.Email, s.DisplayName = tokenClaims(s.IDToken)
	return s, nil
}

// tokenClaims reads email and name from a JWT payload without verifying it.
func tokenClaims(idToken string) (email, name string) {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return "", ""
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return "", ""
	}
	var claims map[string]any
	if json.Unmarshal(raw, &claims) != nil {
		return "", ""
	}
	return str(claims["email"]), str(claims["name"])
}

func str(v any) string {
	s, _ := v.(string)
	return s
}

// seconds reads expiresIn, which Firebase sends as a string ("3600").
func seconds(v any) int {
	switch t := v.(type) {
	case string:
		if n, err := strconv.Atoi(t); err == nil && n > 0 {
			return n
		}
	case float64:
		if t > 0 {
			return int(t)
		}
	}
	return 3600
}

// ---------------------------------------------------------------- errors

// APIError maps a failed call to the gateway's stable error codes. Anything
// unrecognised (Firebase down, a timeout, a new code) is auth_unavailable.
// Messages are user-safe and never name the identity provider.
func APIError(err error) *httpx.APIError {
	var fe *firebaseError
	if !errors.As(err, &fe) {
		return ErrUnavailable()
	}
	return mapCode(fe.op, fe.code)
}

func ErrUnavailable() *httpx.APIError {
	return httpx.Err(http.StatusBadGateway, "auth_unavailable", "sign-in is unavailable right now; try again in a moment")
}

func mapCode(op Op, code string) *httpx.APIError {
	invalidCredentials := httpx.Err(http.StatusUnauthorized, "invalid_credentials", "incorrect email or password")
	expiredSession := httpx.Err(http.StatusUnauthorized, "invalid_refresh_token", "your session has expired; sign in again")

	switch code {
	case "INVALID_LOGIN_CREDENTIALS", "INVALID_PASSWORD":
		return invalidCredentials
	case "EMAIL_NOT_FOUND":
		if op == OpSignIn {
			return invalidCredentials
		}
	case "EMAIL_EXISTS":
		return httpx.Err(http.StatusConflict, "email_exists", "an account with that email already exists; sign in instead")
	case "WEAK_PASSWORD":
		return httpx.Err(http.StatusBadRequest, "weak_password", "password is too weak; use at least 6 characters")
	case "INVALID_EMAIL", "MISSING_EMAIL":
		return httpx.Err(http.StatusBadRequest, "invalid_email", "that email address is not valid")
	case "MISSING_PASSWORD":
		return httpx.Err(http.StatusBadRequest, "missing_password", "enter your password")
	case "TOO_MANY_ATTEMPTS_TRY_LATER", "QUOTA_EXCEEDED", "RESET_PASSWORD_EXCEED_LIMIT":
		return httpx.Err(http.StatusTooManyRequests, "too_many_attempts", "too many attempts; wait a moment and try again")
	case "USER_DISABLED":
		return httpx.Err(http.StatusForbidden, "user_disabled", "this account has been disabled")
	case "OPERATION_NOT_ALLOWED", "PASSWORD_LOGIN_DISABLED", "ADMIN_ONLY_OPERATION":
		return httpx.Err(http.StatusForbidden, "operation_not_allowed", "this sign-in method is not available")
	case "INVALID_REFRESH_TOKEN", "MISSING_REFRESH_TOKEN", "INVALID_GRANT_TYPE":
		return expiredSession
	case "TOKEN_EXPIRED", "USER_NOT_FOUND":
		switch op {
		case OpRefresh:
			return expiredSession
		case OpProfile:
			return httpx.ErrUnauthorized()
		case OpSignIn:
			return invalidCredentials
		}
	case "INVALID_ID_TOKEN", "CREDENTIAL_TOO_OLD_LOGIN_AGAIN":
		return httpx.ErrUnauthorized()
	}
	return ErrUnavailable()
}
