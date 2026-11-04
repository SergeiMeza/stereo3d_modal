package api

import (
	"context"
	"log/slog"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// App Store Pro beside a web plan (owner 2026-11-04): no refunds or
// credits from us, just instructions. /v1/pro names where Pro comes from
// and where to manage it; the plan's receipt mail says how to cancel an
// App Store Pro; one reminder ~3 days after the plan starts if that Pro
// still renews.

const appleSubscriptionsURL = "https://apps.apple.com/account/subscriptions"

const appProReminderAfter = 72 * time.Hour

// proSource: app_store | mac_app_store | rc_billing | promotional | plan
// | simulated ("" when not Pro).
func proSource(st revenuecat.Status, cust *store.Customer, now time.Time) string {
	if !st.Pro {
		return ""
	}
	if st.Tier != "" || (st.Store == "promotional" && ourPlanGrantActive(cust, now)) {
		return "plan"
	}
	switch st.Store {
	case "stripe", "rc_billing":
		return "rc_billing" // RevenueCat Web Billing
	case "":
		if st.AppStore != nil {
			return st.AppStore.Store
		}
		return "promotional"
	}
	return st.Store
}

// managementURL: RevenueCat's, else Apple's page for an Apple store.
func managementURL(st revenuecat.Status, source string) string {
	if st.ManagementURL != "" {
		return st.ManagementURL
	}
	if source == "app_store" || source == "mac_app_store" || st.AppStore != nil {
		return appleSubscriptionsURL
	}
	return ""
}

// appStorePro is the account's active App Store Pro (nil without one or
// when RevenueCat can't tell).
func (s *Service) appStorePro(ctx context.Context, uid string) (*revenuecat.AppStoreSub, string) {
	if !s.RevenueCat.Configured() {
		return nil, ""
	}
	st, err := s.RevenueCat.Fresh(ctx, uid)
	if err != nil || st.AppStore == nil {
		return nil, ""
	}
	u := st.ManagementURL
	if u == "" {
		u = appleSubscriptionsURL
	}
	return st.AppStore, u
}

func appStoreProLines(planName, link string) []string {
	return []string{
		"Your Pro is billed by Apple. " + planName + " includes everything Pro does, so cancel Pro in your iPhone's Settings → [your name] → Subscriptions to avoid paying for both.",
		"Manage your App Store subscriptions: " + link,
	}
}

// planStarted records the start and sends the plan's receipt mail (E18),
// once per subscription.
func (s *Service) planStarted(ctx context.Context, uid, tier, subID string) {
	now := time.Now().UTC()
	s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if c.Plan != nil && c.Plan.SubscriptionID == subID && c.Plan.StartedAt == nil {
			c.Plan.StartedAt = &now
		}
		return nil
	})
	link := ""
	if sub, l := s.appStorePro(ctx, uid); sub != nil {
		link = l
	}
	s.mailCustomer(ctx, "plan_started:"+subID, uid, s.accountEmail(ctx, uid), planStartedMail(tier, link, s.Cfg.SiteURL))
}

// planStartedMail is E18; appLink set = an App Store Pro to cancel.
func planStartedMail(tier, appLink, site string) customerMail {
	name := tierLabel(tier)
	lines := []string{"Your " + name + " plan is active. Its credit and free previews are ready on your account."}
	if appLink != "" {
		lines = append(lines, appStoreProLines(name, appLink)...)
	}
	return customerMail{Kind: "E18", Subject: "Spatial Video Studio: your " + name + " plan has started", Lines: lines,
		Button: "Open Spatial Video Studio", Link: site}
}

// appProReminderSweep sends E19 once per subscription, ~3 days after the
// plan started, only while the plan runs and an App Store Pro still
// renews. Run from the balance sweep.
func (s *Service) appProReminderSweep(ctx context.Context, now time.Time) int {
	custs, err := s.Store.ListPlanCustomers(ctx, 500)
	if err != nil {
		slog.WarnContext(ctx, "app pro reminder: list failed", "err", err)
		return 0
	}
	sent := 0
	for uid, c := range custs {
		p := c.Plan
		if p == nil || p.StartedAt == nil || p.AppProChecked == p.SubscriptionID || now.Sub(*p.StartedAt) < appProReminderAfter {
			continue
		}
		if s.remindAppPro(ctx, uid, c, now) {
			sent++
		}
	}
	return sent
}

func (s *Service) remindAppPro(ctx context.Context, uid string, c *store.Customer, now time.Time) bool {
	p := c.Plan
	subID := p.SubscriptionID
	send := false
	var link string
	if p.Active(now) && !p.CancelAtPeriodEnd {
		var sub *revenuecat.AppStoreSub
		sub, link = s.appStorePro(ctx, uid)
		send = sub != nil && sub.WillRenew
	}
	if _, err := s.Store.UpdateCustomer(ctx, uid, func(cu *store.Customer) error {
		if cu.Plan != nil && cu.Plan.SubscriptionID == subID {
			cu.Plan.AppProChecked = subID
		}
		return nil
	}); err != nil {
		return false
	}
	if !send {
		return false
	}
	name := tierLabel(p.Tier)
	s.mailCustomer(ctx, "app_pro_reminder:"+subID, uid, c.Email, customerMail{Kind: "E19",
		Subject: "Spatial Video Studio: cancel your App Store Pro to avoid paying twice",
		Lines:   append([]string{"Your " + name + " plan is running, and your Pro from the App Store is still set to renew."}, appStoreProLines(name, link)...),
		Button:  "Manage subscriptions", Link: link})
	return true
}
