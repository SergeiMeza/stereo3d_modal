package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Case mails (G3: E6, E9-E12) and owner notices (M9: O1-O5).

// caseRunsLabel names a case's runs for mails ("Kyoto walk · 3D video").
func (s *Service) caseRunsLabel(ctx context.Context, cs *store.Case) string {
	var labels []string
	for i, id := range cs.Related.ConversionIDs {
		if i == 2 {
			labels = append(labels, fmt.Sprintf("and %d more", len(cs.Related.ConversionIDs)-2))
			break
		}
		if c, err := s.Store.GetConversion(ctx, id); err == nil {
			labels = append(labels, s.runLabel(ctx, c))
		}
	}
	if len(labels) == 0 {
		if cs.Type == store.CaseBalanceRefund {
			return "your balance"
		}
		return "your payment"
	}
	return strings.Join(labels, ", ")
}

func (s *Service) historyLink() string { return s.Cfg.SiteURL + "/billing" }

// mailRefunded is E6 (to the card, out of band, to the balance, waive).
func (s *Service) mailRefunded(ctx context.Context, cs *store.Case, cents int64, how string) {
	what := s.caseRunsLabel(ctx, cs)
	m := customerMail{Kind: "E6", Button: "View purchase history", Link: s.historyLink()}
	switch how {
	case "balance":
		m.Subject = fmt.Sprintf("Stereo3D Studio: %s returned to your balance (%s)", money(cents), cs.ID)
		m.Lines = []string{fmt.Sprintf("We returned %s to your balance for %s.", money(cents), what)}
	case "out_of_band":
		m.Subject = fmt.Sprintf("Stereo3D Studio: we refunded %s (%s)", money(cents), cs.ID)
		m.Lines = []string{fmt.Sprintf("We returned %s to you another way.", money(cents)), "Your case: " + cs.ID + "."}
	case "waive":
		m.Subject = fmt.Sprintf("Stereo3D Studio: we won't charge you %s (%s)", money(cents), cs.ID)
		m.Lines = []string{fmt.Sprintf("We removed the %s charge for %s.", money(cents), what)}
	default:
		m.Subject = fmt.Sprintf("Stereo3D Studio: we refunded %s (%s)", money(cents), cs.ID)
		m.Lines = []string{fmt.Sprintf("We refunded %s for %s.", money(cents), what),
			"Refunds usually reach you in 5–10 business days. Your case: " + cs.ID + "."}
	}
	s.mailCustomer(ctx, fmt.Sprintf("E6_%s_%d", cs.ID, cents), cs.UID, s.accountEmail(ctx, cs.UID), m)
}

// mailRefundUnderReview is E9.
func (s *Service) mailRefundUnderReview(ctx context.Context, cs *store.Case) {
	s.mailCustomer(ctx, "E9_"+cs.ID, cs.UID, s.accountEmail(ctx, cs.UID), customerMail{
		Kind: "E9", Subject: fmt.Sprintf("Stereo3D Studio: we're looking at your refund (%s)", cs.ID),
		Lines:  []string{"We're looking at a refund for " + s.caseRunsLabel(ctx, cs) + ".", "We'll email you within 2 business days. Your case: " + cs.ID + "."},
		Button: "View purchase history", Link: s.historyLink(),
	})
}

// denyTemplates are E10's texts (A2 Deny).
var denyTemplates = map[string]string{
	"delivered":     "We checked your 3D video and it was delivered as described, so we can't refund this payment.",
	"outside_terms": "This payment is outside our refund terms, so we can't refund it.",
}

// mailRefundDenied is E10.
func (s *Service) mailRefundDenied(ctx context.Context, cs *store.Case, text string) {
	s.mailCustomer(ctx, "E10_"+cs.ID, cs.UID, s.accountEmail(ctx, cs.UID), customerMail{
		Kind: "E10", Subject: fmt.Sprintf("Stereo3D Studio: about your refund request (%s)", cs.ID),
		Lines:  []string{text, "Questions? Reply to this email and quote " + cs.ID + "."},
		Button: "View purchase history", Link: s.historyLink(),
	})
}

// mailRefundQuestion is E11.
func (s *Service) mailRefundQuestion(ctx context.Context, cs *store.Case, question string) {
	s.mailCustomer(ctx, fmt.Sprintf("E11_%s_%d", cs.ID, time.Now().Unix()), cs.UID, s.accountEmail(ctx, cs.UID), customerMail{
		Kind: "E11", Subject: fmt.Sprintf("Stereo3D Studio: a question about your refund (%s)", cs.ID),
		Lines: []string{question, "Reply to this email. Your case: " + cs.ID + "."},
	})
}

// mailRefundFailed is E12.
func (s *Service) mailRefundFailed(ctx context.Context, cs *store.Case, cents int64) {
	s.mailCustomer(ctx, "E12_"+cs.ID, cs.UID, s.accountEmail(ctx, cs.UID), customerMail{
		Kind: "E12", Subject: fmt.Sprintf("Stereo3D Studio: we couldn't return your refund (%s)", cs.ID),
		Lines: []string{fmt.Sprintf("We couldn't return %s to your payment method.", money(cents)),
			"Reply to this email so we can pay it another way. Your case: " + cs.ID + "."},
	})
}

// noticeOwner is M9: Slack and a mail to the owner, with the case link.
func (s *Service) noticeOwner(ctx context.Context, kind string, cs *store.Case, text string) {
	link := s.adminCaseURL(cs.ID)
	s.Slack.Alert(ctx, kind, text+"\n"+link)
	to := s.Cfg.OwnerAlertEmail
	if p := s.policy(ctx); len(p.Notify.OwnerEmails) > 0 {
		to = p.Notify.OwnerEmails[0]
	}
	if to == "" || s.Mail == nil || !s.Mail.Configured() || s.Store == nil {
		return
	}
	key := fmt.Sprintf("%s_%s_%d", kind, cs.ID, time.Now().Unix()/3600)
	if ok, err := s.Store.ClaimMail(ctx, key, cs.UID, kind); err != nil || !ok {
		return
	}
	subject := text
	if s.Cfg.Env != "prod" {
		subject += " (test)"
	}
	if err := s.Mail.Send(ctx, mail.Message{To: to, Subject: subject, Text: text + "\n\n" + link + "\n"}); err != nil {
		slog.WarnContext(ctx, "owner notice failed", "kind", kind, "case_id", cs.ID, "err", err)
	}
}

func (s *Service) adminCaseURL(id string) string {
	return s.Cfg.AdminOrigin() + "/cases/" + id
}

// caseReminderSweep (reconciler): O2 48 h after opening then daily (and
// after 14 days waiting), O3 on the deadline's morning, O4 three days
// before a dispute's evidence is due.
func (s *Service) caseReminderSweep(ctx context.Context) int {
	cases, err := s.Store.ListCases(ctx, true, 300)
	if err != nil {
		return 0
	}
	pol := s.policy(ctx)
	loc, lerr := time.LoadLocation(pol.Timezone)
	if lerr != nil {
		loc = time.UTC
	}
	now := time.Now().UTC()
	sent := 0
	remind := func(cs *store.Case, kind, text string) {
		last := time.Time{}
		if n := len(cs.Reminders); n > 0 {
			last = cs.Reminders[n-1]
		}
		if now.Sub(last) < 20*time.Hour {
			return
		}
		s.noticeOwner(ctx, kind, cs, text)
		s.Store.UpdateCase(ctx, cs.ID, "system", func(c *store.Case) error {
			c.Reminders = append(c.Reminders, now)
			return nil
		})
		s.Store.AddCaseEvent(ctx, cs.ID, store.CaseEvent{Who: "system", Kind: "reminder", Text: kind})
		sent++
	}
	for _, cs := range cases {
		if cs.Mode != "manual" {
			continue
		}
		switch {
		case cs.Type == store.CaseDispute && cs.Dispute != nil && cs.Dispute.DueBy != nil:
			if left := cs.Dispute.DueBy.Sub(now); left > 0 && left <= 72*time.Hour {
				remind(cs, "O4", "Dispute evidence due in 3 days: "+cs.ID)
			}
		case cs.Status == store.CaseOpen:
			if cs.DeadlineAt != nil && cs.DeadlineAt.In(loc).Format("2006-01-02") == now.In(loc).Format("2006-01-02") && now.In(loc).Hour() >= 8 {
				remind(cs, "O3", "Due today: "+cs.ID)
			} else if now.Sub(cs.OpenedAt) >= time.Duration(pol.ReminderHours)*time.Hour {
				remind(cs, "O2", "Reminder: "+cs.ID+" is waiting for your decision")
			}
		case cs.Status == store.CaseWaitingOnCustomer || cs.Status == store.CaseWaitingForRun:
			if now.Sub(cs.StatusSince) >= 14*24*time.Hour {
				remind(cs, "O2", "Reminder: "+cs.ID+" is waiting for your decision")
			}
		}
	}
	return sent
}

// GET /v1/admin/mail-previews → every customer mail template rendered
// with sample data (M1), as plain text.
func (s *Service) HandleAdminMailPreviews(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	sample := &store.Case{ID: "CASE-0042"}
	what := "Kyoto walk · 3D video · 4K"
	mails := []customerMail{
		{Kind: "E6", Subject: "Stereo3D Studio: we refunded $6.75 (CASE-0042)", Lines: []string{"We refunded $6.75 for " + what + ".", "Refunds usually reach you in 5–10 business days. Your case: CASE-0042."}, Button: "View purchase history", Link: s.historyLink()},
		{Kind: "E6 balance", Subject: "Stereo3D Studio: $6.75 returned to your balance (CASE-0042)", Lines: []string{"We returned $6.75 to your balance for " + what + "."}, Button: "View purchase history", Link: s.historyLink()},
		{Kind: "E6 waive", Subject: "Stereo3D Studio: we won't charge you $1.00 (CASE-0042)", Lines: []string{"We removed the $1.00 charge for Kyoto walk · 3D preview."}, Button: "View purchase history", Link: s.historyLink()},
		{Kind: "E9", Subject: "Stereo3D Studio: we're looking at your refund (CASE-0042)", Lines: []string{"We're looking at a refund for " + what + ".", "We'll email you within 2 business days. Your case: CASE-0042."}, Button: "View purchase history", Link: s.historyLink()},
		{Kind: "E10", Subject: "Stereo3D Studio: about your refund request (CASE-0042)", Lines: []string{denyTemplates["delivered"], "Questions? Reply to this email and quote CASE-0042."}, Button: "View purchase history", Link: s.historyLink()},
		{Kind: "E11", Subject: "Stereo3D Studio: a question about your refund (CASE-0042)", Lines: []string{"Which part of the video looked wrong?", "Reply to this email. Your case: CASE-0042."}},
		{Kind: "E12", Subject: "Stereo3D Studio: we couldn't return your refund (CASE-0057)", Lines: []string{"We couldn't return $6.75 to your payment method.", "Reply to this email so we can pay it another way. Your case: CASE-0057."}},
	}
	_ = sample
	out := make([]map[string]string, 0, len(mails))
	for _, m := range mails {
		out = append(out, map[string]string{"id": m.Kind, "subject": m.Subject, "text": m.text()})
	}
	httpx.WriteOK(w, map[string]any{"mails": out, "deny_templates": denyTemplates})
}
