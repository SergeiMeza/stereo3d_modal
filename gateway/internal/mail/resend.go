// Package mail sends the gateway's own account emails through Resend.
//
// Only the China-mode password reset uses it today (identity package): the
// identity provider's own reset email links to a host blocked in mainland
// China, so the gateway mails a link to the site instead. The key is a
// send-only Resend key; it and the recipient are never logged.
package mail

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	resendURL      = "https://api.resend.com/emails"
	requestTimeout = 10 * time.Second
	// DefaultFrom is a sender on the verified spatial-ai-labs.com domain.
	DefaultFrom = "Spatial Video Studio <no-reply@spatial-ai-labs.com>"
)

// Message is one plain email.
type Message struct {
	To      string
	Cc      []string // optional copies (a company's billing address on receipts)
	Subject string
	Text    string
	HTML    string
	// ReplyTo (the support inbox) and IdempotencyKey (Resend dedupes a
	// retried send) are optional.
	ReplyTo        string
	IdempotencyKey string
}

// Resend sends through Resend's REST API.
type Resend struct {
	apiKey   string
	from     string
	endpoint string
	http     *http.Client
}

// NewResend returns a sender; an empty key leaves it unconfigured.
func NewResend(apiKey, from string) *Resend {
	if strings.TrimSpace(from) == "" {
		from = DefaultFrom
	}
	return &Resend{
		apiKey:   strings.TrimSpace(apiKey),
		from:     from,
		endpoint: resendURL,
		http:     &http.Client{Timeout: requestTimeout},
	}
}

// WithEndpoint points the sender at another URL (tests).
func (r *Resend) WithEndpoint(u string) *Resend {
	r.endpoint = u
	return r
}

// Configured reports whether a key is set.
func (r *Resend) Configured() bool { return r != nil && r.apiKey != "" }

// Send delivers m. Errors carry the status only.
func (r *Resend) Send(ctx context.Context, m Message) error {
	if !r.Configured() {
		return fmt.Errorf("mail: not configured")
	}
	payload := map[string]any{
		"from":    r.from,
		"to":      []string{m.To},
		"subject": m.Subject,
		"text":    m.Text,
	}
	if m.HTML != "" {
		payload["html"] = m.HTML
	}
	if m.ReplyTo != "" {
		payload["reply_to"] = m.ReplyTo
	}
	if len(m.Cc) > 0 {
		payload["cc"] = m.Cc
	}
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.endpoint, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+r.apiKey)
	req.Header.Set("Content-Type", "application/json")
	if m.IdempotencyKey != "" {
		req.Header.Set("Idempotency-Key", m.IdempotencyKey)
	}
	res, err := r.http.Do(req)
	if err != nil {
		return fmt.Errorf("mail: transport failure")
	}
	defer res.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 64<<10))
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("mail: status %d", res.StatusCode)
	}
	return nil
}

// ResetSubject names the app, as every user mail does.
var ResetSubject = ResetLayout("en", "").FullSubject()

// PasswordReset is the reset email for link, in the customer mails'
// branded layout (English: the request carries no account language).
func PasswordReset(to, link string) Message {
	l := ResetLayout("en", link)
	return Message{To: to, Subject: l.FullSubject(), Text: l.Text(), HTML: l.HTML()}
}

// ResetLayout is the reset email in lang (also the mail previews).
func ResetLayout(lang, link string) Layout {
	return Layout{Lang: lang, Subject: T(lang, "reset.subject", nil), Title: T(lang, "reset.title", nil),
		Preheader: T(lang, "reset.expiry", nil),
		Paras:     []string{T(lang, "reset.body", nil)},
		Button:    T(lang, "reset.button", nil), ButtonURL: link,
		Notes:  []string{T(lang, "reset.expiry", nil)},
		Reason: T(lang, "reset.reason", nil)}
}
