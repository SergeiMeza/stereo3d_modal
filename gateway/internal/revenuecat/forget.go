package revenuecat

import "context"

// Fresh asks RevenueCat again for uid, skipping the cache, and caches the
// new answer: right after a web purchase the browser calls it (POST
// /v1/pro/refresh) so the next quote carries the discount. Other Cloud Run
// instances keep their own cached answer until it ages out (okTTL).
func (c *Client) Fresh(ctx context.Context, uid string) (Status, error) {
	if c.Configured() {
		c.mu.Lock()
		delete(c.cache, uid)
		c.mu.Unlock()
	}
	return c.Pro(ctx, uid)
}

// Forget drops uid's cached answer (a RevenueCat webhook said it changed).
func (c *Client) Forget(uid string) {
	if c.Configured() {
		c.forget(uid)
	}
}
