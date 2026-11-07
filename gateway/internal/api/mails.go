package api

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Customer mails (spec v6 G3; branded and translated 2026-11-08): sent by
// the gateway through Resend in one layout (mail.Layout: the app's icon
// and name, a title, a short body, one button, a details table, a footer
// with help and the legal entity), HTML with a plain-text alternative, in
// the account's language (mailLangOf). Subjects end " · Spatial Video
// Studio" (the owner's rule: subjects name the app); "payment method",
// not "card", no processor names. Each is claimed once by key in
// mails_{env} before it is sent, so retried events never mail twice. On
// test every customer mail goes to the owner's address instead, marked
// with who it was for.

// supportInbox is the reply-to of every customer mail.
const supportInbox = mail.SupportEmail

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

// customerMail is one G3 mail before addressing: its kind and how it
// renders in a language.
type customerMail struct {
	Kind string // E1…E20, RN1, SU1, DL1…
	// Render lays the mail out in lang (one of mail.Langs).
	Render func(lang string) mail.Layout
	// Receipt: a copy goes to the company's billing email when it has one.
	Receipt bool
	// OwnAddress: off prod too, the mail goes to the account's own address
	// (marked as a test), never the owner's inbox: the account deletion
	// mails, sent only when that account's holder asked (owner 2026-11-07).
	OwnAddress bool
}

// layout is the mail in lang.
func (m customerMail) layout(lang string) mail.Layout {
	l := m.Render(lang)
	l.Lang = lang
	return l
}

// subject and text are the English mail (admin previews, tests).
func (m customerMail) subject() string { return m.layout("en").FullSubject() }
func (m customerMail) text() string    { return m.layout("en").Text() }

// mailLangOf is the account's mail language: the web's explicit
// mail_locale, else the language its requests asked for
// (Accept-Language), else the Lifelike intro's locale, else English.
func mailLangOf(c *store.Customer) string {
	if c == nil {
		return "en"
	}
	for _, tag := range []string{c.MailLocale, c.AcceptLocale, c.Locale} {
		if l := mail.LangFor(tag); l != "" {
			return l
		}
	}
	return "en"
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
	cust, _ := s.Store.GetCustomer(ctx, uid)
	lang := mail.Resolve(mailLangOf(cust))
	l := m.layout(lang)
	to := email
	cc := ""
	if m.Receipt {
		cc = s.billingEmailCopy(ctx, uid, email)
	}
	msg := mail.Message{ReplyTo: supportInbox, IdempotencyKey: key}
	if cc != "" {
		msg.Cc = []string{cc}
	}
	if s.Cfg.Env != "prod" {
		to, msg.Cc = s.Cfg.OwnerAlertEmail, nil // test mails only ever reach the owner
		if m.OwnAddress {
			to = email // …or, for the deletion mails, the account itself, never a copy
		}
		who := email
		if cc != "" {
			who += ", " + cc
		}
		l.Banner = mail.T(lang, "common.testBanner", mail.Args{"email": who})
		l.Subject += " (test)"
	}
	msg.Subject, msg.Text, msg.HTML = l.FullSubject(), l.Text(), l.HTML()
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
	slog.InfoContext(ctx, "customer mail sent", "kind", m.Kind, "uid", uid, "lang", lang)
}

// accountEmail is the account's email for mails ("" when unknown).
func (s *Service) accountEmail(ctx context.Context, uid string) string {
	if c, err := s.Store.GetCustomer(ctx, uid); err == nil {
		return c.Email
	}
	return ""
}

// mailOrderConfirmation is E1 (C3, v6 V8): a 3D video paid at start that
// isn't a preview is accepted — sent before it is queued, the send
// recorded first. The amount reads "¥618 (US$3.75)" when the payment
// was presented locally (Adaptive Pricing). When the payment came in
// before its Checkout Session could say so (deferE1), the mail waits for
// the session (releaseDeferredE1) or two minutes (the reconciler).
func (s *Service) mailOrderConfirmation(ctx context.Context, c *store.Conversion) {
	if c.Step != store.StepProduction || c.Quote.AmountCents <= 0 {
		return
	}
	key := "E1_" + c.ID
	if e1Deferred(ctx) && c.Stripe.Presentment == nil {
		if ok, err := s.Store.DeferMail(ctx, key, c.UID, "E1", c.ID, time.Now().UTC().Add(e1DeferFor)); err == nil && ok {
			slog.InfoContext(ctx, "receipt mail waits for the payment's currency", "kind", "E1", "conversion_id", c.ID)
		}
		return
	}
	usd := c.Quote.AmountCents
	if c.Stripe.Presentment != nil && c.Stripe.CapturedCents > 0 {
		usd = c.Stripe.CapturedCents
	}
	s.mailCustomer(ctx, key, c.UID, s.accountEmail(ctx, c.UID),
		orderConfirmationMail(s.runMailInfo(ctx, c), amountText(c.Stripe.Presentment, usd), s.Cfg.SiteURL+"/projects/"+c.ProjectID, !s.onBusinessPlan(ctx, c.UID)))
}

// onBusinessPlan: the account has an active Business or Studio plan.
func (s *Service) onBusinessPlan(ctx context.Context, uid string) bool {
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil || cust.Plan == nil || !cust.Plan.Active(time.Now()) {
		return false
	}
	return cust.Plan.Tier == pricing.TierBusiness || cust.Plan.Tier == pricing.TierStudio
}

// mailOwed is E2 (a group's whole backup loop failed), E3 (the 24 h retry
// failed) or E4 (day 7). The triggers and amounts are the app's shipped
// ones; only the mail's look and language changed (owner 2026-11-08).
func (s *Service) mailOwed(ctx context.Context, kind, key, uid string, cents int64) {
	s.mailCustomer(ctx, key, uid, s.accountEmail(ctx, uid), owedMail(kind, money(cents), s.Cfg.SiteURL+"/billing?pay=1"))
}

// mailDownloadsBack is E5: the automatic retry (or the balance) cleared
// the account.
func (s *Service) mailDownloadsBack(ctx context.Context, key, uid string, cents int64) {
	s.mailCustomer(ctx, key, uid, s.accountEmail(ctx, uid), downloadsBackMail(money(cents), s.Cfg.SiteURL))
}

// mailHandoff is E7: the hand-off link, mailed on request.
func (s *Service) mailHandoff(ctx context.Context, key, uid, email, link string, cents int64) {
	s.mailCustomer(ctx, key, uid, email, handoffMail(money(cents), link))
}
