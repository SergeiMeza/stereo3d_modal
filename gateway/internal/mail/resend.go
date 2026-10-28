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
	"html"
	"io"
	"net/http"
	"strings"
	"time"
)

const (
	resendURL      = "https://api.resend.com/emails"
	requestTimeout = 10 * time.Second
	// DefaultFrom is a sender on the verified spatial-ai-labs.com domain.
	DefaultFrom = "Stereo3D Studio <no-reply@spatial-ai-labs.com>"
)

// Message is one plain email.
type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
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
const ResetSubject = "Reset your Stereo3D Studio password"

// PasswordReset is the reset email for link. Plain and short; it names
// only the app and the site.
func PasswordReset(to, link string) Message {
	text := "Hi,\n\n" +
		"We got a request to reset the password for your Stereo3D Studio account.\n" +
		"To choose a new password, open this link:\n\n" +
		link + "\n\n" +
		"The link works once and expires in one hour. If you didn't ask for this, " +
		"you can ignore this email; your password stays the same.\n\n" +
		"Stereo3D Studio\n"
	l := html.EscapeString(link)
	htmlBody := "<p>Hi,</p>" +
		"<p>We got a request to reset the password for your Stereo3D Studio account. " +
		"To choose a new password, open this link:</p>" +
		`<p><a href="` + l + `">Choose a new password</a></p>` +
		`<p style="color:#666;font-size:13px">` + l + "</p>" +
		"<p>The link works once and expires in one hour. If you didn't ask for this, " +
		"you can ignore this email; your password stays the same.</p>" +
		"<p>Stereo3D Studio</p>"
	return Message{To: to, Subject: ResetSubject, Text: text, HTML: htmlBody}
}
