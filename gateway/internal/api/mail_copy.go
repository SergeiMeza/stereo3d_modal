package api

import (
	"context"
	"math"
	"strconv"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The customer mails' content (owner 2026-11-08): one branded layout
// (mail.Layout), the copy in internal/mail/copy/<lang>.json, rendered in
// the account's language when the mail is sent. Builders take amounts
// already written ("¥618 (US$3.75)", "$3.75"): figures don't change with
// the language.

// t is mail.T without arguments.
func t(lang, key string) string { return mail.T(lang, key, nil) }

// page starts a layout with the subject and title under prefix.
func page(lang, prefix string, args mail.Args) mail.Layout {
	return mail.Layout{Lang: lang, Subject: mail.T(lang, prefix+".subject", args), Title: mail.T(lang, prefix+".title", args)}
}

// declineKeys maps customerMessage's English sentences to their keys, so a
// stored decline reason reads in the mail's language.
var declineKeys = func() map[string]string {
	out := map[string]string{}
	for _, k := range mail.Keys() {
		if strings.HasPrefix(k, "decline.") {
			out[mail.Raw("en", k)] = k
		}
	}
	return out
}()

// declineText is a stored decline sentence in lang (as stored when it
// isn't one of ours).
func declineText(lang, msg string) string {
	if k, ok := declineKeys[strings.TrimSpace(msg)]; ok {
		return t(lang, k)
	}
	return strings.TrimSpace(msg)
}

// joinSentences joins non-empty sentences with a space (no space in CJK).
func joinSentences(lang string, parts ...string) string {
	sep := " "
	switch lang {
	case "ja", "zh-Hans", "zh-Hant":
		sep = ""
	}
	var keep []string
	for _, p := range parts {
		if p = strings.TrimSpace(p); p != "" {
			keep = append(keep, p)
		}
	}
	return strings.Join(keep, sep)
}

// amountText: "¥1,648 (US$10.00)" with a presentment, else "$10.00".
func amountText(p *store.Presentment, usdCents int64) string { return localAndUSD(p, usdCents) }

// ------------------------------------------------------------- runs

// runInfo is one 3D video as mails show it: its project's name, Lifelike
// 3D or Classic 3D, and its spec ("1080p · 30 fps · 3 min").
type runInfo struct {
	Name     string
	Lifelike bool
	Res      string
	FPS      string
	Minutes  int64
	Seconds  int64
	Offer    string // the launch offer named on the payment (as configured)
}

// product is "Lifelike 3D" or "Classic 3D" (product names: never
// translated).
func (r runInfo) product() string {
	if r.Lifelike {
		return "Lifelike 3D"
	}
	return "Classic 3D"
}

// spec is the run's spec in lang: "1080p · 30 fps · 3 min".
func (r runInfo) spec(lang string) string {
	var parts []string
	for _, p := range []string{r.Res, r.FPS} {
		if p != "" {
			parts = append(parts, p)
		}
	}
	switch {
	case r.Minutes > 0:
		parts = append(parts, mail.T(lang, "unit.min", mail.Args{"n": istr(int(r.Minutes))}))
	case r.Seconds > 0:
		parts = append(parts, mail.T(lang, "unit.sec", mail.Args{"n": istr(int(r.Seconds))}))
	}
	return strings.Join(parts, " · ")
}

// name is the project's name, or "Untitled project".
func (r runInfo) name(lang string) string {
	if strings.TrimSpace(r.Name) == "" {
		return t(lang, "fk1.untitled")
	}
	return r.Name
}

// rows are the run's details: its name, then the product (a Lifelike 3D
// pill, or "Classic 3D") with the spec.
func (r runInfo) rows(lang string) []mail.Row {
	made := mail.Row{Label: t(lang, "label.made"), Value: r.spec(lang)}
	if r.Lifelike {
		made.Pill = r.product()
	} else {
		made.Value = joinDot(r.product(), made.Value)
	}
	rows := []mail.Row{{Label: t(lang, lifelikeKey(r.Lifelike, "label.video")), Value: r.name(lang)}, made}
	if r.Offer != "" {
		rows = append(rows, mail.Row{Label: t(lang, "label.offer"), Value: r.Offer})
	}
	return rows
}

func joinDot(a, b string) string {
	switch {
	case a == "":
		return b
	case b == "":
		return a
	}
	return a + " · " + b
}

// lifelikeKey picks the Lifelike variant of a key when there is one.
func lifelikeKey(lifelike bool, key string) string {
	if lifelike {
		return key + "Lifelike"
	}
	return key
}

// orderConfirmationMail is E1, the receipt of a 3D video paid as it
// starts; consumer (no Business or Studio plan) adds the express-consent
// line (the durable-medium confirmation, UK CCR / EU CRD).
func orderConfirmationMail(run runInfo, amount, link string, consumer bool) customerMail {
	return customerMail{Kind: "E1", Receipt: true, Render: func(lang string) mail.Layout {
		l := mail.Layout{Lang: lang, Subject: t(lang, lifelikeKey(run.Lifelike, "e1.subject")), Title: t(lang, lifelikeKey(run.Lifelike, "e1.title")),
			Lifelike: run.Lifelike}
		l.Preheader = t(lang, "e1.preheader")
		l.Paras = []string{t(lang, lifelikeKey(run.Lifelike, "e1.body"))}
		l.Rows = append(run.rows(lang), mail.Row{Label: t(lang, "label.paid"), Value: amount, Total: true})
		l.After = []string{t(lang, "e1.reassure")}
		if consumer {
			l.Notes = append(l.Notes, t(lang, lifelikeKey(run.Lifelike, "e1.consent")))
		}
		l.Button, l.ButtonURL = t(lang, "e1.button"), link
		l.Reason = t(lang, "common.reason.purchase")
		return l
	}}
}

// receiptLine is one paid 3D video on a receipt.
type receiptLine struct {
	Run    runInfo
	Amount string
}

// receiptMail is E20: what was charged (USD: an off-session charge is
// never presented locally), up to three 3D videos, where the invoice is.
func receiptMail(total string, lines []receiptLine, link string) customerMail {
	return customerMail{Kind: "E20", Receipt: true, Render: func(lang string) mail.Layout {
		l := page(lang, "e20", nil)
		l.Paras = []string{t(lang, "e20.body")}
		shown := lines
		if len(lines) > receiptRunsShown {
			shown = lines[:receiptRunsShown]
		}
		for _, r := range shown {
			l.Lifelike = l.Lifelike || r.Run.Lifelike
			row := mail.Row{Label: r.Run.name(lang), Value: r.Amount}
			if r.Run.Lifelike {
				row.Pill = r.Run.product()
			} else {
				row.Label = joinDot(row.Label, r.Run.product())
			}
			l.Rows = append(l.Rows, row)
		}
		if n := len(lines) - len(shown); n > 0 {
			l.Rows = append(l.Rows, mail.Row{Label: mail.T(lang, "common.andMore", mail.Args{"count": istr(n)})})
		}
		l.Rows = append(l.Rows, mail.Row{Label: t(lang, "label.total"), Value: total, Total: true})
		l.Notes = []string{t(lang, "common.usdNote"), t(lang, "common.invoiceSoon")}
		l.Button, l.ButtonURL = t(lang, "common.openBilling"), link
		l.Reason = t(lang, "common.reason.purchase")
		return l
	}}
}

// --------------------------------------------------------- balance

// topupMail is E13: funds added (auto: by auto-reload, charged in USD).
func topupMail(auto bool, added, balanceNow, link string) customerMail {
	return customerMail{Kind: "E13", Receipt: true, Render: func(lang string) mail.Layout {
		l := page(lang, "e13", nil)
		body := mail.T(lang, "e13.body", mail.Args{"amount": added})
		if auto {
			l.Subject, l.Title = t(lang, "e13.subjectAuto"), t(lang, "e13.titleAuto")
			body = mail.T(lang, "e13.bodyAuto", mail.Args{"amount": added})
			l.Notes = append(l.Notes, t(lang, "common.usdNote"))
		}
		l.Paras = []string{body}
		l.Rows = []mail.Row{{Label: t(lang, "label.added"), Value: added}}
		if balanceNow != "" {
			l.Rows = append(l.Rows, mail.Row{Label: t(lang, "label.balanceNow"), Value: balanceNow, Total: true})
		}
		l.Notes = append(l.Notes, t(lang, "common.invoiceSoon"))
		l.Button, l.ButtonURL = t(lang, "common.openBilling"), link
		l.Reason = t(lang, "common.reason.purchase")
		return l
	}}
}

func lowBalanceMail(amount, link string) customerMail {
	return customerMail{Kind: "E14", Render: func(lang string) mail.Layout {
		l := page(lang, "e14", nil)
		l.Paras = []string{mail.T(lang, "e14.body", mail.Args{"amount": amount})}
		l.Button, l.ButtonURL = t(lang, "common.addFunds"), link
		l.Reason = t(lang, "common.reason.account")
		return l
	}}
}

func balanceExpiringMail(days, amount string, expires time.Time, link string) customerMail {
	return customerMail{Kind: "E16", Render: func(lang string) mail.Layout {
		l := page(lang, "e16", nil)
		l.Subject = t(lang, "e16.subject"+days)
		l.Paras = []string{mail.T(lang, "e16.body", mail.Args{"amount": amount, "date": mail.FormatDate(lang, expires)})}
		l.Button, l.ButtonURL = t(lang, "common.addFunds"), link
		l.Reason = t(lang, "common.reason.account")
		return l
	}}
}

func balanceExpiredMail(link string) customerMail {
	return customerMail{Kind: "E17", Render: func(lang string) mail.Layout {
		l := page(lang, "e17", nil)
		l.Paras = []string{t(lang, "e17.body"), t(lang, "common.replyQuestions")}
		l.Button, l.ButtonURL = t(lang, "common.openBilling"), link
		l.Reason = t(lang, "common.reason.account")
		return l
	}}
}

// retryNext is what happens after a failed off-session charge.
type retryNext struct {
	Pending bool
	Auth    bool
	Config  bool
	At      *time.Time
}

func nextOf(r *store.OffSessionRetry) retryNext {
	if r == nil {
		return retryNext{}
	}
	return retryNext{Pending: r.State == store.RetryPending, Auth: r.Reason == retryAuth, Config: r.Reason == retryConfig, At: r.NextAttemptAt}
}

func dayMonth(lang string, at *time.Time) string {
	if at == nil {
		return ""
	}
	return mail.FormatDayMonth(lang, *at)
}

func payButton(lang, amount string, auth bool) string {
	if auth {
		return mail.T(lang, "common.confirmAndPay", mail.Args{"amount": amount})
	}
	return mail.T(lang, "common.pay", mail.Args{"amount": amount})
}

// reloadFailedMail is E15: the reload didn't go through, what happens
// next, the pay link.
func reloadFailedMail(amount, decline string, n retryNext, link string) customerMail {
	return customerMail{Kind: "E15", Render: func(lang string) mail.Layout {
		l := page(lang, "e15", nil)
		next := t(lang, "e15.final")
		switch {
		case n.Pending:
			next = mail.T(lang, "e15.pending", mail.Args{"date": dayMonth(lang, n.At)})
		case n.Auth:
			next = t(lang, "e15.auth")
		}
		l.Paras = []string{joinSentences(lang, mail.T(lang, "e15.body", mail.Args{"amount": amount}), declineText(lang, decline)), next}
		l.Button, l.ButtonURL = payButton(lang, amount, n.Auth), link
		l.Notes = []string{t(lang, "common.usdNote")}
		l.Reason = t(lang, "common.reason.payment")
		return l
	}}
}

// ------------------------------------------------------ owed (E2-E5)

// owedMail is E2, E3 or E4 for money owed for 3D videos (mailOwed: the
// app's groups and a web group's 7-day reminder).
func owedMail(kind, amount, link string) customerMail {
	k := strings.ToLower(kind)
	return customerMail{Kind: kind, Render: func(lang string) mail.Layout {
		l := page(lang, "owed."+k, nil)
		l.Paras = []string{mail.T(lang, "owed."+k+".body", mail.Args{"amount": amount}), t(lang, "owed."+k+".next")}
		l.Button, l.ButtonURL = payButton(lang, amount, false), link
		l.Reason = t(lang, "common.reason.payment")
		return l
	}}
}

// webGroupFailedMail is E2 (first failure) or E3 (a retry failed) for a
// web group: what was declined and why, what happens next, the pay link.
// USD: an off-session charge is never presented locally.
func webGroupFailedMail(kind, amount, decline string, n retryNext, link string) customerMail {
	k := strings.ToLower(kind)
	return customerMail{Kind: kind, Render: func(lang string) mail.Layout {
		l := page(lang, "owed."+k, nil)
		next := t(lang, "owed.final")
		switch {
		case n.Pending:
			next = mail.T(lang, "owed.pending", mail.Args{"date": dayMonth(lang, n.At)})
		case n.Auth:
			next = t(lang, "owed.auth")
		}
		l.Paras = []string{joinSentences(lang, mail.T(lang, "owed."+k+".body", mail.Args{"amount": amount}), declineText(lang, decline)), next}
		l.Button, l.ButtonURL = payButton(lang, amount, n.Auth && !n.Pending), link
		l.Notes = []string{t(lang, "common.usdNote")}
		l.Reason = t(lang, "common.reason.payment")
		return l
	}}
}

// downloadsBackMail is E5: the debt was paid.
func downloadsBackMail(amount, link string) customerMail {
	return customerMail{Kind: "E5", Render: func(lang string) mail.Layout {
		l := page(lang, "e5", nil)
		l.Paras = []string{mail.T(lang, "e5.body", mail.Args{"amount": amount})}
		l.Button, l.ButtonURL = t(lang, "common.openApp"), link
		l.Reason = t(lang, "common.reason.purchase")
		return l
	}}
}

// handoffMail is E7: the hand-off link, mailed on request.
func handoffMail(amount, link string) customerMail {
	return customerMail{Kind: "E7", Render: func(lang string) mail.Layout {
		l := page(lang, "e7", nil)
		l.Paras = []string{mail.T(lang, "e7.body", mail.Args{"amount": amount})}
		l.Button, l.ButtonURL = payButton(lang, amount, false), link
		l.Reason = t(lang, "common.reason.payment")
		return l
	}}
}

// ------------------------------------------------------------ plans

// stepUpFailedMail is SU1: an upgrade's charge failed (auth: the bank
// wants a confirmation).
func stepUpFailedMail(amount, plan string, auth bool, link string) customerMail {
	return customerMail{Kind: "SU1", Render: func(lang string) mail.Layout {
		l := page(lang, "su1", nil)
		why := t(lang, "decline.declined")
		if auth {
			why = t(lang, "decline.auth")
		}
		l.Paras = []string{joinSentences(lang, mail.T(lang, "su1.body", mail.Args{"amount": amount, "plan": plan}), why), t(lang, "su1.next")}
		l.Button, l.ButtonURL = payButton(lang, amount, false), link
		l.Reason = t(lang, "common.reason.payment")
		return l
	}}
}

// renewalFailedMail is RN1; next nil = Stripe won't try again.
func renewalFailedMail(plan, amount string, next *time.Time, link string) customerMail {
	return customerMail{Kind: "RN1", Render: func(lang string) mail.Layout {
		a := mail.Args{"plan": plan, "amount": amount}
		l := page(lang, "rn1", a)
		after := t(lang, "rn1.final")
		if next != nil {
			after = mail.T(lang, "rn1.pending", mail.Args{"date": mail.FormatDayMonth(lang, *next)})
		}
		l.Paras = []string{mail.T(lang, "rn1.body", a), after}
		l.Button, l.ButtonURL = payButton(lang, amount, false), link
		l.Reason = t(lang, "common.reason.payment")
		return l
	}}
}

// renewalConfirmMail is RN2: the bank wants the renewal confirmed.
func renewalConfirmMail(plan, amount, link string) customerMail {
	return customerMail{Kind: "RN2", Render: func(lang string) mail.Layout {
		a := mail.Args{"plan": plan, "amount": amount}
		l := page(lang, "rn2", a)
		l.Paras = []string{mail.T(lang, "rn2.body", a)}
		l.Button, l.ButtonURL = payButton(lang, amount, true), link
		l.Reason = t(lang, "common.reason.payment")
		return l
	}}
}

// planStartedMail is E18; appLink set = an App Store Pro to cancel.
func planStartedMail(tier, appLink, site string) customerMail {
	name := tierLabel(tier)
	return customerMail{Kind: "E18", Render: func(lang string) mail.Layout {
		a := mail.Args{"plan": name}
		l := page(lang, "e18", a)
		body := mail.T(lang, "e18.body", a)
		if tier == pricing.TierPro { // Pro has no usage credit (only free previews)
			body = t(lang, "e18.bodyPro")
		}
		l.Paras = []string{body}
		if appLink != "" {
			l.Paras = append(l.Paras, mail.T(lang, "e18.appStore", a))
			l.LinkText, l.LinkURL = t(lang, "e18.appStoreLink"), appLink
		}
		l.Button, l.ButtonURL = t(lang, "common.openApp"), site
		l.Reason = t(lang, "common.reason.purchase")
		return l
	}}
}

// appProReminderMail is E19: a plan runs while an App Store Pro renews.
func appProReminderMail(tier, link string) customerMail {
	name := tierLabel(tier)
	return customerMail{Kind: "E19", Render: func(lang string) mail.Layout {
		a := mail.Args{"plan": name}
		l := page(lang, "e19", a)
		l.Paras = []string{mail.T(lang, "e19.body", a), mail.T(lang, "e18.appStore", a)}
		l.Button, l.ButtonURL = t(lang, "e18.appStoreLink"), link
		l.Reason = t(lang, "common.reason.account")
		return l
	}}
}

// --------------------------------------------------------- deletion

// deletionDate is the day a deletion runs (English, for messages).
func deletionDate(t time.Time) string { return t.UTC().Format("2 January 2006") }

// deletionScheduledMail is DL1; lostCents > 0 (the unspent cash the
// deletion forfeits, refund policy 2026-11-08) adds the balance line and
// nothing else: no refund is promised.
func deletionScheduledMail(after time.Time, site string, lostCents int64) customerMail {
	site = strings.TrimRight(site, "/")
	return customerMail{Kind: "DL1", OwnAddress: true, Render: func(lang string) mail.Layout {
		day := mail.FormatDate(lang, after)
		l := page(lang, "dl1", mail.Args{"date": mail.FormatDayMonth(lang, after)}) // two days ahead: no year
		l.Paras = []string{mail.T(lang, "dl1.body", mail.Args{"date": day, "time": after.UTC().Format("15:04")}), t(lang, "dl1.paused")}
		if lostCents > 0 {
			l.Paras = append(l.Paras, mail.T(lang, "dl1.balanceLost", mail.Args{"amount": money(lostCents)}))
		}
		l.Paras = append(l.Paras, t(lang, "dl1.keep"))
		l.Button, l.ButtonURL = t(lang, "dl1.button"), site+"/account?deletion=keep"
		l.Notes = []string{t(lang, "dl1.notYou")}
		l.Reason = t(lang, "common.reason.account")
		return l
	}}
}

func deletionCancelledMail(site string) customerMail {
	return customerMail{Kind: "DL2", OwnAddress: true, Render: func(lang string) mail.Layout {
		l := page(lang, "dl2", nil)
		l.Paras = []string{t(lang, "dl2.body")}
		l.Button, l.ButtonURL = t(lang, "common.openApp"), strings.TrimRight(site, "/")+"/"
		l.Reason = t(lang, "common.reason.account")
		return l
	}}
}

// duesFailedMail is DL3: the deletion waits for dues the sweep couldn't
// collect.
func duesFailedMail(amount, decline string, n retryNext, link string) customerMail {
	return customerMail{Kind: "DL3", OwnAddress: true, Render: func(lang string) mail.Layout {
		l := page(lang, "dl3", nil)
		next := t(lang, "dl3.final")
		switch {
		case n.Config:
			next = t(lang, "dl3.config")
		case n.Pending:
			next = mail.T(lang, "dl3.pending", mail.Args{"date": dayMonth(lang, n.At)})
		}
		l.Paras = []string{joinSentences(lang, mail.T(lang, "dl3.body", mail.Args{"amount": amount}), declineText(lang, decline)), next}
		l.Button, l.ButtonURL = payButton(lang, amount, n.Auth), link
		l.Notes = []string{t(lang, "common.usdNote")}
		l.Reason = t(lang, "common.reason.account")
		return l
	}}
}

// ---------------------------------------------------------- refunds

// caseWhat names what a refund is about: the 3D videos' labels, else
// the balance or the payment.
type caseWhat struct {
	Labels   []string
	More     int
	Fallback string // "balance" | "payment"
}

func (w caseWhat) text(lang string) string {
	if len(w.Labels) == 0 {
		if w.Fallback == "balance" {
			return t(lang, "e6.whatBalance")
		}
		return t(lang, "e6.whatPayment")
	}
	s := strings.Join(w.Labels, ", ")
	if w.More > 0 {
		s += ", " + mail.T(lang, "common.andMore", mail.Args{"count": istr(w.More)})
	}
	return s
}

func refRow(lang, ref string) []mail.Row {
	return []mail.Row{{Label: t(lang, "label.reference"), Value: store.CaseRef(ref)}}
}

// refundedMail is E6: to the payment method (card), to the balance,
// another way (out_of_band) or a charge removed (waive).
func refundedMail(how, amount string, what caseWhat, ref, link string) customerMail {
	return customerMail{Kind: "E6", Receipt: true, Render: func(lang string) mail.Layout {
		a := mail.Args{"amount": amount, "what": what.text(lang)}
		l := page(lang, "e6", a)
		switch how {
		case "balance":
			l.Subject, l.Title = mail.T(lang, "e6.subjectBalance", a), t(lang, "e6.titleBalance")
			l.Paras = []string{mail.T(lang, "e6.bodyBalance", a)}
		case "waive":
			l.Subject, l.Title = mail.T(lang, "e6.subjectWaive", a), t(lang, "e6.titleWaive")
			l.Paras = []string{mail.T(lang, "e6.bodyWaive", a)}
		case "out_of_band":
			l.Paras = []string{mail.T(lang, "e6.bodyOther", a)}
		default:
			l.Paras = []string{mail.T(lang, "e6.body", a), t(lang, "e6.timing")}
		}
		l.Rows = append([]mail.Row{{Label: t(lang, "label.amount"), Value: amount, Total: true}}, refRow(lang, ref)...)
		l.Button, l.ButtonURL = t(lang, "common.viewPurchases"), link
		l.Reason = t(lang, "common.reason.refund")
		return l
	}}
}

func refundUnderReviewMail(what caseWhat, ref, link string) customerMail {
	return customerMail{Kind: "E9", Render: func(lang string) mail.Layout {
		l := page(lang, "e9", nil)
		l.Paras = []string{mail.T(lang, "e9.body", mail.Args{"what": what.text(lang)})}
		l.Rows = refRow(lang, ref)
		l.Button, l.ButtonURL = t(lang, "common.viewPurchases"), link
		l.Reason = t(lang, "common.reason.refund")
		return l
	}}
}

// denyTemplates are E10's texts (A2 Deny), in English for the admin;
// the mail sends them in the account's language.
var denyTemplates = map[string]string{
	"delivered":     mail.Raw("en", "e10.delivered"),
	"outside_terms": mail.Raw("en", "e10.outsideTerms"),
}

var denyKeys = map[string]string{denyTemplates["delivered"]: "e10.delivered", denyTemplates["outside_terms"]: "e10.outsideTerms"}

// refundDeniedMail is E10; text is a deny template or the owner's own
// words (sent as written).
func refundDeniedMail(text, ref, link string) customerMail {
	return customerMail{Kind: "E10", Render: func(lang string) mail.Layout {
		l := page(lang, "e10", nil)
		body := text
		if k, ok := denyKeys[strings.TrimSpace(text)]; ok {
			body = t(lang, k)
		}
		l.Paras = []string{body, t(lang, "common.replyQuestions")}
		l.Rows = refRow(lang, ref)
		l.Button, l.ButtonURL = t(lang, "common.viewPurchases"), link
		l.Reason = t(lang, "common.reason.refund")
		return l
	}}
}

// refundQuestionMail is E11: the owner's question, as written.
func refundQuestionMail(question, ref string) customerMail {
	return customerMail{Kind: "E11", Render: func(lang string) mail.Layout {
		l := page(lang, "e11", nil)
		l.Paras = []string{question, t(lang, "e11.reply")}
		l.Rows = refRow(lang, ref)
		l.Reason = t(lang, "common.reason.refund")
		return l
	}}
}

func refundFailedMail(amount, ref string) customerMail {
	return customerMail{Kind: "E12", Render: func(lang string) mail.Layout {
		l := page(lang, "e12", nil)
		l.Paras = []string{mail.T(lang, "e12.body", mail.Args{"amount": amount})}
		l.Rows = append([]mail.Row{{Label: t(lang, "label.amount"), Value: amount}}, refRow(lang, ref)...)
		l.Reason = t(lang, "common.reason.refund")
		return l
	}}
}

// -------------------------------------------------- account, security

// passkeyMail is S1 (added) or S2 (removed).
func passkeyMail(added bool, name, device string, at time.Time, link string) customerMail {
	kind, prefix := "S1", "s1"
	if !added {
		kind, prefix = "S2", "s2"
	}
	return customerMail{Kind: kind, Render: func(lang string) mail.Layout {
		l := page(lang, prefix, nil)
		l.Paras = []string{t(lang, prefix+".body"), t(lang, "s.ok"), t(lang, "s.notYou")}
		pk := strings.TrimSpace(name)
		if d := strings.TrimSpace(device); d != "" && d != pk {
			pk += " (" + d + ")"
		}
		l.Rows = []mail.Row{{Label: t(lang, "label.passkey"), Value: pk},
			{Label: t(lang, "label.when"), Value: mail.FormatDate(lang, at) + " " + at.UTC().Format("15:04") + " UTC"}}
		l.Button, l.ButtonURL = t(lang, "s.button"), link
		l.Reason = t(lang, "common.reason.security")
		return l
	}}
}

// mainEmailChangedMail goes to the old main address (masked new one).
func mainEmailChangedMail(newMain, link string) customerMail {
	return customerMail{Kind: "EM1", Render: func(lang string) mail.Layout {
		l := page(lang, "em1", nil)
		l.Paras = []string{mail.T(lang, "em1.body", mail.Args{"email": maskEmail(newMain)}), t(lang, "em1.notYou")}
		l.Button, l.ButtonURL = t(lang, "em1.button"), link
		l.Reason = t(lang, "common.reason.security")
		return l
	}}
}

// creditGrantMail is CG: credit the owner granted, with their message.
func creditGrantMail(amount, message string, expires *time.Time, link string) customerMail {
	return customerMail{Kind: "CG", OwnAddress: true, Render: func(lang string) mail.Layout {
		a := mail.Args{"amount": amount}
		l := page(lang, "cg", a)
		l.Paras = []string{mail.T(lang, "cg.body", a)}
		if m := strings.TrimSpace(message); m != "" {
			l.Paras = append(l.Paras, m)
		}
		if expires != nil {
			l.Paras = append(l.Paras, mail.T(lang, "cg.expires", mail.Args{"date": mail.FormatDate(lang, *expires)}))
		}
		l.Button, l.ButtonURL = t(lang, "cg.button"), link
		l.Reason = t(lang, "common.reason.account")
		return l
	}}
}

func istr(n int) string { return strconv.Itoa(n) }

// runMailInfo reads a run's mail line (its project's name: one read).
func (s *Service) runMailInfo(ctx context.Context, c *store.Conversion) runInfo {
	r := runInfo{Lifelike: c.Method == store.MethodLifelike}
	var p *store.Project
	if c.ProjectID != "" {
		if got, err := s.Store.GetProject(ctx, c.ProjectID); err == nil {
			p = got
			r.Name = strings.TrimSpace(got.Name)
		}
	}
	r.Res = resolutionLabel(c, p)
	fps := c.Params.TargetFPS
	if fps <= 0 {
		fps = c.Source.FPS
	}
	r.FPS = fpsLabel(fps)
	if m := billedMinutesOf(c); m > 0 {
		r.Minutes = m
	} else if secs := runSeconds(c); secs > 0 {
		r.Seconds = int64(math.Round(secs))
	}
	_, r.Offer = campaignLine(c)
	return r
}
