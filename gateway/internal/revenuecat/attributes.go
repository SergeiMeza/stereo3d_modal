package revenuecat

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// Subscriber attributes (owner 2026-11-07): the gateway writes its own
// web_* attributes, and $email / $displayName only where the customer has
// none yet (the app owns them). RevenueCat is one shared project (the
// app's prod data): callers decide who may be written.

// SubscriberAttributes reads the customer's attribute values (name →
// value). The read creates the customer in RevenueCat when it's new.
func (c *Client) SubscriberAttributes(ctx context.Context, uid string) (map[string]string, error) {
	if !c.Configured() || uid == "" {
		return nil, fmt.Errorf("revenuecat not configured")
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
	var body struct {
		Subscriber struct {
			Attributes map[string]struct {
				Value string `json:"value"`
			} `json:"subscriber_attributes"`
		} `json:"subscriber"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return nil, fmt.Errorf("revenuecat: %w", err)
	}
	out := map[string]string{}
	for k, v := range body.Subscriber.Attributes {
		out[k] = v.Value
	}
	return out, nil
}

// SetAttributes writes attributes (POST /v1/subscribers/{id}/attributes);
// an empty value removes one.
func (c *Client) SetAttributes(ctx context.Context, uid string, attrs map[string]string, at time.Time) error {
	if !c.Configured() || uid == "" {
		return fmt.Errorf("revenuecat not configured")
	}
	if len(attrs) == 0 {
		return nil
	}
	body := map[string]map[string]any{}
	for k, v := range attrs {
		var val any = v
		if v == "" {
			val = nil // removes it
		}
		body[k] = map[string]any{"value": val, "updated_at_ms": at.UnixMilli()}
	}
	return c.call(ctx, "/v1/subscribers/"+url.PathEscape(uid)+"/attributes", map[string]any{"attributes": body})
}
