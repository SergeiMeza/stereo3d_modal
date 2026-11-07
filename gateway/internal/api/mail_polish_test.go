package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// sentMail is one mail the local Resend stand-in received.
type sentMail struct{ To, Subject, Text, HTML string }

// mailCapture sends the service's mails to a local Resend stand-in (never
// the real one) and keeps them.
func mailCapture(t *testing.T, s *Service) func() []sentMail {
	t.Helper()
	var mu sync.Mutex
	var got []sentMail
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		var m struct {
			To      []string `json:"to"`
			Subject string   `json:"subject"`
			Text    string   `json:"text"`
			HTML    string   `json:"html"`
		}
		_ = json.Unmarshal(raw, &m)
		mu.Lock()
		got = append(got, sentMail{To: strings.Join(m.To, ","), Subject: m.Subject, Text: m.Text, HTML: m.HTML})
		mu.Unlock()
		_, _ = w.Write([]byte(`{"id":"m1"}`))
	}))
	t.Cleanup(srv.Close)
	s.Mail = mail.NewResend("re_test", "").WithEndpoint(srv.URL)
	s.Cfg.Env = "prod" // to the account's address, no test banner
	s.Cfg.SiteURL = "https://site.example"
	return func() []sentMail {
		mu.Lock()
		defer mu.Unlock()
		return append([]sentMail(nil), got...)
	}
}

// banned in customer copy (owner rules): vendors, routing, "subscription"
// (but Apple's literal Settings path), "tier", "case" (but reference ids),
// "run" (a "3D video"), "card" (a "payment method"), and refund promises
// the policy dropped.
var (
	bannedCopy  = regexp.MustCompile(`(?i)\b(stripe|resend|modal|google|firebase|relay|proxy|hong kong|subscriptions?|tiers?|case|runs?|cards?|14-day|refundable|refunded within)\b`)
	allowedCopy = regexp.MustCompile(`CASE-\d+|Settings → \[your name\] → Subscriptions|https://apps\.apple\.com/account/subscriptions`)
)

// Every mail renders in every language (English where a language has no
// copy yet): the subject names the app, its own part is at most 45
// characters, no placeholder is left, a plain-text part is there, and the
// copy has no banned word.
func TestMailSamplesEveryLanguage(t *testing.T) {
	samples := mailSamples("https://www.stereo3d.studio")
	extra := map[string]mail.Layout{"reset": mail.ResetLayout("en", "https://www.stereo3d.studio/reset-password?oob=x")}
	seen := map[string]bool{}
	for _, lang := range mail.Langs {
		lang := mail.Resolve(lang)
		if seen[lang] {
			continue
		}
		seen[lang] = true
		layouts := map[string]mail.Layout{}
		for _, sm := range samples {
			layouts[sm.ID] = sm.Mail.layout(lang)
		}
		for id, l := range extra {
			layouts[id] = l
		}
		for id, l := range layouts {
			subject, text, html := l.FullSubject(), l.Text(), l.HTML()
			if !strings.Contains(subject, "Spatial Video Studio") || len([]rune(l.Subject)) > mail.SubjectMax {
				t.Errorf("%s %s: subject %q", lang, id, subject)
			}
			if text == "" || l.Title == "" || !strings.Contains(html, "<html") {
				t.Errorf("%s %s: missing a part", lang, id)
			}
			if strings.ContainsAny(subject+text, "{}") {
				t.Errorf("%s %s: placeholder left:\n%s", lang, id, text)
			}
			if w := bannedCopy.FindString(allowedCopy.ReplaceAllString(subject+"\n"+text, "")); w != "" {
				t.Errorf("%s %s: says %q:\n%s", lang, id, w, text)
			}
		}
	}
}

// The consent line is the web's one sentence; no "14-day" anywhere.
func TestMailCancellationSentence(t *testing.T) {
	want := "You asked us to start right away, so your right to cancel ends when your 3D video is ready."
	for _, k := range mail.Keys() {
		if strings.Contains(mail.Raw("en", k), "14") && strings.Contains(strings.ToLower(mail.Raw("en", k)), "day") {
			t.Errorf("%s: %q", k, mail.Raw("en", k))
		}
	}
	if mail.Raw("en", "e1.consent") != want {
		t.Fatal(mail.Raw("en", "e1.consent"))
	}
}

// Lifelike mails carry the gradient layer and the pill; Classic ones
// don't.
func TestMailLifelikeLayer(t *testing.T) {
	ll := orderConfirmationMail(runInfo{Name: "Beach", Lifelike: true, Res: "1080p"}, "$3.75", "https://s/p", true).layout("en")
	cl := orderConfirmationMail(runInfo{Name: "Beach", Res: "1080p"}, "$3.75", "https://s/p", true).layout("en")
	if ll.FullSubject() != "Your Lifelike 3D video is on its way · Spatial Video Studio" || !strings.Contains(ll.HTML(), "#a78bfa") ||
		!strings.Contains(ll.Text(), "Lifelike 3D") {
		t.Fatalf("lifelike %q", ll.FullSubject())
	}
	if cl.FullSubject() != "Your 3D video is on its way · Spatial Video Studio" || strings.Contains(cl.HTML(), "#a78bfa") ||
		!strings.Contains(cl.Text(), "Classic 3D · 1080p") {
		t.Fatalf("classic %q\n%s", cl.FullSubject(), cl.Text())
	}
}

// The mail language: mail_locale, then accept_locale, then the intro's
// locale, then English; tags map to the web's languages.
func TestMailLanguagePriority(t *testing.T) {
	for tag, want := range map[string]string{"ja-JP": "ja", "zh-TW": "zh-Hant", "zh-Hant-HK": "zh-Hant", "zh-CN": "zh-Hans", "zh": "zh-Hans",
		"de-DE,de;q=0.9,en;q=0.8": "de", "pt-BR": "", "": "", "*": "", "ar_EG": "ar", "EN-gb": "en"} {
		if got := mail.LangFor(tag); got != want {
			t.Errorf("LangFor(%q) = %q, want %q", tag, got, want)
		}
	}
	for _, tc := range []struct {
		c    *store.Customer
		want string
	}{
		{nil, "en"},
		{&store.Customer{}, "en"},
		{&store.Customer{Locale: "fr"}, "fr"},
		{&store.Customer{Locale: "fr", AcceptLocale: "de"}, "de"},
		{&store.Customer{Locale: "fr", AcceptLocale: "de", MailLocale: "ja"}, "ja"},
		{&store.Customer{Locale: "pt", AcceptLocale: "xx", MailLocale: ""}, "en"},
	} {
		if got := mailLangOf(tc.c); got != tc.want {
			t.Errorf("%+v: %q, want %q", tc.c, got, tc.want)
		}
	}
	if mail.Resolve("en") != "en" || mail.Resolve("xx") != "en" {
		t.Fatal("resolve")
	}
}

// Accept-Language is written at most once a day, never over an explicit
// mail_locale, and never into the intro's locale.
func TestAcceptLocaleOncePerDay(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{Email: "a@example.com", Locale: "fr"})
	now := time.Now().UTC()
	if !s.recordAcceptLocale(ctx, uid, "ja", now) {
		t.Fatal("first write")
	}
	if s.recordAcceptLocale(ctx, uid, "de", now.Add(time.Hour)) {
		t.Fatal("second write within a day")
	}
	if !s.recordAcceptLocale(ctx, uid, "de", now.Add(25*time.Hour)) {
		t.Fatal("next day")
	}
	c, _ := s.Store.GetCustomer(ctx, uid)
	if c.AcceptLocale != "de" || c.Locale != "fr" {
		t.Fatalf("customer %q %q", c.AcceptLocale, c.Locale)
	}
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error { c.MailLocale = "es"; return nil })
	if s.recordAcceptLocale(ctx, uid, "ko", now.Add(72*time.Hour)) {
		t.Fatal("wrote over mail_locale")
	}
}

// webRun is a finished web 3D video in a project.
func webRun(t *testing.T, s *Service, uid, name string, lifelike bool, state string) *store.Conversion {
	t.Helper()
	ctx := context.Background()
	p := &store.Project{ID: store.NewID(), UID: uid, Name: name}
	if err := s.Store.CreateProject(ctx, p); err != nil {
		t.Fatal(err)
	}
	c := &store.Conversion{ID: store.NewID(), UID: uid, State: state, Kind: "video", ProjectID: p.ID, Step: store.StepProduction,
		Quote: store.Quote{AmountCents: 375, Currency: "usd"}, Outputs: map[string]string{"mvhevc": "x/mvhevc.mov"}}
	c.Stripe.CapturedCents = 375
	if lifelike {
		c.Method = store.MethodLifelike
	}
	if err := s.Store.CreateConversion(ctx, c); err != nil {
		t.Fatal(err)
	}
	return c
}

// The ready mail: one per account for 3D videos finishing together, sent
// after the window, once; none for failed runs, with the setting off, or
// for app runs (no project); in the account's language.
func TestReadyMail(t *testing.T) {
	s, _ := e0Service(t)
	sent := mailCapture(t, s)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{Email: "r@example.com", MailLocale: "ja"})
	var runs []*store.Conversion
	for _, n := range []string{"Beach", "Hike", "Party"} {
		c := webRun(t, s, uid, n, n == "Beach", store.StateSucceeded)
		runs = append(runs, c)
		s.queueReadyMail(ctx, c)
	}
	failed := webRun(t, s, uid, "Broken", false, store.StateFailed)
	s.queueReadyMail(ctx, failed)
	if n := s.deferredMailSweep(ctx, time.Now().UTC()); n != 0 || len(sent()) != 0 {
		t.Fatalf("sent inside the window: %d", n)
	}
	later := time.Now().UTC().Add(readyWindow + time.Minute)
	s.deferredMailSweep(ctx, later)
	got := sent()
	if len(got) != 1 {
		t.Fatalf("%d mails", len(got))
	}
	m := got[0]
	if m.To != "r@example.com" || m.Subject != "Your 3D videos are ready · Spatial Video Studio" ||
		!strings.Contains(m.Text, "Beach") || !strings.Contains(m.Text, "Party") || strings.Contains(m.Text, "Broken") ||
		!strings.Contains(m.Text, "Download / Watch: https://site.example/projects") ||
		!strings.Contains(m.HTML, `lang="`+mail.Resolve("ja")+`"`) {
		t.Fatalf("%+v", m)
	}
	for _, c := range runs {
		s.queueReadyMail(ctx, c) // a settle replayed
	}
	s.deferredMailSweep(ctx, later.Add(time.Hour))
	if len(sent()) != 1 {
		t.Fatal("mailed twice")
	}

	off := "u" + store.NewID()
	s.Store.PutCustomer(ctx, off, &store.Customer{Email: "o@example.com", NotifyReadyOff: true})
	s.queueReadyMail(ctx, webRun(t, s, off, "Quiet", false, store.StateSucceeded))
	app := "u" + store.NewID()
	s.Store.PutCustomer(ctx, app, &store.Customer{Email: "app@example.com"})
	appRun := webRun(t, s, app, "", false, store.StateSucceeded)
	appRun.ProjectID = ""
	s.queueReadyMail(ctx, appRun)
	s.deferredMailSweep(ctx, later.Add(2*time.Hour))
	if len(sent()) != 1 {
		t.Fatalf("setting off or app run mailed: %+v", sent()[1:])
	}

	one := "u" + store.NewID()
	s.Store.PutCustomer(ctx, one, &store.Customer{Email: "one@example.com"})
	s.queueReadyMail(ctx, webRun(t, s, one, "Solo", true, store.StateSucceeded))
	s.deferredMailSweep(ctx, later.Add(3*time.Hour))
	if got := sent(); len(got) != 2 || got[1].Subject != "Your Lifelike 3D video is ready · Spatial Video Studio" ||
		!strings.Contains(got[1].Text, "Paid: $3.75") {
		t.Fatalf("single %+v", got[len(got)-1])
	}
}

// E1 paid before its session says the currency waits, then goes out once
// with the local amount when the session completes, or after two
// minutes from the reconciler.
func TestE1WaitsForCurrency(t *testing.T) {
	s, _ := e0Service(t)
	sent := mailCapture(t, s)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{Email: "e1@example.com"})

	c := webRun(t, s, uid, "Beach", false, store.StatePaid)
	s.mailOrderConfirmation(withE1Deferred(ctx), c)
	if len(sent()) != 0 || !s.Store.MailDeferred(ctx, "E1_"+c.ID) {
		t.Fatal("not deferred")
	}
	c.Stripe.Presentment = &store.Presentment{AmountMinor: 618, Currency: "jpy"}
	if err := s.Store.Update(ctx, c); err != nil {
		t.Fatal(err)
	}
	s.releaseDeferredE1(ctx, c.ID)
	s.releaseDeferredE1(ctx, c.ID)
	s.deferredMailSweep(ctx, time.Now().UTC().Add(time.Hour))
	if got := sent(); len(got) != 1 || !strings.Contains(got[0].Text, "Paid: ¥618 (US$3.75)") {
		t.Fatalf("%+v", got)
	}

	late := webRun(t, s, uid, "Hike", false, store.StatePaid)
	s.mailOrderConfirmation(withE1Deferred(ctx), late)
	s.deferredMailSweep(ctx, time.Now().UTC())
	if len(sent()) != 1 {
		t.Fatal("sent before the two minutes")
	}
	s.deferredMailSweep(ctx, time.Now().UTC().Add(e1DeferFor+time.Second))
	s.deferredMailSweep(ctx, time.Now().UTC().Add(time.Hour))
	if got := sent(); len(got) != 2 || !strings.Contains(got[1].Text, "Paid: $3.75") {
		t.Fatalf("%+v", got)
	}

	// without the deferral mark (the session's own path) E1 goes at once
	now := webRun(t, s, uid, "Party", false, store.StatePaid)
	s.mailOrderConfirmation(ctx, now)
	if len(sent()) != 3 {
		t.Fatal("not sent at once")
	}
}

// The app's payment mails (E2–E5) keep their kinds and keys: each key
// sends once, in the branded layout.
func TestAppPathMailsKeepKeys(t *testing.T) {
	s, _ := e0Service(t)
	sent := mailCapture(t, s)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{Email: "app@example.com"})
	for _, k := range []string{"E2", "E3", "E4"} {
		s.mailOwed(ctx, k, k+"_g1", uid, 450)
		s.mailOwed(ctx, k, k+"_g1", uid, 450)
	}
	s.mailDownloadsBack(ctx, "E5_g1", uid, 450)
	s.mailDownloadsBack(ctx, "E5_g1", uid, 450)
	got := sent()
	if len(got) != 4 {
		t.Fatalf("%d mails", len(got))
	}
	for i, want := range []string{"A payment didn't go through", "Your payment is still due", "Last reminder about your payment", "Your downloads are back"} {
		if got[i].Subject != want+" · Spatial Video Studio" || !strings.Contains(got[i].Text, "$4.50") || !strings.Contains(got[i].HTML, mail.LogoURL) {
			t.Errorf("%d: %q", i, got[i].Subject)
		}
	}
}
