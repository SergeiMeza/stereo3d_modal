package api

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The console's campaign totals: runs created with the offer, and the
// cents given on runs that went through.
func TestAdminCampaign(t *testing.T) {
	s, _ := e0Service(t)
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	ctx := context.Background()
	for _, r := range []struct {
		state string
		cents int64
	}{{store.StateSucceeded, 100}, {store.StateSucceeded, 50}, {store.StateFailed, 70}, {store.StateSucceeded, 0}} {
		c := &store.Conversion{ID: store.NewID(), UID: "u" + store.NewID(), Kind: "video", State: r.state,
			Quote: store.Quote{AmountCents: 300, Breakdown: map[string]any{"campaign_cents": r.cents}}}
		if err := s.Store.CreateConversion(ctx, c); err != nil {
			t.Fatal(err)
		}
	}
	w := httptest.NewRecorder()
	s.HandleAdminCampaign(w, httptest.NewRequest("GET", "/v1/admin/campaign", nil), &AdminUser{UID: "a1", Email: "ops@example.test"})
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	tot, _ := out["totals"].(map[string]any)
	if tot["runs"] != 3.0 || tot["quoted_cents"] != 220.0 || tot["discounted_runs"] != 2.0 || tot["discounted_cents"] != 150.0 ||
		out["campaign"].(map[string]any)["max_preset"] != "qhd" || len(out["by_month"].([]any)) != 1 {
		t.Fatalf("%d %s", w.Code, w.Body)
	}
}
