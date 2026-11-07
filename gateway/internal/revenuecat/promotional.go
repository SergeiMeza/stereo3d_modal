package revenuecat

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// Promotional entitlements for the web plans (owner decision, option b:
// no Stripe app in RevenueCat). A paid plan invoice grants `business` or
// `studio` AND `pro` to the Firebase uid until the period's end plus
// grace; an early end revokes the plan entitlement only. Calls need a
// SECRET key (sk_…); the key is never logged.

// GrantError is a grant or revoke RevenueCat refused or never answered.
type GrantError struct {
	Status int // 0 = no answer
	Msg    string
}

func (e *GrantError) Error() string {
	if e.Status == 0 {
		return "revenuecat: " + e.Msg
	}
	return fmt.Sprintf("revenuecat: status %d: %s", e.Status, e.Msg)
}

// CanGrant: the key is a secret key (promotional calls refuse public ones).
func (c *Client) CanGrant() bool { return c.Configured() && strings.HasPrefix(c.key, "sk_") }

// retryPauses between attempts on a 5xx, a 429 or no answer.
var retryPauses = []time.Duration{500 * time.Millisecond, 1500 * time.Millisecond, 3 * time.Second}

// call posts body to path with retries; nil on 2xx.
func (c *Client) call(ctx context.Context, path string, body any) error {
	raw, _ := json.Marshal(body)
	var last error
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, bytes.NewReader(raw))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+c.key)
		req.Header.Set("Content-Type", "application/json")
		resp, err := c.http.Do(req)
		retry := false
		if err != nil {
			last, retry = &GrantError{Msg: "no answer"}, true // the error text could carry the request; keep it out
		} else {
			msg, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
			resp.Body.Close()
			if resp.StatusCode < 300 {
				return nil
			}
			last = &GrantError{Status: resp.StatusCode, Msg: strings.TrimSpace(string(msg))}
			retry = resp.StatusCode >= 500 || resp.StatusCode == http.StatusTooManyRequests
			if resp.StatusCode == http.StatusTooManyRequests {
				if s, _ := strconv.Atoi(resp.Header.Get("Retry-After")); s > 0 && s <= 10 && attempt < len(retryPauses) {
					if !sleep(ctx, time.Duration(s)*time.Second) {
						return last
					}
					continue
				}
			}
		}
		if !retry || attempt >= len(retryPauses) {
			return last
		}
		if !sleep(ctx, retryPauses[attempt]) {
			return last
		}
	}
}

func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// durations RevenueCat's v1 promotional endpoint accepts, shortest first.
var durations = []struct {
	name string
	d    time.Duration
}{
	{"daily", 24 * time.Hour}, {"three_day", 72 * time.Hour}, {"weekly", 7 * 24 * time.Hour},
	{"monthly", 31 * 24 * time.Hour}, {"two_month", 62 * 24 * time.Hour}, {"three_month", 92 * 24 * time.Hour},
	{"six_month", 183 * 24 * time.Hour}, {"yearly", 366 * 24 * time.Hour}, {"lifetime", 1 << 62},
}

// DurationCovering is the smallest named duration from start that
// reaches end.
func DurationCovering(start, end time.Time) string {
	need := end.Sub(start)
	for _, d := range durations {
		if d.d >= need {
			return d.name
		}
	}
	return "lifetime"
}

// GrantPromotional grants entitlement to uid from start to end
// (start_time_ms/end_time_ms; if RevenueCat refuses those, the smallest
// duration that covers end). The uid's cached answer is dropped.
func (c *Client) GrantPromotional(ctx context.Context, uid, entitlement string, start, end time.Time) error {
	if !c.CanGrant() {
		return &GrantError{Msg: "no secret key"}
	}
	if c.dryRun(ctx, uid, "grant_promotional", "entitlement", entitlement, "start", start.UTC(), "end", end.UTC()) {
		return nil
	}
	path := "/v1/subscribers/" + url.PathEscape(uid) + "/entitlements/" + url.PathEscape(entitlement) + "/promotional"
	err := c.call(ctx, path, map[string]any{"start_time_ms": start.UnixMilli(), "end_time_ms": end.UnixMilli()})
	var ge *GrantError
	if errors.As(err, &ge) && ge.Status == http.StatusBadRequest {
		err = c.call(ctx, path, map[string]any{"duration": DurationCovering(time.Now(), end)})
	}
	c.forget(uid)
	return err
}

// RevokePromotionals revokes every promotional grant of entitlement for
// uid. Never call it for "pro": that would also take Pro granted for
// other reasons (support, campaigns).
func (c *Client) RevokePromotionals(ctx context.Context, uid, entitlement string) error {
	if entitlement == proEntitlement {
		return &GrantError{Msg: "refusing to revoke pro promotionals"}
	}
	if !c.CanGrant() {
		return &GrantError{Msg: "no secret key"}
	}
	if c.dryRun(ctx, uid, "revoke_promotionals", "entitlement", entitlement) {
		return nil
	}
	err := c.call(ctx, "/v1/subscribers/"+url.PathEscape(uid)+"/entitlements/"+url.PathEscape(entitlement)+"/revoke_promotionals", map[string]any{})
	c.forget(uid)
	return err
}

// RevokeProPromotionals revokes every promotional "pro" grant: only for
// web Pro on our own Stripe ending early (the caller names it; entitlement
// is always pro).
func (c *Client) RevokeProPromotionals(ctx context.Context, uid, _ string) error {
	if !c.CanGrant() {
		return &GrantError{Msg: "no secret key"}
	}
	if c.dryRun(ctx, uid, "revoke_promotionals", "entitlement", proEntitlement) {
		return nil
	}
	err := c.call(ctx, "/v1/subscribers/"+url.PathEscape(uid)+"/entitlements/"+proEntitlement+"/revoke_promotionals", map[string]any{})
	c.forget(uid)
	return err
}

func (c *Client) forget(uid string) {
	c.mu.Lock()
	delete(c.cache, uid)
	c.mu.Unlock()
}
