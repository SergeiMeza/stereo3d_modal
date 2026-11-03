package emailcode

import (
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strconv"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/identity"
)

// Per caller address. Mobile carriers put many people behind one address,
// so these stop scripts, not households; the per-address limits that matter
// (30 s between codes, 5 an hour, 5 tries a code) live in the Store.
const (
	startPerMinute  = 6
	startPerHour    = 40
	verifyPerMinute = 30
	maxBodyBytes    = 16 << 10
)

// Handlers serves /v1/auth/email/*.
type Handlers struct {
	Svc *Service
	IPs identity.IPPolicy

	startMin, startHour, verifyMin *identity.Limiter
}

func NewHandlers(svc *Service, ips identity.IPPolicy) *Handlers {
	return &Handlers{
		Svc:       svc,
		IPs:       ips,
		startMin:  identity.NewLimiter(startPerMinute, time.Minute),
		startHour: identity.NewLimiter(startPerHour, time.Hour),
		verifyMin: identity.NewLimiter(verifyPerMinute, time.Minute),
	}
}

// Start: POST /v1/auth/email/start {email} → {ok, resend_after}.
func (h *Handlers) Start(w http.ResponseWriter, r *http.Request) {
	if !h.admit(w, r, h.startMin, h.startHour) {
		return
	}
	var req struct {
		Email string `json:"email"`
	}
	if !decode(w, r, &req) {
		return
	}
	email, err := NormalizeEmail(req.Email)
	if err != nil {
		h.fail(w, r, "start", err)
		return
	}
	wait, err := h.Svc.Start(r.Context(), email)
	if err != nil {
		h.fail(w, r, "start", err)
		return
	}
	httpx.Log(r.Context()).Info("sign-in code sent")
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, map[string]any{"ok": true, "resend_after": seconds(wait)})
}

// Verify: POST /v1/auth/email/verify {email, code, session?} →
// {uid, is_new_user, custom_token} or, with session:true, the Session
// fields (uid, email, display_name, id_token, refresh_token, expires_in).
func (h *Handlers) Verify(w http.ResponseWriter, r *http.Request) {
	if !h.admit(w, r, h.verifyMin) {
		return
	}
	var req struct {
		Email   string `json:"email"`
		Code    string `json:"code"`
		Session bool   `json:"session"`
	}
	if !decode(w, r, &req) {
		return
	}
	email, err := NormalizeEmail(req.Email)
	if err != nil {
		h.fail(w, r, "verify", err)
		return
	}
	res, err := h.Svc.Verify(r.Context(), email, req.Code, req.Session)
	if err != nil {
		h.fail(w, r, "verify", err)
		return
	}
	httpx.Log(r.Context()).Info("signed in with an email code", "uid", res.UID, "new_user", res.IsNewUser, "session", req.Session)
	w.Header().Set("Cache-Control", "no-store")
	if res.Session != nil {
		httpx.WriteOK(w, struct {
			*identity.Session
			IsNewUser bool `json:"is_new_user"`
		}{res.Session, res.IsNewUser})
		return
	}
	httpx.WriteOK(w, map[string]any{"uid": res.UID, "is_new_user": res.IsNewUser, "custom_token": res.CustomToken})
}

// APIError maps the service's errors to the API's stable codes. Messages
// are user-safe and never name the identity provider.
func APIError(err error) *httpx.APIError {
	var wait *WaitError
	var wrong *WrongCodeError
	switch {
	case errors.Is(err, ErrInvalidEmail):
		return httpx.Err(http.StatusBadRequest, "invalid_email", "that email address is not valid")
	case errors.As(err, &wait):
		e := httpx.Err(http.StatusTooManyRequests, wait.Reason, "wait a moment before asking for another code")
		if wait.Reason == "too_many_codes" {
			e.Message = "too many codes for this address; try again later"
		}
		e.Details = map[string]any{"retry_after": seconds(wait.Wait)}
		return e
	case errors.As(err, &wrong):
		if wrong.AttemptsLeft == 0 {
			return httpx.Err(http.StatusBadRequest, "code_expired", "that code no longer works; ask for a new one")
		}
		e := httpx.Err(http.StatusBadRequest, "code_invalid", "that code isn't right")
		if wrong.AttemptsLeft > 0 {
			e.Details = map[string]any{"attempts_left": wrong.AttemptsLeft}
		}
		return e
	case errors.Is(err, ErrNoCode):
		return httpx.Err(http.StatusBadRequest, "code_expired", "that code no longer works; ask for a new one")
	case errors.Is(err, ErrDisabled):
		return httpx.Err(http.StatusForbidden, "user_disabled", "this account has been disabled")
	}
	return identity.ErrUnavailable()
}

func (h *Handlers) admit(w http.ResponseWriter, r *http.Request, limits ...*identity.Limiter) bool {
	ip, _ := h.IPs.ClientIP(r)
	for _, l := range limits {
		if ok, retry := l.Allow(ip); !ok {
			w.Header().Set("Retry-After", strconv.Itoa(seconds(retry)))
			httpx.WriteErr(r.Context(), w, httpx.Err(http.StatusTooManyRequests, "rate_limited",
				"too many attempts; wait a moment and try again"))
			return false
		}
	}
	if !h.Svc.configured() {
		httpx.Log(r.Context()).Error("email code route called without its store, users or mail sender")
		httpx.WriteErr(r.Context(), w, identity.ErrUnavailable())
		return false
	}
	return true
}

// fail logs the op and the API code only: never the address or the code.
func (h *Handlers) fail(w http.ResponseWriter, r *http.Request, op string, err error) {
	apiErr := APIError(err)
	_, viaRelay := h.IPs.ClientIP(r)
	log := httpx.Log(r.Context()).With("op", "email_code_"+op, "via_relay", viaRelay)
	if apiErr.Status >= 500 {
		log.Warn("email code failed", "err", err.Error())
	} else {
		log.Info("email code refused", "error", apiErr.Code)
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

func seconds(d time.Duration) int {
	if d <= 0 {
		return 0
	}
	return int(math.Ceil(d.Seconds()))
}
