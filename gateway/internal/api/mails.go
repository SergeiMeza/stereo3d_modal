package api

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Customer mails (spec v6 G3): sent by the gateway through Resend, every
// subject starting "Spatial Video Studio:" (renamed from Spatial Video Studio,
// owner 2026-11-04), at most three short lines and one button, the footer
// naming the web, "payment method" never
// "card", no processor names. Each is claimed once by key in mails_{env}
// before it is sent, so retried events never mail twice. On test every
// customer mail goes to the owner's address instead, marked with who it
// was for.

const mailFooter = "Spatial Video Studio on the web · Help: support@spatial-ai-labs.com"

// supportInbox is the reply-to of every customer mail.
const supportInbox = "support@spatial-ai-labs.com"

// money: "$1,500.00" (thousands grouped).
func money(cents int64) string {
	sign := ""
	if cents < 0 {
		sign, cents = "-", -cents
	}
	d := strconv.FormatInt(cents/100, 10)
	for i := len(d) - 3; i > 0; i -= 3 {
		d = d[:i] + "," + d[i:]
	}
	return fmt.Sprintf("%s$%s.%02d", sign, d, cents%100)
}

// customerMail is one G3 mail before addressing.
type customerMail struct {
	Kind    string // E1…E12
	Subject string
	Lines   []string
	Button  string
	Link    string
	// Receipt: a copy goes to the company's billing email when it has one.
	Receipt bool
}

func (m customerMail) text() string {
	var b strings.Builder
	for _, l := range m.Lines {
		b.WriteString(l + "\n")
	}
	if m.Button != "" {
		fmt.Fprintf(&b, "\n%s: %s\n", m.Button, m.Link)
	}
	b.WriteString("\n" + mailFooter + "\n")
	return b.String()
}

// mailCustomer claims key and sends m to the account's email (on test:
// to the owner's address). Never fails the caller.
func (s *Service) mailCustomer(ctx context.Context, key, uid, email string, m customerMail) {
	if s.Store == nil {
		return
	}
	ok, err := s.Store.ClaimMail(ctx, key, uid, m.Kind)
	if err != nil || !ok {
		return
	}
	to := email
	msg := mail.Message{Subject: m.Subject, Text: m.text(), ReplyTo: supportInbox, IdempotencyKey: key}
	cc := ""
	if m.Receipt {
		cc = s.billingEmailCopy(ctx, uid, email)
	}
	if cc != "" {
		msg.Cc = []string{cc}
	}
	if s.Cfg.Env != "prod" {
		to, msg.Cc = s.Cfg.OwnerAlertEmail, nil // test mails only ever reach the owner
		msg.Subject += " (test)"
		head := "[Test environment: this mail is for " + email
		if cc != "" {
			head += ", copy to " + cc
		}
		msg.Text = head + ".]\n\n" + msg.Text
	}
	if to == "" || !s.Mail.Configured() {
		slog.InfoContext(ctx, "customer mail not sent (no address or key)", "kind", m.Kind, "uid", uid)
		s.Store.MarkMail(ctx, key, "skipped")
		return
	}
	msg.To = to
	if err := s.Mail.Send(ctx, msg); err != nil {
		slog.WarnContext(ctx, "customer mail failed", "kind", m.Kind, "uid", uid, "err", err)
		s.Store.MarkMail(ctx, key, "failed")
		return
	}
	s.Store.MarkMail(ctx, key, "sent")
	slog.InfoContext(ctx, "customer mail sent", "kind", m.Kind, "uid", uid)
}

// accountEmail is the account's email for mails ("" when unknown).
func (s *Service) accountEmail(ctx context.Context, uid string) string {
	if c, err := s.Store.GetCustomer(ctx, uid); err == nil {
		return c.Email
	}
	return ""
}

// mailOrderConfirmation is E1 (C3, v6 V8): a run paid at start that isn't
// a preview is accepted — sent before it is queued, the send recorded
// first.
func (s *Service) mailOrderConfirmation(ctx context.Context, c *store.Conversion) {
	if c.Step != store.StepProduction || c.Quote.AmountCents <= 0 {
		return
	}
	s.mailCustomer(ctx, "E1_"+c.ID, c.UID, s.accountEmail(ctx, c.UID),
		orderConfirmationMail(s.runLabel(ctx, c), c.Quote.AmountCents, s.Cfg.SiteURL+"/projects/"+c.ProjectID, !s.onBusinessPlan(ctx, c.UID)))
}

// orderConfirmationMail is E1; consumer (no Business or Studio plan) adds
// the express-consent line.
func orderConfirmationMail(label string, cents int64, link string, consumer bool) customerMail {
	lines := []string{label + " · " + money(cents) + ", charged now.", "Refunded in full if it fails."}
	if consumer {
		// The durable-medium confirmation of express consent (UK CCR / EU
		// CRD), for consumers only.
		lines = append(lines, expressConsentLine)
	}
	return customerMail{Kind: "E1", Subject: "Spatial Video Studio: your 3D video is starting", Lines: lines,
		Button: "View your project", Link: link, Receipt: true}
}

// expressConsentLine closes a paid run's receipt (owner 2026-11-05).
const expressConsentLine = "You asked us to start right away, so this run can't be cancelled once it's done."

// onBusinessPlan: the account has an active Business or Studio plan.
func (s *Service) onBusinessPlan(ctx context.Context, uid string) bool {
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || !cust.Plan.Active(time.Now()) {
		return false
	}
	return cust.Plan.Tier == pricing.TierBusiness || cust.Plan.Tier == pricing.TierStudio
}

// mailPaymentFailed is E2 (a group's whole backup loop failed), E3 (the
// 24 h retry failed) or E4 (day 7).
func (s *Service) mailOwed(ctx context.Context, kind, key, uid string, cents int64) {
	m := customerMail{Kind: kind, Button: "Pay " + money(cents), Link: s.Cfg.SiteURL + "/billing?pay=1"}
	switch kind {
	case "E2":
		m.Subject = "Spatial Video Studio: a payment didn't go through"
		m.Lines = []string{"We couldn't take " + money(cents) + " for your last 3D videos.", "Downloads are paused until it's paid."}
	case "E3":
		m.Subject = "Spatial Video Studio: your payment is still waiting"
		m.Lines = []string{money(cents) + " for your last 3D videos is still unpaid.", "Pay it to download again."}
	case "E4":
		m.Subject = "Spatial Video Studio: last reminder about your payment"
		m.Lines = []string{"This is our last reminder about " + money(cents) + " for your last 3D videos.", "We keep your files until it's paid."}
	}
	s.mailCustomer(ctx, key, uid, s.accountEmail(ctx, uid), m)
}

// mailDownloadsBack is E5: the automatic retry cleared the account.
func (s *Service) mailDownloadsBack(ctx context.Context, key, uid string, cents int64) {
	s.mailCustomer(ctx, key, uid, s.accountEmail(ctx, uid), customerMail{
		Kind:    "E5",
		Subject: "Spatial Video Studio: your downloads are back",
		Lines:   []string{"Your payment of " + money(cents) + " went through.", "Everything is ready to download again."},
		Button:  "Open Spatial Video Studio", Link: s.Cfg.SiteURL,
	})
}

// mailHandoff is E7: the hand-off link, mailed on request.
func (s *Service) mailHandoff(ctx context.Context, key, uid, email, link string, cents int64) {
	s.mailCustomer(ctx, key, uid, email, customerMail{
		Kind:    "E7",
		Subject: "Spatial Video Studio: finish your payment",
		Lines:   []string{"Open this on your phone or computer to pay " + money(cents) + " for your 3D video.", "The link works for 30 minutes."},
		Button:  "Pay " + money(cents), Link: link,
	})
}
