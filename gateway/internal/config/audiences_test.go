package config

import (
	"slices"
	"testing"
)

// Internal routes (the deletion hand-off, the revenue report) take a Google
// ID token whose audience is either of the service's URLs: Cloud Run's
// hashed one (what `gcloud run services describe` prints) and the
// project-number one.
func TestInternalAudiencesBothServiceURLs(t *testing.T) {
	for env, urls := range map[string][]string{
		"test": {"https://stereo3d-gateway-test-zergcuzmrq-uc.a.run.app", "https://stereo3d-gateway-test-151335782809.us-central1.run.app"},
		"prod": {"https://stereo3d-gateway-prod-zergcuzmrq-uc.a.run.app", "https://stereo3d-gateway-prod-151335782809.us-central1.run.app"},
	} {
		t.Setenv("APP_ENV", env)
		t.Setenv("GCP_PROJECT_ID", "spatial-video-studio")
		t.Setenv("INTERNAL_OIDC_AUDIENCES", "")
		t.Setenv("MODAL_BASE_URL", "https://ws--stereo3d-api-"+env+".modal.run")
		t.Setenv("STRIPE_SECRET_KEY", "sk_test_placeholder")
		c, err := Load()
		if err != nil {
			t.Fatal(err)
		}
		for _, u := range urls {
			if !slices.Contains(c.InternalOIDCAudiences, u) {
				t.Errorf("%s: %s not accepted (%v)", env, u, c.InternalOIDCAudiences)
			}
		}
	}
}
