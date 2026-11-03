package revenuecat

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestFreshSkipsTheCache(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	body := `{"subscriber":{"entitlements":{}}}`
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		fmt.Fprint(w, body)
	}))
	defer srv.Close()
	c := New("k").WithBase(srv.URL, func() time.Time { return now })
	ctx := context.Background()
	if st, _ := c.Pro(ctx, "u"); st.Pro {
		t.Fatal("pro before purchase")
	}
	// Bought on the web: the cached "no" would last 10 minutes.
	body = `{"subscriber":{"entitlements":{"pro":{"expires_date":null,"product_identifier":"web_pro_subs_lifetime_v2"}}}}`
	if st, _ := c.Pro(ctx, "u"); st.Pro || calls != 1 {
		t.Fatalf("cache: pro=%v calls=%d", st.Pro, calls)
	}
	st, err := c.Fresh(ctx, "u")
	if err != nil || !st.Pro || st.Via != "web_pro_subs_lifetime_v2" || calls != 2 {
		t.Fatalf("fresh: %+v %v calls=%d", st, err, calls)
	}
	if st, _ := c.Pro(ctx, "u"); !st.Pro || calls != 2 {
		t.Fatalf("fresh answer not cached: %+v calls=%d", st, calls)
	}
}
