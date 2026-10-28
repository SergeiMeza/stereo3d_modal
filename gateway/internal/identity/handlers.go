package identity

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
)

// Per-address ceilings per minute. Mobile carriers in China put many users
// behind one address, so these stop scripts, not households.
const (
	signInPerMinute  = 30
	signUpPerMinute  = 10
	resetPerMinute   = 10
	refreshPerMinute = 120
	profilePerMinute = 30

	maxBodyBytes   = 64 << 10
	maxEmailLen    = 320
	maxPasswordLen = 4096
	maxTokenLen    = 8192
	maxDisplayName = 120
)

// Handlers serves /v1/auth/*.
type Handlers struct {
	Client *Client
	IPs    IPPolicy

	signIn, signUp, reset, refresh, profile *Limiter
}

func NewHandlers(c *Client, ips IPPolicy) *Handlers {
	return &Handlers{
		Client:  c,
		IPs:     ips,
		signIn:  NewLimiter(signInPerMinute, time.Minute),
		signUp:  NewLimiter(signUpPerMinute, time.Minute),
		reset:   NewLimiter(resetPerMinute, time.Minute),
		refresh: NewLimiter(refreshPerMinute, time.Minute),
		profile: NewLimiter(profilePerMinute, time.Minute),
	}
}

type credentials struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

// SignIn: POST /v1/auth/signin {email,password} → Session.
func (h *Handlers) SignIn(w http.ResponseWriter, r *http.Request) {
	if !h.admit(w, r, h.signIn) {
		return
	}
	var req credentials
	if !decode(w, r, &req) || !validCredentials(w, r, &req) {
		return
	}
	s, err := h.Client.SignIn(r.Context(), req.Email, req.Password)
	h.answer(w, r, OpSignIn, s, err)
}

// SignUp: POST /v1/auth/signup {email,password} → Session.
func (h *Handlers) SignUp(w http.ResponseWriter, r *http.Request) {
	if !h.admit(w, r, h.signUp) {
		return
	}
	var req credentials
	if !decode(w, r, &req) || !validCredentials(w, r, &req) {
		return
	}
	s, err := h.Client.SignUp(r.Context(), req.Email, req.Password)
	h.answer(w, r, OpSignUp, s, err)
}

// Refresh: POST /v1/auth/refresh {refresh_token} → Session.
func (h *Handlers) Refresh(w http.ResponseWriter, r *http.Request) {
	if !h.admit(w, r, h.refresh) {
		return
	}
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if !decode(w, r, &req) {
		return
	}
	req.RefreshToken = strings.TrimSpace(req.RefreshToken)
	if req.RefreshToken == "" || len(req.RefreshToken) > maxTokenLen {
		httpx.WriteErr(r.Context(), w, httpx.ErrInvalid("refresh_token is required"))
		return
	}
	s, err := h.Client.Refresh(r.Context(), req.RefreshToken)
	h.answer(w, r, OpRefresh, s, err)
}

// Reset: POST /v1/auth/reset {email} → {ok:true}, whether or not an
// account has that email.
func (h *Handlers) Reset(w http.ResponseWriter, r *http.Request) {
	if !h.admit(w, r, h.reset) {
		return
	}
	var req struct {
		Email string `json:"email"`
	}
	if !decode(w, r, &req) {
		return
	}
	req.Email = strings.TrimSpace(req.Email)
	if !validEmail(req.Email) {
		httpx.WriteErr(r.Context(), w, mapCode(OpReset, "INVALID_EMAIL"))
		return
	}
	if err := h.Client.SendPasswordReset(r.Context(), req.Email); err != nil {
		h.fail(w, r, OpReset, err)
		return
	}
	httpx.WriteOK(w, map[string]bool{"ok": true})
}

// Profile: POST /v1/auth/profile {display_name}, behind the authed wrapper
// (the bearer token is already verified). Answers the updated Session; its
// tokens are empty when Firebase sent none, and the browser keeps its own.
func (h *Handlers) Profile(w http.ResponseWriter, r *http.Request) {
	if !h.admit(w, r, h.profile) {
		return
	}
	var req struct {
		DisplayName string `json:"display_name"`
	}
	if !decode(w, r, &req) {
		return
	}
	req.DisplayName = strings.TrimSpace(req.DisplayName)
	if req.DisplayName == "" || len([]rune(req.DisplayName)) > maxDisplayName {
		httpx.WriteErr(r.Context(), w, httpx.ErrInvalid("display_name must be 1–120 characters"))
		return
	}
	token := bearer(r)
	if token == "" {
		httpx.WriteErr(r.Context(), w, httpx.ErrUnauthorized())
		return
	}
	s, err := h.Client.UpdateDisplayName(r.Context(), token, req.DisplayName)
	h.answer(w, r, OpProfile, s, err)
}

// ---------------------------------------------------------------- helpers

// admit applies the per-address limit and the configuration check.
func (h *Handlers) admit(w http.ResponseWriter, r *http.Request, l *Limiter) bool {
	ip, _ := h.IPs.ClientIP(r)
	if ok, retry := l.Allow(ip); !ok {
		secs := int(retry.Seconds()) + 1
		w.Header().Set("Retry-After", strconv.Itoa(secs))
		httpx.WriteErr(r.Context(), w, httpx.Err(http.StatusTooManyRequests, "rate_limited",
			"too many attempts; wait a moment and try again"))
		return false
	}
	if !h.Client.Configured() {
		httpx.Log(r.Context()).Error("auth route called without FIREBASE_WEB_API_KEY")
		httpx.WriteErr(r.Context(), w, ErrUnavailable())
		return false
	}
	return true
}

func (h *Handlers) answer(w http.ResponseWriter, r *http.Request, op Op, s *Session, err error) {
	if err != nil {
		h.fail(w, r, op, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, s)
}

// fail logs the op and Firebase's code only, never the request.
func (h *Handlers) fail(w http.ResponseWriter, r *http.Request, op Op, err error) {
	apiErr := APIError(err)
	_, viaRelay := h.IPs.ClientIP(r)
	log := httpx.Log(r.Context()).With("op", string(op), "firebase_code", Code(err), "via_relay", viaRelay)
	if apiErr.Status >= 500 {
		log.Warn("auth call failed", "err", err.Error())
	} else {
		log.Info("auth call refused", "error", apiErr.Code)
	}
	httpx.WriteErr(r.Context(), w, apiErr)
}

func decode(w http.ResponseWriter, r *http.Request, into any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxBodyBytes)
	if err := json.NewDecoder(r.Body).Decode(into); err != nil {
		httpx.WriteErr(r.Context(), w, httpx.ErrInvalid("body must be a JSON object"))
		return false
	}
	return true
}

func validCredentials(w http.ResponseWriter, r *http.Request, c *credentials) bool {
	c.Email = strings.TrimSpace(c.Email)
	if !validEmail(c.Email) {
		httpx.WriteErr(r.Context(), w, mapCode(OpSignIn, "INVALID_EMAIL"))
		return false
	}
	if c.Password == "" {
		httpx.WriteErr(r.Context(), w, mapCode(OpSignIn, "MISSING_PASSWORD"))
		return false
	}
	if len(c.Password) > maxPasswordLen {
		httpx.WriteErr(r.Context(), w, httpx.ErrInvalid("password is too long"))
		return false
	}
	return true
}

func validEmail(e string) bool {
	at := strings.IndexByte(e, '@')
	return len(e) <= maxEmailLen && at > 0 && at < len(e)-1 && !strings.ContainsAny(e, " \t\r\n")
}

func bearer(r *http.Request) string {
	parts := strings.SplitN(r.Header.Get("Authorization"), " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}
