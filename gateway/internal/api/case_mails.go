package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Case mails (G3: E6, E9-E12) and owner notices (M9: O1-O5).

// caseWhatOf names a case's 3D videos for mails (two, then "and N
// more"), else its balance or payment.
func (s *Service) caseWhatOf(ctx context.Context, cs *store.Case) caseWhat {
	var w caseWhat
	for i, id := range cs.Related.ConversionIDs {
		if i == 2 {
			w.More = len(cs.Related.ConversionIDs) - 2
			break
		}
		if c, err := s.Store.GetConversion(ctx, id); err == nil {
			r := s.runMailInfo(ctx, c)
			w.Labels = append(w.Labels, joinDot(r.Name, r.product()))
		}
	}
	if len(w.Labels) == 0 {
		w.More, w.Fallback = 0, "payment"
		if cs.Type == store.CaseBalanceRefund {
			w.Fallback = "balance"
		}
	}
	return w
}

func (s *Service) historyLink() string { return s.Cfg.SiteURL + "/billing" }

// mailRefunded is E6 (to the payment method, out of band, to the balance,
// waive).
func (s *Service) mailRefunded(ctx context.Context, cs *store.Case, cents int64, how string) {
	s.mailCustomer(ctx, fmt.Sprintf("E6_%s_%d", cs.ID, cents), cs.UID, s.accountEmail(ctx, cs.UID),
		refundedMail(how, money(cents), s.caseWhatOf(ctx, cs), cs.ID, s.historyLink()))
}

// mailRefundUnderReview is E9.
func (s *Service) mailRefundUnderReview(ctx context.Context, cs *store.Case) {
	s.mailCustomer(ctx, "E9_"+cs.ID, cs.UID, s.accountEmail(ctx, cs.UID), refundUnderReviewMail(s.caseWhatOf(ctx, cs), cs.ID, s.historyLink()))
}

// mailRefundDenied is E10.
func (s *Service) mailRefundDenied(ctx context.Context, cs *store.Case, text string) {
	s.mailCustomer(ctx, "E10_"+cs.ID, cs.UID, s.accountEmail(ctx, cs.UID), refundDeniedMail(text, cs.ID, s.historyLink()))
}

// mailRefundQuestion is E11.
func (s *Service) mailRefundQuestion(ctx context.Context, cs *store.Case, question string) {
	s.mailCustomer(ctx, fmt.Sprintf("E11_%s_%d", cs.ID, time.Now().Unix()), cs.UID, s.accountEmail(ctx, cs.UID), refundQuestionMail(question, cs.ID))
}

// mailRefundFailed is E12.
func (s *Service) mailRefundFailed(ctx context.Context, cs *store.Case, cents int64) {
	s.mailCustomer(ctx, "E12_"+cs.ID, cs.UID, s.accountEmail(ctx, cs.UID), refundFailedMail(money(cents), cs.ID))
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
// with sample data (M1): {mails: [{id, subject, text, html}],
// deny_templates}. English.
func (s *Service) HandleAdminMailPreviews(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	out := make([]map[string]string, 0)
	for _, p := range mailSamples(s.Cfg.SiteURL) {
		l := p.Mail.layout("en")
		out = append(out, map[string]string{"id": p.ID, "subject": l.FullSubject(), "text": l.Text(), "html": l.HTML()})
	}
	httpx.WriteOK(w, map[string]any{"mails": out, "deny_templates": denyTemplates})
}
