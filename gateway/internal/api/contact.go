package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// POST /v1/contact {topic: business|studio|other, message (≤ 2000),
// company?, team_size?} → {sent: true}: a signed-in sales enquiry (owner
// 2026-11-04). Stored in contacts_{env}, posted to Slack (sales_contact,
// with uid, email and plan) and mailed to the owner's address with the
// subject "Spatial Video Studio: business enquiry from <email>", reply-to
// the sender. Five a day per account (429 rate_limited).

const (
	contactMessageMax = 2000
	contactFieldMax   = 120
	contactsPerDay    = 5
)

func (s *Service) HandleContact(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		Topic    string `json:"topic"`
		Message  string `json:"message"`
		Company  string `json:"company"`
		TeamSize any    `json:"team_size"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	switch req.Topic {
	case "business", "studio", "other":
	default:
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("topic is business, studio or other"))
		return
	}
	msg := strings.TrimSpace(req.Message)
	if msg == "" || utf8.RuneCountInString(msg) > contactMessageMax {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("message is required, at most 2000 characters"))
		return
	}
	company := strings.TrimSpace(req.Company)
	team := ""
	switch v := req.TeamSize.(type) {
	case nil:
	case string:
		team = strings.TrimSpace(v)
	case float64:
		team = fmt.Sprint(int64(v))
	default:
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("team_size is a number or a short text"))
		return
	}
	if utf8.RuneCountInString(company) > contactFieldMax || utf8.RuneCountInString(team) > contactFieldMax {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("company and team_size: at most 120 characters"))
		return
	}
	now := time.Now().UTC()
	if n, err := s.Store.CountContactsSince(ctx, user.UID, now.Add(-24*time.Hour)); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	} else if n >= contactsPerDay {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusTooManyRequests, "rate_limited",
			"You've sent five messages today. Write to support@spatial-ai-labs.com if it can't wait."))
		return
	}
	email := user.Email
	if email == "" {
		if c, err := s.Store.GetCustomer(ctx, user.UID); err == nil {
			email = c.Email
		}
	}
	plan := s.contactPlan(ctx, user.UID)
	c := store.Contact{UID: user.UID, Email: email, Plan: plan, Topic: req.Topic, Message: msg, Company: company, TeamSize: team, At: now}
	if err := s.Store.AddContact(ctx, c); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if s.Slack != nil {
		s.Slack.Alert(ctx, "sales_contact", contactSlack(c))
	}
	s.mailOwner(ctx, s.contactMail(c))
	httpx.WriteOK(w, map[string]any{"sent": true})
}

// contactPlan is the account's tier for the enquiry ("none" without one).
func (s *Service) contactPlan(ctx context.Context, uid string) string {
	if t := s.accountTier(ctx, uid).Tier; t != "" {
		return t
	}
	return "none"
}

func contactSlack(c store.Contact) string {
	who := c.Email
	if who == "" {
		who = "(no email)"
	}
	text := fmt.Sprintf("%s enquiry from %s (uid `%s`, plan %s)", c.Topic, who, c.UID, c.Plan)
	if c.Company != "" || c.TeamSize != "" {
		text += fmt.Sprintf("\ncompany: %s · team: %s", orDash(c.Company), orDash(c.TeamSize))
	}
	excerpt := c.Message
	if utf8.RuneCountInString(excerpt) > 500 {
		excerpt = string([]rune(excerpt)[:500]) + "…"
	}
	return text + "\n> " + strings.ReplaceAll(excerpt, "\n", "\n> ")
}

func orDash(s string) string {
	if s == "" {
		return "–"
	}
	return s
}

func (s *Service) contactMail(c store.Contact) mail.Message {
	who := c.Email
	if who == "" {
		who = c.UID
	}
	subject := "Spatial Video Studio: business enquiry from " + who
	if s.Cfg != nil && s.Cfg.Env != "prod" {
		subject += " (test)"
	}
	var b strings.Builder
	fmt.Fprintf(&b, "Topic: %s\nFrom: %s\nAccount: %s\nPlan: %s\n", c.Topic, orDash(c.Email), c.UID, c.Plan)
	if c.Company != "" {
		fmt.Fprintf(&b, "Company: %s\n", c.Company)
	}
	if c.TeamSize != "" {
		fmt.Fprintf(&b, "Team size: %s\n", c.TeamSize)
	}
	fmt.Fprintf(&b, "\n%s\n", c.Message)
	return mail.Message{Subject: subject, Text: b.String(), ReplyTo: c.Email}
}
