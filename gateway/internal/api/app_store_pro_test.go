package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// rcAppStore serves a subscriber with an App Store Pro (renewing or not)
// behind a web plan's promotional entitlements.
func rcAppStore(t *testing.T, renewing bool, withPlan bool) *revenuecat.Client {
	t.Helper()
	exp := time.Now().Add(20 * 24 * time.Hour).UTC().Format(time.RFC3339)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		sub := map[string]any{"purchase_date": time.Now().UTC().Format(time.RFC3339), "expires_date": exp, "store": "app_store"}
		if !renewing {
			sub["unsubscribe_detected_at"] = time.Now().UTC().Format(time.RFC3339)
		}
		ents := map[string]any{"pro": map[string]any{"expires_date": exp, "product_identifier": "svs_pro_monthly"}}
		subs := map[string]any{"svs_pro_monthly": sub}
		if withPlan {
			ents["business"] = map[string]any{"expires_date": exp, "product_identifier": "rc_promo_business_monthly"}
			subs["rc_promo_business_monthly"] = map[string]any{"purchase_date": time.Now().UTC().Format(time.RFC3339), "expires_date": exp, "store": "promotional"}
		}
		json.NewEncoder(w).Encode(map[string]any{"subscriber": map[string]any{"entitlements": ents, "subscriptions": subs,
			"management_url": "https://apps.apple.com/account/subscriptions"}})
	}))
	t.Cleanup(srv.Close)
	return revenuecat.New("sk_test_fake").WithBase(srv.URL, time.Now)
}

func TestProSourceAndManagement(t *testing.T) {
	now := time.Now()
	until := now.Add(time.Hour)
	ours := &store.Customer{Plan: &store.Plan{RCGrantedUntil: &until}}
	for _, tc := range []struct {
		st   revenuecat.Status
		cust *store.Customer
		want string
	}{
		{revenuecat.Status{Pro: true, Store: "app_store"}, nil, "app_store"},
		{revenuecat.Status{Pro: true, Store: "mac_app_store"}, nil, "mac_app_store"},
		{revenuecat.Status{Pro: true, Store: "rc_billing"}, nil, "rc_billing"},
		{revenuecat.Status{Pro: true, Store: "stripe"}, nil, "rc_billing"},
		{revenuecat.Status{Pro: true, Store: "promotional"}, nil, "promotional"},
		{revenuecat.Status{Pro: true, Store: "promotional"}, ours, "plan"},
		{revenuecat.Status{Pro: true, Tier: "studio"}, nil, "plan"},
		{revenuecat.Status{}, nil, ""},
	} {
		if got := proSource(tc.st, tc.cust, now); got != tc.want {
			t.Errorf("%+v: %q, want %q", tc.st, got, tc.want)
		}
	}
	if managementURL(revenuecat.Status{}, "app_store") != appleSubscriptionsURL || managementURL(revenuecat.Status{ManagementURL: "https://x"}, "rc_billing") != "https://x" ||
		managementURL(revenuecat.Status{}, "rc_billing") != "" {
		t.Fatal("management url")
	}
}

func TestAppStoreProReceiptAndReminder(t *testing.T) {
	m := planStartedMail("business", appleSubscriptionsURL, "https://site")
	if m.subject() != "Welcome to Business · Spatial Video Studio" ||
		!strings.Contains(m.text(), "Your Pro is billed by Apple. Business includes everything Pro does, so cancel Pro in your iPhone's Settings → [your name] → Subscriptions to avoid paying for both.") ||
		!strings.Contains(m.text(), appleSubscriptionsURL) {
		t.Fatalf("receipt %q", m.text())
	}
	if strings.Contains(planStartedMail("studio", "", "https://site").text(), "Apple") {
		t.Fatal("no App Store Pro, no paragraph")
	}

	s, _ := e0Service(t)
	ctx := context.Background()
	s.Cfg = &config.Config{Env: "test"}
	now := time.Now().UTC()
	end := now.Add(25 * 24 * time.Hour)
	mk := func(renewing, planActive bool, startedAgo time.Duration) string {
		uid := "u" + store.NewID()
		st := now.Add(-startedAgo)
		status := "active"
		if !planActive {
			status = "canceled"
		}
		s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1", Email: "a@example.com",
			Plan: &store.Plan{Tier: "business", SubscriptionID: "sub_" + uid, Status: status, CurrentPeriodEnd: &end, StartedAt: &st}})
		return uid
	}
	s.RevenueCat = rcAppStore(t, true, true)
	renew := mk(true, true, 80*time.Hour)
	early := mk(true, true, 10*time.Hour)
	ended := mk(true, false, 80*time.Hour)
	checked := func(uid string) string { c, _ := s.Store.GetCustomer(ctx, uid); return c.Plan.AppProChecked }
	for _, uid := range []string{renew, early, ended} {
		c, _ := s.Store.GetCustomer(ctx, uid)
		if c.Plan.StartedAt != nil && now.Sub(*c.Plan.StartedAt) >= appProReminderAfter {
			sent := s.remindAppPro(ctx, uid, c, now)
			if (uid == renew) != sent {
				t.Fatalf("%s sent=%v", uid, sent)
			}
		}
	}
	if checked(renew) != "sub_"+renew || checked(ended) != "sub_"+ended || checked(early) != "" {
		t.Fatal("checked marks")
	}
	// set not to renew: no reminder
	s.RevenueCat = rcAppStore(t, false, true)
	quiet := mk(false, true, 80*time.Hour)
	c, _ := s.Store.GetCustomer(ctx, quiet)
	if s.remindAppPro(ctx, quiet, c, now) {
		t.Fatal("reminded a Pro that won't renew")
	}
	// the App Store sub is found behind the plan's entitlement
	sub, link := s.appStorePro(ctx, quiet)
	if sub == nil || sub.Store != "app_store" || link != appleSubscriptionsURL {
		t.Fatalf("app store sub %+v %q", sub, link)
	}
}

// A paid run's receipt (E1) ends with the express-consent line for
// consumers, not for Business or Studio, and never the old withdrawal
// line.
func TestOrderConfirmationConsentLine(t *testing.T) {
	run := runInfo{Name: "Beach", Res: "4K"}
	consumer := orderConfirmationMail(run, "$12.00", "https://site/projects/p1", true).text()
	business := orderConfirmationMail(run, "$12.00", "https://site/projects/p1", false).text()
	if !strings.Contains(consumer, "You asked us to start right away, so your right to cancel ends when your 3D video is ready.") ||
		strings.Contains(business, "start right away") || strings.Contains(consumer+business, "14-day") || strings.Contains(consumer, "can't be cancelled") {
		t.Fatalf("consumer %q business %q", consumer, business)
	}
}

// E18 promises credit only where a plan has it: Pro gets free previews
// only; Business and Studio keep "Its credit and free previews".
func TestPlanStartedMailCreditLine(t *testing.T) {
	pro := planStartedMail("pro", "", "https://site").text()
	if !strings.Contains(pro, "Your Pro plan is active. Its free previews are ready on your account.") || strings.Contains(pro, "credit") {
		t.Fatalf("pro: %q", pro)
	}
	for _, tier := range []string{"business", "studio"} {
		if txt := planStartedMail(tier, "", "https://site").text(); !strings.Contains(txt, "plan is active. Its credit and free previews are ready on your account.") {
			t.Fatalf("%s: %q", tier, txt)
		}
	}
}
