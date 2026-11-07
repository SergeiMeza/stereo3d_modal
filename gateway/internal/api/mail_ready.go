package api

import (
	"context"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Mails that wait (owner 2026-11-08):
//
//   - E1 waits for its payment's currency. A run paid through a Checkout
//     Session can be applied from the payment_intent.succeeded event before
//     the session completes; that outcome carries no presentment, so E1
//     would show only US$. It is deferred instead, and sent when
//     checkout.session.completed records the presentment
//     (releaseDeferredE1) or after e1DeferFor (the reconciler), once.
//   - RD ("your 3D video is ready") waits readyWindow after a web 3D video
//     finishes, so 3D videos finishing close together go in one mail.
//
// Both are mails_{env} docs in state "deferred"; ClaimMail claims each
// once, so nothing goes out twice.

const (
	e1DeferFor  = 2 * time.Minute
	readyWindow = 150 * time.Second
	// readyShown is how many 3D videos the ready mail names before "and
	// N more".
	readyShown = 3
)

type e1DeferKey struct{}

// withE1Deferred marks ctx: a run paid here whose currency isn't known yet.
func withE1Deferred(ctx context.Context) context.Context {
	return context.WithValue(ctx, e1DeferKey{}, true)
}

func e1Deferred(ctx context.Context) bool {
	v, _ := ctx.Value(e1DeferKey{}).(bool)
	return v
}

// releaseDeferredE1 sends a run's deferred E1 now (its session completed,
// so its currency is known). Nothing when E1 wasn't deferred.
func (s *Service) releaseDeferredE1(ctx context.Context, convID string) {
	if s.Store == nil || !s.Store.MailDeferred(ctx, "E1_"+convID) {
		return
	}
	if c, err := s.Store.GetConversion(ctx, convID); err == nil {
		s.mailOrderConfirmation(context.WithoutCancel(ctx), c)
	}
}

// deferredMailSweep (reconciler) sends deferred mails that are due: E1
// whose session never said, and the ready mails, one per account.
func (s *Service) deferredMailSweep(ctx context.Context, now time.Time) int {
	due, err := s.Store.ListDueDeferredMails(ctx, now, 200)
	if err != nil {
		slog.WarnContext(ctx, "deferred mails not listed", "err", err)
		return 0
	}
	sent := 0
	readyUIDs := map[string]bool{}
	for _, m := range due {
		switch m.Kind {
		case "E1":
			if c, gerr := s.Store.GetConversion(ctx, m.ConversionID); gerr == nil {
				s.mailOrderConfirmation(ctx, c)
				sent++
			}
		case readyKind:
			readyUIDs[m.UID] = true
		}
	}
	for uid := range readyUIDs {
		if s.sendReadyMail(ctx, uid) {
			sent++
		}
	}
	return sent
}

// ------------------------------------------------------------ ready

const readyKind = "RD"

// readyEligible: a web 3D video (a project's production run, not a sample
// or preview) that succeeded with outputs.
func readyEligible(c *store.Conversion) bool {
	return c != nil && c.State == store.StateSucceeded && c.ProjectID != "" && !c.Sample &&
		c.Step == store.StepProduction && len(c.Outputs) > 0
}

// queueReadyMail notes a finished web 3D video for the ready mail (sent
// readyWindow later with any others that finish meanwhile). Never fails
// the caller.
func (s *Service) queueReadyMail(ctx context.Context, c *store.Conversion) {
	if s.Store == nil || !readyEligible(c) {
		return
	}
	if cust, err := s.Store.GetCustomer(ctx, c.UID); err == nil && cust.NotifyReadyOff {
		return
	}
	if _, err := s.Store.DeferMail(ctx, "RD_"+c.ID, c.UID, readyKind, c.ID, time.Now().UTC().Add(readyWindow)); err != nil {
		slog.WarnContext(ctx, "ready mail not queued", "conversion_id", c.ID, "err", err)
	}
}

// sendReadyMail claims every 3D video waiting for uid's ready mail and
// sends one mail for them. false when nothing was sent.
func (s *Service) sendReadyMail(ctx context.Context, uid string) bool {
	waiting, err := s.Store.ListDeferredMailsFor(ctx, uid, readyKind, 100)
	if err != nil || len(waiting) == 0 {
		return false
	}
	cust, _ := s.Store.GetCustomer(ctx, uid)
	var runs []*store.Conversion
	for _, w := range waiting {
		ok, cerr := s.Store.ClaimMail(ctx, w.Key, uid, readyKind)
		if cerr != nil || !ok {
			continue
		}
		c, gerr := s.Store.GetConversion(ctx, w.ConversionID)
		if gerr != nil || !readyEligible(c) {
			s.Store.MarkMail(ctx, w.Key, "skipped")
			continue
		}
		runs = append(runs, c)
	}
	if len(runs) == 0 {
		return false
	}
	if cust != nil && cust.NotifyReadyOff {
		for _, c := range runs {
			s.Store.MarkMail(ctx, "RD_"+c.ID, "skipped")
		}
		return false
	}
	sort.Slice(runs, func(i, j int) bool { return runs[i].ID < runs[j].ID })
	planOn := cust != nil && cust.Plan != nil && cust.Plan.Active(time.Now())
	var items []readyItem
	var keep *time.Time
	projects := map[string]bool{}
	for _, c := range runs {
		items = append(items, readyItem{Run: s.runMailInfo(ctx, c), Paid: runPaidText(c, planOn)})
		projects[c.ProjectID] = true
		if p, perr := s.Store.GetProject(ctx, c.ProjectID); perr == nil && p.FilesDeleteAt != nil && p.FilesDeletedAt == nil {
			if keep == nil || p.FilesDeleteAt.Before(*keep) {
				at := *p.FilesDeleteAt
				keep = &at
			}
		}
	}
	link := strings.TrimRight(s.Cfg.SiteURL, "/") + "/projects"
	if len(projects) == 1 {
		link += "/" + runs[0].ProjectID
	}
	for _, c := range runs {
		s.Store.MarkMail(ctx, "RD_"+c.ID, "mailed in RDM_"+runs[0].ID)
	}
	s.mailCustomer(ctx, "RDM_"+runs[0].ID, uid, s.accountEmail(ctx, uid), readyMail(items, keep, link))
	return true
}

// readyPaid is how a finished 3D video was paid, as the ready mail says.
type readyPaid struct {
	Amount string // "¥495 (US$3.19)", "$4.50"; "" with Source
	Source string // "balance" | "plan_credit" | "credit" | ""
}

// runPaidText: the card amount (local + US$ when presented), else what
// paid it from the balance.
func runPaidText(c *store.Conversion, planOn bool) readyPaid {
	if rb := c.RunBalance; rb != nil && !rb.Partial {
		cash := false
		for _, u := range rb.FifoUsed {
			if u.TopupID != "" {
				cash = true
			}
		}
		switch {
		case cash || len(rb.FifoUsed) == 0:
			return readyPaid{Source: "balance"}
		case planOn:
			return readyPaid{Source: "plan_credit"}
		}
		return readyPaid{Source: "credit"}
	}
	cents := c.Stripe.CapturedCents
	if cents <= 0 {
		cents = runCardCents(c)
	}
	if cents <= 0 {
		return readyPaid{}
	}
	return readyPaid{Amount: amountText(c.Stripe.Presentment, cents)}
}

func (p readyPaid) text(lang string) string {
	switch p.Source {
	case "balance":
		return t(lang, "ready.fromBalance")
	case "plan_credit":
		return t(lang, "ready.fromPlanCredit")
	case "credit":
		return t(lang, "ready.fromCredit")
	}
	return p.Amount
}

// readyItem is one finished 3D video in the ready mail.
type readyItem struct {
	Run  runInfo
	Paid readyPaid
}

// readyMail is RD: one or more web 3D videos are ready; the button opens
// the project (or the projects for several).
func readyMail(items []readyItem, keep *time.Time, link string) customerMail {
	return customerMail{Kind: readyKind, Render: func(lang string) mail.Layout {
		allLifelike := true
		for _, it := range items {
			allLifelike = allLifelike && it.Run.Lifelike
		}
		key := "ready.subject"
		if len(items) > 1 {
			key += "Many"
		}
		key = lifelikeKey(allLifelike, key)
		l := mail.Layout{Lang: lang, Subject: t(lang, key), Title: t(lang, key), Lifelike: allLifelike}
		l.Preheader = t(lang, "ready.preheader")
		if len(items) == 1 {
			it := items[0]
			l.Paras = []string{mail.T(lang, "ready.body", mail.Args{"name": it.Run.name(lang)})}
			l.Rows = it.Run.rows(lang)
			if p := it.Paid.text(lang); p != "" {
				l.Rows = append(l.Rows, mail.Row{Label: t(lang, "label.paid"), Value: p})
			}
		} else {
			l.Paras = []string{t(lang, "ready.bodyMany")}
			shown := items
			if len(items) > readyShown {
				shown = items[:readyShown]
			}
			for _, it := range shown {
				row := mail.Row{Label: it.Run.name(lang), Value: joinDot(it.Run.spec(lang), it.Paid.text(lang))}
				if it.Run.Lifelike {
					row.Pill = it.Run.product()
				} else {
					row.Value = joinDot(it.Run.product(), row.Value)
				}
				l.Rows = append(l.Rows, row)
			}
			if n := len(items) - len(shown); n > 0 {
				l.Rows = append(l.Rows, mail.Row{Label: mail.T(lang, "common.andMore", mail.Args{"count": istr(n)})})
			}
		}
		if keep != nil {
			l.Rows = append(l.Rows, mail.Row{Label: t(lang, "label.keptUntil"), Value: mail.FormatDate(lang, *keep)})
			l.Notes = append(l.Notes, mail.T(lang, "ready.keep", mail.Args{"date": mail.FormatDate(lang, *keep)}))
		}
		l.Button, l.ButtonURL = t(lang, "ready.button"), link
		l.Reason = t(lang, lifelikeKey(allLifelike, "common.reason.ready"))
		return l
	}}
}

// ------------------------------------------------------- languages

// acceptLocaleSeen: uid → the UTC day its Accept-Language was last
// looked at by this instance (at most one read and one write a day).
var (
	acceptLocaleMu   sync.Mutex
	acceptLocaleSeen = struct{ m map[string]string }{m: map[string]string{}}
)

// NoteRequestLanguage records an authed request's Accept-Language as the
// account's mail language source (accept_locale) at most once a UTC day,
// only while the account has no explicit mail_locale. Never fails the
// request; runs off it.
func (s *Service) NoteRequestLanguage(ctx context.Context, uid, acceptLanguage string) {
	if s == nil || s.Store == nil || uid == "" {
		return
	}
	lang := mail.LangFor(acceptLanguage)
	if lang == "" {
		return
	}
	now := time.Now().UTC()
	day := now.Format("2006-01-02")
	acceptLocaleMu.Lock()
	if acceptLocaleSeen.m[uid] == day {
		acceptLocaleMu.Unlock()
		return
	}
	acceptLocaleSeen.m[uid] = day
	if len(acceptLocaleSeen.m) > 50000 {
		acceptLocaleSeen.m = map[string]string{uid: day}
	}
	acceptLocaleMu.Unlock()
	go func() {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
		defer cancel()
		s.recordAcceptLocale(ctx, uid, lang, now)
	}()
}

// recordAcceptLocale writes lang as the account's accept_locale unless it
// has a mail_locale, already has lang, or was written in the last day.
func (s *Service) recordAcceptLocale(ctx context.Context, uid, lang string, now time.Time) bool {
	wrote := false
	_, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		wrote = false
		if acceptLocaleFresh(c, lang, now) {
			return store.ErrStateConflict
		}
		c.AcceptLocale, c.AcceptLocaleAt, wrote = lang, &now, true
		return nil
	})
	return err == nil && wrote
}

// acceptLocaleFresh: nothing to write (an explicit mail_locale, the same
// language, or a write less than a day ago).
func acceptLocaleFresh(c *store.Customer, lang string, now time.Time) bool {
	if c == nil || c.MailLocale != "" || c.AcceptLocale == lang {
		return true
	}
	return c.AcceptLocaleAt != nil && now.Sub(*c.AcceptLocaleAt) < 24*time.Hour
}
