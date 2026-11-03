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
	"sync"
	"time"
)

const (
	defaultBase    = "https://api.revenuecat.com"
	okTTL          = 10 * time.Minute
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
		} `json:"non_subscriptions"`
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
	if e, ok := b.Subscriber.Entitlements[proEntitlement]; ok {
		if e.ExpiresDate == nil || e.ExpiresDate.After(now) ||
			(e.GracePeriodExpiresDate != nil && e.GracePeriodExpiresDate.After(now)) {
			return Status{Pro: true, Via: e.ProductIdentifier}
		}
	}
	for product, purchases := range b.Subscriber.NonSubscriptions {
		months := PassMonths(product)
		if months == 0 {
			continue
		}
		for _, p := range purchases {
			if p.PurchaseDate.AddDate(0, months, 0).After(now) {
				return Status{Pro: true, Via: product}
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
