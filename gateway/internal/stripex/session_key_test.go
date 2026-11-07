package stripex

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"testing"
)

// Checkout keys carry a hash of the parameters: the same request dedupes,
// a changed one opens a new session, and an idempotency_error still gets
// one retry under a fresh key.
func TestCheckoutSessionKeys(t *testing.T) {
	var mu sync.Mutex
	seen := map[string]string{}
	failFirst := false
	var keys []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		mu.Lock()
		defer mu.Unlock()
		key, enc := r.Header.Get("Idempotency-Key"), r.PostForm.Encode()
		keys = append(keys, key)
		if prev, ok := seen[key]; (ok && prev != enc) || failFirst {
			failFirst = false
			w.WriteHeader(400)
			w.Write([]byte(`{"error":{"type":"idempotency_error","message":"Keys for idempotent requests can only be used with the same parameters"}}`))
			return
		}
		seen[key] = enc
		w.Write([]byte(`{"id":"cs_` + key + `","status":"open"}`))
	}))
	defer srv.Close()
	prev := apiBase
	apiBase = srv.URL
	defer func() { apiBase = prev }()
	c := &Client{env: "test"}
	a := url.Values{"mode": {"subscription"}, "expires_at": {"100"}}
	b := url.Values{"mode": {"subscription"}, "expires_at": {"101"}}
	s1, err := c.CreateCheckoutSession(a, "plan_test_u_pro_weekly_1")
	if err != nil {
		t.Fatal(err)
	}
	s2, err := c.CreateCheckoutSession(b, "plan_test_u_pro_weekly_1")
	if err != nil || s2.ID == s1.ID {
		t.Fatalf("changed params %v %v", s2, err)
	}
	s3, err := c.CreateCheckoutSession(a, "plan_test_u_pro_weekly_1")
	if err != nil || s3.ID != s1.ID {
		t.Fatalf("identical retry %v %v", s3, err)
	}
	failFirst = true
	if s4, err := c.CreateCheckoutSession(url.Values{"mode": {"payment"}}, "run_test_c_1"); err != nil || s4.ID == "" {
		t.Fatalf("retry after idempotency_error %v %v", s4, err)
	}
	if keys[len(keys)-1] == keys[len(keys)-2] {
		t.Fatal("the retry reused the key")
	}
}
