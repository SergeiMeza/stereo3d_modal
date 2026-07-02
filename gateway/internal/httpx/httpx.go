// Package httpx: JSON envelope, API errors, request-id middleware, structured logs.
//
// Every log line carries request_id (and conversion_id / uid where known) as
// structured fields so a support ticket quoting a conversion_id can be traced
// in Cloud Logging with one filter.
package httpx

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
)

type ctxKey int

const requestIDKey ctxKey = iota

// ---------------------------------------------------------------- errors

type APIError struct {
	Code    string         `json:"error"`
	Message string         `json:"message"`
	Status  int            `json:"-"`
	Details map[string]any `json:"details,omitempty"`
}

func (e *APIError) Error() string { return e.Code + ": " + e.Message }

func Err(status int, code, message string) *APIError {
	return &APIError{Code: code, Message: message, Status: status}
}

func ErrInvalid(msg string) *APIError { return Err(http.StatusBadRequest, "invalid_request", msg) }
func ErrUnauthorized() *APIError {
	return Err(http.StatusUnauthorized, "invalid_token", "invalid or expired authentication token")
}
func ErrNotFound(resource string) *APIError {
	return Err(http.StatusNotFound, "not_found", resource+" not found")
}
func ErrConflict(msg string) *APIError { return Err(http.StatusConflict, "conflict", msg) }
func ErrUpstream(conversionID string) *APIError {
	e := Err(http.StatusBadGateway, "upstream_error",
		"the conversion service returned an error; quote this ID to support")
	e.Details = map[string]any{"conversion_id": conversionID}
	return e
}
func ErrServer() *APIError {
	return Err(http.StatusInternalServerError, "server_error", "internal server error")
}

// ---------------------------------------------------------------- responses

func WriteJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func WriteOK(w http.ResponseWriter, data any) { WriteJSON(w, http.StatusOK, data) }

// WriteErr sends a structured error. Non-APIError values are logged in full
// and returned to the client as an opaque server_error.
func WriteErr(ctx context.Context, w http.ResponseWriter, err error) {
	apiErr, ok := err.(*APIError)
	if !ok {
		slog.ErrorContext(ctx, "unhandled error", "err", err, "request_id", RequestID(ctx))
		apiErr = ErrServer()
	}
	WriteJSON(w, apiErr.Status, map[string]any{
		"success": false,
		"error":   apiErr.Code,
		"message": apiErr.Message,
		"details": apiErr.Details,
	})
}

// ---------------------------------------------------------------- middleware

// WithRequestID assigns a request id (honoring Cloud Run's trace header for
// log correlation) and logs one line per request.
func WithRequestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := r.Header.Get("X-Cloud-Trace-Context")
		if id == "" {
			b := make([]byte, 8)
			_, _ = rand.Read(b)
			id = hex.EncodeToString(b)
		}
		ctx := context.WithValue(r.Context(), requestIDKey, id)
		w.Header().Set("X-Request-Id", id)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// WithCORS answers browser cross-origin requests (the web client on Vercel /
// localhost). Auth is a bearer token — no cookies — so reflecting any listed
// origin without Allow-Credentials is safe. allowedOrigins is a comma-free
// slice; a single "*" allows every origin.
func WithCORS(allowedOrigins []string, next http.Handler) http.Handler {
	allowAll := len(allowedOrigins) == 1 && allowedOrigins[0] == "*"
	allowed := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		allowed[o] = true
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && (allowAll || allowed[origin]) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			if r.Method == http.MethodOptions {
				h.Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
				h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key")
				h.Set("Access-Control-Max-Age", "3600")
				w.WriteHeader(http.StatusNoContent)
				return
			}
			h.Set("Access-Control-Expose-Headers", "X-Request-Id")
		}
		next.ServeHTTP(w, r)
	})
}

func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey).(string)
	return id
}

// Log returns a logger pre-tagged with the request id.
func Log(ctx context.Context) *slog.Logger {
	return slog.Default().With("request_id", RequestID(ctx))
}
