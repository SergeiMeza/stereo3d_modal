// Package revenuecat answers whether a Firebase uid holds Spatial Video
// Studio Pro (S3D-67), from RevenueCat's REST API v1 — the call the SVS
// backend already makes (GET /v1/subscribers/{app_user_id}; the app logs
// RevenueCat in with the Firebase uid). Answers are cached per uid.
package revenuecat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Web plan tiers, highest first (studio > business > pro).
const (
	TierStudio   = "studio"
	TierBusiness = "business"
)

// planProducts names the web plans' products as RevenueCat reports them
// (the Stripe TEST product ids; prod ids match by entitlement or name).
var planProducts = map[string]string{
	"prod_VYiOG5FegIJiFK": TierBusiness,
	"prod_VYiOZAbAXiJP29": TierStudio,
}

// PlanTierOf is the web plan a product belongs to, "" for anything else.
func PlanTierOf(product string) string {
	if t, ok := planProducts[product]; ok {
		return t
	}
	p := strings.ToLower(product)
	switch {
	case strings.Contains(p, "studio_plan") || strings.Contains(p, "web_studio") || strings.HasPrefix(p, "studio"):
		return TierStudio
	case strings.Contains(p, "business"):
		return TierBusiness
	}
	return ""
}

const (
	defaultBase    = "https://api.revenuecat.com"
	okTTL          = 2 * time.Minute // a purchase in the app shows on the web soon (QA 2026-11-05)
	failTTL        = time.Minute // a failing RevenueCat is asked again soon, not every quote
	callTimeout    = 4 * time.Second
	proEntitlement = "pro"
)

// Status is what the gateway needs to know.
type Status struct {
	Pro bool
	// Via names what makes the person Pro: the entitlement's product
	// (a subscription or Lifetime) or the pass; "" when not Pro.
	Via string
	// ExpiresAt: the entitlement's (or pass's) end; nil for Lifetime.
	// PeriodStart: when the current period began — the pass's purchase,
	// or the subscription's latest renewal (subscriptions[product]
	// .purchase_date) — the free-preview allowance resets with it.
	ExpiresAt   *time.Time
	PeriodStart *time.Time
	// WillRenew: the entitlement's subscription renews (no
	// unsubscribe_detected_at); false for Lifetime, passes and grants.
	WillRenew bool
	// Tier: "studio" or "business" when a web plan makes the person Pro
	// (its own entitlement, or a plan product behind "pro"); "" for Pro.
	Tier string
	// Store: where what makes them Pro was bought, as RevenueCat names it
	// (app_store | mac_app_store | stripe | rc_billing | promotional | …;
	// "" unknown).
	Store string
	// ManagementURL: RevenueCat's subscriber.management_url (where the
	// person manages their subscription; Apple's for App Store ones).
	ManagementURL string
	// AppStore: an active App Store or Mac App Store subscription, found
	// among all subscriptions (a web plan's grant can hide it behind the
	// entitlement); nil without one.
	AppStore *AppStoreSub
}

// AppStoreSub is an active subscription billed by Apple.
type AppStoreSub struct {
	Product   string
	Store     string // app_store | mac_app_store
	ExpiresAt *time.Time
	WillRenew bool // no unsubscribe_detected_at
	// ManagementURL: this subscription's own (the top-level one follows
	// the latest-expiring store, which may be another).
	ManagementURL string
}

type entry struct {
	status Status
	err    error
	at     time.Time
}

type Client struct {
	key  string
	base string
	http *http.Client
	now  func() time.Time

	mu    sync.Mutex
	cache map[string]entry
}

// New returns a client; an empty key yields a client that is not
// Configured (every answer: not Pro).
func New(key string) *Client {
	return &Client{key: key, base: defaultBase, http: &http.Client{Timeout: callTimeout}, now: time.Now, cache: map[string]entry{}}
}

// WithBase points the client elsewhere (tests).
func (c *Client) WithBase(base string, now func() time.Time) *Client {
	c.base, c.now = base, now
	return c
}

func (c *Client) Configured() bool { return c != nil && c.key != "" }

// Pro answers for uid, from the cache when fresh. An error means
// RevenueCat couldn't tell: callers charge list price and never block.
func (c *Client) Pro(ctx context.Context, uid string) (Status, error) {
	if !c.Configured() || uid == "" {
		return Status{}, fmt.Errorf("revenuecat not configured")
	}
	now := c.now()
	c.mu.Lock()
	if e, ok := c.cache[uid]; ok {
		ttl := okTTL
		if e.err != nil {
			ttl = failTTL
		}
		if now.Sub(e.at) < ttl {
			c.mu.Unlock()
			return e.status, e.err
		}
	}
	c.mu.Unlock()
	st, err := c.fetch(ctx, uid, now)
	c.mu.Lock()
	c.cache[uid] = entry{status: st, err: err, at: now}
	c.mu.Unlock()
	return st, err
}

type subscriber struct {
	Subscriber struct {
		Entitlements map[string]struct {
			ExpiresDate            *time.Time `json:"expires_date"`
			GracePeriodExpiresDate *time.Time `json:"grace_period_expires_date"`
			ProductIdentifier      string     `json:"product_identifier"`
		} `json:"entitlements"`
		NonSubscriptions map[string][]struct {
			PurchaseDate time.Time `json:"purchase_date"`
			Store        string    `json:"store"`
		} `json:"non_subscriptions"`
		Subscriptions map[string]struct {
			PurchaseDate          time.Time  `json:"purchase_date"`
			ExpiresDate           *time.Time `json:"expires_date"`
			Store                 string     `json:"store"`
			UnsubscribeDetectedAt *time.Time `json:"unsubscribe_detected_at"`
			RefundedAt            *time.Time `json:"refunded_at"`
			ManagementURL         string     `json:"management_url"`
		} `json:"subscriptions"`
		ManagementURL string `json:"management_url"`
	} `json:"subscriber"`
}

func (c *Client) fetch(ctx context.Context, uid string, now time.Time) (Status, error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/v1/subscribers/"+url.PathEscape(uid), nil)
	if err != nil {
		return Status{}, err
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	resp, err := c.http.Do(req)
	if err != nil {
		return Status{}, fmt.Errorf("revenuecat: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Status{}, fmt.Errorf("revenuecat: status %d", resp.StatusCode)
	}
	var body subscriber
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return Status{}, fmt.Errorf("revenuecat: %w", err)
	}
	return statusOf(body, now), nil
}

// statusOf applies the app's rule (PurchasesService): the "pro"
// entitlement active (no expiry = Lifetime; a billing grace period
// counts), or a pass ("…_pass_<n>m…", App Store or web) bought less than
// its n months ago — passes sit outside the entitlement because a
// one-off purchase never expires in RevenueCat.
func statusOf(b subscriber, now time.Time) Status {
	st := statusOfEntitlements(b, now)
	st.ManagementURL = b.Subscriber.ManagementURL
	for product, sub := range b.Subscriber.Subscriptions {
		if (sub.Store == "app_store" || sub.Store == "mac_app_store") && sub.RefundedAt == nil &&
			(sub.ExpiresDate == nil || sub.ExpiresDate.After(now)) {
			if st.AppStore == nil || (sub.ExpiresDate != nil && st.AppStore.ExpiresAt != nil && sub.ExpiresDate.After(*st.AppStore.ExpiresAt)) {
				st.AppStore = &AppStoreSub{Product: product, Store: sub.Store, ExpiresAt: sub.ExpiresDate, WillRenew: sub.UnsubscribeDetectedAt == nil,
					ManagementURL: sub.ManagementURL}
			}
		}
	}
	return st
}

func statusOfEntitlements(b subscriber, now time.Time) Status {
	active := func(name string) (Status, bool) {
		e, ok := b.Subscriber.Entitlements[name]
		if !ok || !(e.ExpiresDate == nil || e.ExpiresDate.After(now) ||
			(e.GracePeriodExpiresDate != nil && e.GracePeriodExpiresDate.After(now))) {
			return Status{}, false
		}
		st := Status{Pro: true, Via: e.ProductIdentifier, ExpiresAt: e.ExpiresDate}
		if sub, ok := b.Subscriber.Subscriptions[e.ProductIdentifier]; ok {
			st.Store = sub.Store
			st.WillRenew = sub.UnsubscribeDetectedAt == nil && sub.RefundedAt == nil && sub.Store != "promotional"
			if !sub.PurchaseDate.IsZero() {
				pd := sub.PurchaseDate
				st.PeriodStart = &pd
			}
		} else if ns := b.Subscriber.NonSubscriptions[e.ProductIdentifier]; len(ns) > 0 {
			st.Store = ns[len(ns)-1].Store // Lifetime
		}
		if st.Store == "" && strings.HasPrefix(e.ProductIdentifier, "rc_promo") {
			st.Store = "promotional"
		}
		return st, true
	}
	// Business and Studio also attach to "pro"; the highest tier wins.
	for _, tier := range []string{TierStudio, TierBusiness} {
		if st, ok := active(tier); ok {
			st.Tier = tier
			return st
		}
	}
	if st, ok := active(proEntitlement); ok {
		st.Tier = PlanTierOf(st.Via) // "pro" reached through a plan product
		return st
	}
	for product, purchases := range b.Subscriber.NonSubscriptions {
		months := PassMonths(product)
		if months == 0 {
			continue
		}
		for _, p := range purchases {
			if end := p.PurchaseDate.AddDate(0, months, 0); end.After(now) {
				pd := p.PurchaseDate
				return Status{Pro: true, Via: product, ExpiresAt: &end, PeriodStart: &pd, Store: p.Store}
			}
		}
	}
	return Status{}
}

var passRE = regexp.MustCompile(`_pass_(\d+)m`)

// PassMonths reads a pass product's months ("pro_pass_3m_v1",
// "web_pro_pass_3m_v1" → 3); 0 when it isn't a pass.
func PassMonths(product string) int {
	m := passRE.FindStringSubmatch(product)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// AllowanceKey names a Pro holder's free-preview allowance by what they
// hold: pro_weekly | pro_monthly | pro_yearly | pro_pass_3m |
// pro_pass_6m | pro_lifetime.
func (s Status) AllowanceKey() string {
	if !s.Pro {
		return ""
	}
	if s.Tier != "" { // a web plan: its own allowance, never Pro Monthly's
		return s.Tier
	}
	if t := PlanTierOf(s.Via); t != "" {
		return t
	}
	v := strings.ToLower(s.Via)
	switch {
	case PassMonths(v) == 3:
		return "pro_pass_3m"
	case PassMonths(v) == 6:
		return "pro_pass_6m"
	case PassMonths(v) > 0:
		return "pro_monthly"
	case s.ExpiresAt == nil || strings.Contains(v, "lifetime"):
		return "pro_lifetime"
	case strings.Contains(v, "week"):
		return "pro_weekly"
	case strings.Contains(v, "year") || strings.Contains(v, "annual"):
		return "pro_yearly"
	}
	return "pro_monthly"
}
