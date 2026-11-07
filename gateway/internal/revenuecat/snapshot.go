package revenuecat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// PromoGrant is one promotional grant as RevenueCat reports it:
// subscriptions[product] with store "promotional". ExpiresAt nil is a
// lifetime grant. RevenueCat keys promotional grants by product
// ("rc_promo_<entitlement>_<duration>"), so several grants of the same
// entitlement and duration collapse into one entry, the latest expiry.
type PromoGrant struct {
	Entitlement string     `firestore:"entitlement" json:"entitlement"`
	Product     string     `firestore:"product" json:"product"`
	ExpiresAt   *time.Time `firestore:"expires_at,omitempty" json:"expires_at,omitempty"`
}

// Active: not expired at now.
func (g PromoGrant) Active(now time.Time) bool { return g.ExpiresAt == nil || g.ExpiresAt.After(now) }

// promoEntitlements are the entitlements a promotional product can name,
// longest first so "pro" never shadows a longer id.
var promoEntitlements = []string{"business", "studio", "remote", "trial", "pro"}

// PromoEntitlementOf reads the entitlement from a promotional product id
// ("rc_promo_pro_custom" → "pro"); "" when it isn't one.
func PromoEntitlementOf(product string) string {
	rest, ok := strings.CutPrefix(product, "rc_promo_")
	if !ok {
		return ""
	}
	for _, e := range promoEntitlements {
		if rest == e || strings.HasPrefix(rest, e+"_") {
			return e
		}
	}
	return ""
}

// PromotionalGrants asks RevenueCat (no cache) for uid's promotional
// grants, expired ones included (the caller decides).
func (c *Client) PromotionalGrants(ctx context.Context, uid string) ([]PromoGrant, error) {
	if !c.Configured() || uid == "" {
		return nil, fmt.Errorf("revenuecat not configured")
	}
	if !c.mayRead(ctx, uid) {
		return nil, ErrNotRead
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+"/v1/subscribers/"+url.PathEscape(uid), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+c.key)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, &GrantError{Msg: "no answer"}
	}
	defer resp.Body.Close()
	if !subscriberRead(resp.StatusCode) {
		return nil, &GrantError{Status: resp.StatusCode, Msg: "subscriber read failed"}
	}
	var body subscriber
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("revenuecat: %w", err)
	}
	return promoGrantsOf(body), nil
}

func promoGrantsOf(b subscriber) []PromoGrant {
	var out []PromoGrant
	for product, sub := range b.Subscriber.Subscriptions {
		if sub.Store != "promotional" {
			continue
		}
		ent := PromoEntitlementOf(product)
		if ent == "" { // a product id we can't read: the entitlement that points at it
			for name, e := range b.Subscriber.Entitlements {
				if e.ProductIdentifier == product {
					ent = name
				}
			}
		}
		if ent == "" {
			continue
		}
		out = append(out, PromoGrant{Entitlement: ent, Product: product, ExpiresAt: sub.ExpiresDate})
	}
	return out
}

// GrantPromotionalUntil grants entitlement from now to end; a nil end is
// a lifetime grant.
func (c *Client) GrantPromotionalUntil(ctx context.Context, uid, entitlement string, end *time.Time) error {
	if end != nil {
		return c.GrantPromotional(ctx, uid, entitlement, time.Now().UTC(), *end)
	}
	if !c.CanGrant() {
		return &GrantError{Msg: "no secret key"}
	}
	if c.dryRun(ctx, uid, "grant_promotional", "entitlement", entitlement, "duration", "lifetime") {
		return nil
	}
	err := c.call(ctx, "/v1/subscribers/"+url.PathEscape(uid)+"/entitlements/"+url.PathEscape(entitlement)+"/promotional", map[string]any{"duration": "lifetime"})
	c.forget(uid)
	return err
}

// RevokeAnyPromotionals revokes every promotional grant of entitlement,
// "pro" included: only for the promo re-grant flow, which snapshots the
// grants first and gives back the ones that weren't the reason.
func (c *Client) RevokeAnyPromotionals(ctx context.Context, uid, entitlement string) error {
	if !c.CanGrant() {
		return &GrantError{Msg: "no secret key"}
	}
	if c.dryRun(ctx, uid, "revoke_any_promotionals", "entitlement", entitlement) {
		return nil
	}
	err := c.call(ctx, "/v1/subscribers/"+url.PathEscape(uid)+"/entitlements/"+url.PathEscape(entitlement)+"/revoke_promotionals", map[string]any{})
	c.forget(uid)
	return err
}
