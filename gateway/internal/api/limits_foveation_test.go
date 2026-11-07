package api

import (
	"net/http/httptest"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// GET /v1/limits methods.lifelike.foveation is what the web gates Foveated
// Detail on; it follows the rates' foveation flag (on for test, off by
// default elsewhere).
func TestLimitsLifelikeFoveation(t *testing.T) {
	s, _ := e0Service(t)
	for _, tc := range []struct {
		env  string
		want bool
	}{{"test", true}, {"prod", false}} {
		s.Pricing = pricing.NewStatic(pricing.DefaultsFor(tc.env))
		w := httptest.NewRecorder()
		s.HandleLimits(w, httptest.NewRequest("GET", "/v1/limits", nil), &AuthedUser{UID: "fov-" + store.NewID(), AuthTime: time.Now()})
		code, out := decode(w)
		if code != 200 {
			t.Fatalf("%s: status %d %v", tc.env, code, out)
		}
		methods, _ := out["methods"].(map[string]any)
		lifelike, _ := methods[store.MethodLifelike].(map[string]any)
		got, ok := lifelike["foveation"].(bool)
		if !ok || got != tc.want {
			t.Fatalf("%s: methods.lifelike.foveation = %v (present %v), want %v", tc.env, lifelike["foveation"], ok, tc.want)
		}
	}
}
