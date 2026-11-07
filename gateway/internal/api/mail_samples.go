package api

import (
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// mailSample is one customer mail with realistic sample data, for the
// admin's previews and the preview gallery (cmd/mailpreview).
type mailSample struct {
	ID    string // "E1 lifelike"
	Group string // runs, receipts, pay links, plans, balance, refunds, deletion, security, other
	// Where: "web", "app" or "both" (who can get it).
	Where string
	Mail  customerMail
}

// MailSample is mailSample for other packages: its id, group, where it
// goes, and the rendered subject, text and HTML in lang.
type MailSample struct {
	ID, Group, Where    string
	Kind                string
	Subject, Text, HTML string
	SubjectBody         string // the subject without the brand suffix
	Lang                string
}

// MailSamples renders every sample in lang (site: the web's origin).
func MailSamples(site, lang string) []MailSample {
	var out []MailSample
	for _, p := range mailSamples(site) {
		l := p.Mail.layout(lang)
		out = append(out, MailSample{ID: p.ID, Group: p.Group, Where: p.Where, Kind: p.Mail.Kind, Subject: l.FullSubject(),
			SubjectBody: l.Subject, Text: l.Text(), HTML: l.HTML(), Lang: lang})
	}
	// the two mails outside customerMail: the file notice and the reset
	now := time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC)
	a, b := now.Add(14*24*time.Hour), now.Add(16*24*time.Hour)
	fk := fileNoticeLayout([]*store.Project{{ID: "b959de66a207", Name: "Kyoto walk", FilesDeleteAt: &b}, {ID: "p1", FilesDeleteAt: &a}},
		14*24*time.Hour, now, site, 90*24*time.Hour, lang)
	fk.Lang = lang
	reset := mail.ResetLayout(lang, site+"/reset-password?oob=sample")
	for _, x := range []struct {
		id, group, kind string
		l               mail.Layout
	}{{"FK1 file notice", "other", "FK1", fk}, {"Password reset", "security", "RESET", reset}} {
		out = append(out, MailSample{ID: x.id, Group: x.group, Where: "both", Kind: x.kind, Subject: x.l.FullSubject(),
			SubjectBody: x.l.Subject, Text: x.l.Text(), HTML: x.l.HTML(), Lang: lang})
	}
	return out
}

func mailSamples(site string) []mailSample {
	jpy := &store.Presentment{AmountMinor: 495, Currency: "jpy"}
	life := runInfo{Name: "IMG_1202", Lifelike: true, Res: "1080p", FPS: "30 fps", Minutes: 1, Offer: "Launch offer −25%"}
	life4k := runInfo{Name: "Kyoto walk", Lifelike: true, Res: "4K", FPS: "60 fps", Minutes: 3}
	classic := runInfo{Name: "Beach day", Lifelike: false, Res: "1080p", FPS: "30 fps", Minutes: 2}
	when := time.Date(2026, 11, 9, 14, 5, 0, 0, time.UTC)
	next := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	keep := time.Date(2027, 2, 6, 0, 0, 0, 0, time.UTC)
	project := site + "/projects/b959de66a207"
	billing := site + "/billing"
	pay := site + "/pay/k7Q2mX9vTq3LwZr8"
	ref := "CASE-0042"
	pending := retryNext{Pending: true, At: &next}
	what := caseWhat{Labels: []string{"Kyoto walk · Lifelike 3D"}}
	return []mailSample{
		{"E1 lifelike", "runs", "web", orderConfirmationMail(life, amountText(jpy, 319), project, true)},
		{"E1 classic", "runs", "web", orderConfirmationMail(classic, "$4.50", project, true)},
		{"E1 business", "runs", "web", orderConfirmationMail(life4k, "$27.00", project, false)},
		{"RD lifelike", "runs", "web", readyMail([]readyItem{{Run: life, Paid: readyPaid{Amount: amountText(jpy, 319)}}}, &keep, project)},
		{"RD classic", "runs", "web", readyMail([]readyItem{{Run: classic, Paid: readyPaid{Source: "balance"}}}, &keep, project)},
		{"RD batch", "runs", "web", readyMail([]readyItem{
			{Run: life4k, Paid: readyPaid{Source: "plan_credit"}},
			{Run: life, Paid: readyPaid{Amount: amountText(jpy, 319)}},
			{Run: classic, Paid: readyPaid{Amount: "$4.50"}},
			{Run: runInfo{Name: "Fireworks", Lifelike: true, Res: "4K", Minutes: 2}, Paid: readyPaid{Source: "balance"}},
		}, &keep, site+"/projects")},
		{"E20 receipt", "receipts", "web", receiptMail("$12.75", []receiptLine{{Run: life4k, Amount: "$8.25"}, {Run: classic, Amount: "$4.50"}}, billing)},
		{"E20 receipt (5)", "receipts", "web", receiptMail("$22.50", []receiptLine{{Run: life4k, Amount: "$8.25"}, {Run: life, Amount: "$3.19"},
			{Run: classic, Amount: "$4.50"}, {Run: life, Amount: "$3.19"}, {Run: classic, Amount: "$3.37"}}, billing)},
		{"E13 top-up", "balance", "web", topupMail(false, amountText(&store.Presentment{AmountMinor: 3090, Currency: "jpy"}, 2000), "$32.50", billing)},
		{"E13 auto-reload", "balance", "web", topupMail(true, "$20.00", "$24.10", billing)},
		{"E14 low", "balance", "web", lowBalanceMail("$2.40", site+"/billing?add=1")},
		{"E16 expiring", "balance", "web", balanceExpiringMail("30", "$12.60", keep, site+"/billing?add=1")},
		{"E17 expired", "balance", "web", balanceExpiredMail(billing)},
		{"E15 auto-reload failed", "pay links", "web", reloadFailedMail("$20.00", "Your bank declined the payment: not enough funds.", pending, pay)},
		{"E2 group failed", "pay links", "web", webGroupFailedMail("E2", "$9.75", "Your payment method has expired.", pending, pay)},
		{"E3 group still due", "pay links", "web", webGroupFailedMail("E3", "$9.75", "Your bank needs you to confirm this payment.", retryNext{Auth: true}, pay)},
		{"E2 owed", "pay links", "app", owedMail("E2", "$9.75", site+"/billing?pay=1")},
		{"E3 owed", "pay links", "both", owedMail("E3", "$9.75", site+"/billing?pay=1")},
		{"E4 owed", "pay links", "both", owedMail("E4", "$9.75", site+"/billing?pay=1")},
		{"E5 downloads back", "pay links", "both", downloadsBackMail("$9.75", site)},
		{"E7 hand-off", "pay links", "web", handoffMail("$4.50", site+"/p/K7Q2-MX9V")},
		{"SU1 plan change", "plans", "web", stepUpFailedMail("$31.00", "Business", false, pay)},
		{"RN1 renewal failed", "plans", "web", renewalFailedMail("Business", formatMinor(4980, "jpy"), &next, pay)},
		{"RN1 last try", "plans", "web", renewalFailedMail("Pro", "$9.99", nil, pay)},
		{"RN2 confirm renewal", "plans", "web", renewalConfirmMail("Business", "$29.00", pay)},
		{"E18 plan started", "plans", "web", planStartedMail("business", "", site)},
		{"E18 plan + App Store Pro", "plans", "web", planStartedMail("business", appleSubscriptionsURL, site)},
		{"E19 App Store Pro", "plans", "web", appProReminderMail("business", appleSubscriptionsURL)},
		{"E6 refunded", "refunds", "both", refundedMail("card", amountText(jpy, 319), what, ref, billing)},
		{"E6 to balance", "refunds", "both", refundedMail("balance", "$6.75", what, ref, billing)},
		{"E6 waived", "refunds", "both", refundedMail("waive", "$1.00", caseWhat{Labels: []string{"Kyoto walk · Lifelike 3D"}}, ref, billing)},
		{"E6 other way", "refunds", "both", refundedMail("out_of_band", "$6.75", what, ref, billing)},
		{"E9 under review", "refunds", "both", refundUnderReviewMail(what, ref, billing)},
		{"E10 denied", "refunds", "both", refundDeniedMail(denyTemplates["delivered"], ref, billing)},
		{"E11 question", "refunds", "both", refundQuestionMail("Which part of the video looked wrong?", ref)},
		{"E12 refund failed", "refunds", "both", refundFailedMail("$6.75", "CASE-0057")},
		{"DL1 deletion scheduled", "deletion", "both", deletionScheduledMail(when, site, 1260)},
		{"DL2 deletion cancelled", "deletion", "both", deletionCancelledMail(site)},
		{"DL3 deletion dues", "deletion", "both", duesFailedMail("$4.50", "Your bank declined the payment.", pending, pay)},
		{"S1 passkey added", "security", "web", passkeyMail(true, "iCloud Keychain", "iPhone", when, site+"/account")},
		{"S2 passkey removed", "security", "web", passkeyMail(false, "YubiKey 5C", "", when, site+"/account")},
		{"EM1 main email", "security", "both", mainEmailChangedMail("new.address@example.com", site+"/account")},
		{"CG credit", "other", "both", creditGrantMail("$10.00", "Thanks for the detailed bug report!", &keep, site)},
	}
}
