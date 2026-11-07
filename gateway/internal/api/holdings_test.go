package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/gcsx"
	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func holdings(s *Service, uid, key string) (int, map[string]any, string) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /internal/holdings/{uid}", s.HandleHoldings)
	r := httptest.NewRequest(http.MethodGet, "/internal/holdings/"+uid, nil)
	if key != "" {
		r.Header.Set(httpx.HeaderProxyKey, key)
	}
	w := httptest.NewRecorder()
	httpx.WithTrustedProxy("k", mux).ServeHTTP(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out, w.Body.String()
}

// svs-backend's holdings read: counts only, with the proxy key; a plain
// 404 without it (the route doesn't show); zeros for a uid with nothing.
func TestHoldings(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.GCS = gcsx.NewWithSigner("bucket", "stereo3d/test/", nil, nil).WithObjects(func(_ context.Context, prefix string) ([]string, error) {
		if strings.Contains(prefix, "/users/u-full/") {
			return []string{prefix + "a/source.mp4", prefix + "a/out.mp4"}, nil
		}
		return nil, nil
	}, nil)

	for _, key := range []string{"", "wrong"} {
		if code, _, body := holdings(s, "u-full", key); code != 404 || strings.Contains(body, "holdings") {
			t.Fatalf("key %q: %d %s", key, code, body)
		}
	}
	code, out, _ := holdings(s, "u-nothing"+store.NewID(), "k")
	want := map[string]any{"customer": false, "conversions": float64(0), "billing_batches_pending": float64(0), "billing_batches_failed": float64(0),
		"projects": float64(0), "image_quota": false, "files": float64(0), "promo_grants_active": float64(0), "balance_cents": float64(0)}
	if code != 200 || len(out) != len(want) {
		t.Fatalf("nothing %d %v", code, out)
	}
	for k, v := range want {
		if out[k] != v {
			t.Fatalf("nothing: %s = %v", k, out[k])
		}
	}

	uid := "u-full"
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_9", Email: "x@example.com"})
	s.Store.CreateConversion(ctx, &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateSucceeded, Kind: "video"})
	s.Store.CreateProject(ctx, &store.Project{ID: store.NewID(), UID: uid, Name: "mine", CreatedAt: time.Now()})
	s.Store.CreateProject(ctx, &store.Project{ID: store.NewID(), UID: uid, Sample: true, CreatedAt: time.Now()})
	s.Store.ConsumeDailyImageQuota(ctx, uid, 5)
	code, out, body := holdings(s, uid, "k")
	if code != 200 || out["customer"] != true || out["conversions"] != float64(1) || out["projects"] != float64(1) ||
		out["image_quota"] != true || out["files"] != float64(2) {
		t.Fatalf("full %d %v", code, out)
	}
	for _, leak := range []string{"cus_9", "x@example.com", "u-full"} {
		if strings.Contains(body, leak) {
			t.Fatalf("answer names %q: %s", leak, body)
		}
	}
}
