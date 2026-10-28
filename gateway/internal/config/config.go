// Package config loads gateway configuration from environment variables.
package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	Env               string // "test" | "prod"
	Port              string
	GCPProjectID      string
	FirebaseProjectID string
	BucketName        string
	BucketPrefix      string // "stereo3d/{env}/"

	ModalBaseURL     string // https://<workspace>--stereo3d-api-<env>.modal.run
	ModalTokenID     string // Modal proxy-auth token (Modal-Key header)
	ModalTokenSecret string // Modal proxy-auth token (Modal-Secret header)

	StripeSecretKey      string
	StripeWebhookSecret  string
	StripePublishableKey string

	SlackWebhookURL string // optional; failure notifications
	ReconcileToken  string // shared secret for /internal/reconcile

	// FirebaseWebAPIKey is the project's public web API key, for the
	// /v1/auth/* routes that sign browsers in on their behalf (identity
	// package). Optional: without it those routes answer auth_unavailable.
	FirebaseWebAPIKey string
	// LBIPs / RelayIPs (comma-separated) decide which caller address the
	// auth rate limit trusts; empty means identity's defaults.
	LBIPs    string
	RelayIPs string

	// MediaRelayOrigin replaces https://storage.googleapis.com in storage
	// links answered to browsers that came through the relay (mediahost).
	// "off" disables the rewrite.
	MediaRelayOrigin string
	// ResendAPIKey (send-only) mails the site's own password-reset link to
	// relay users (identity.SiteReset), from ResetMailFrom, to ResetPageURL.
	// Without the key, relay resets use the provider's email as before.
	ResendAPIKey  string
	ResetMailFrom string
	ResetPageURL  string

	// CORSOrigins are browser origins allowed to call the API (the web
	// client). Comma-separated; "*" allows all (bearer auth, no cookies).
	CORSOrigins []string
}

func Load() (*Config, error) {
	env := getenv("APP_ENV", "test")
	if env != "test" && env != "prod" {
		return nil, fmt.Errorf("APP_ENV must be test|prod, got %q", env)
	}
	project := getenv("GCP_PROJECT_ID", "")
	c := &Config{
		Env:               env,
		Port:              getenv("PORT", "8080"),
		GCPProjectID:      project,
		FirebaseProjectID: getenv("FIREBASE_PROJECT_ID", project),
		BucketName:        getenv("BUCKET_NAME", "spatial-video-studio-app"),
		BucketPrefix:      fmt.Sprintf("stereo3d/%s/", env),

		ModalBaseURL:     strings.TrimRight(getenv("MODAL_BASE_URL", ""), "/"),
		ModalTokenID:     getenv("MODAL_TOKEN_ID", ""),
		ModalTokenSecret: getenv("MODAL_TOKEN_SECRET", ""),

		StripeSecretKey:      getenv("STRIPE_SECRET_KEY", ""),
		StripeWebhookSecret:  getenv("STRIPE_WEBHOOK_SECRET", ""),
		StripePublishableKey: getenv("STRIPE_PUBLISHABLE_KEY", ""),

		SlackWebhookURL: getenv("SLACK_WEBHOOK_URL", ""),
		ReconcileToken:  getenv("RECONCILE_TOKEN", ""),

		FirebaseWebAPIKey: getenv("FIREBASE_WEB_API_KEY", ""),
		LBIPs:             getenv("LB_IPS", ""),
		RelayIPs:          getenv("RELAY_IPS", ""),

		MediaRelayOrigin: getenv("MEDIA_RELAY_ORIGIN", "https://cn.media.stereo3d.studio"),
		ResendAPIKey:     getenv("RESEND_API_KEY", ""),
		ResetMailFrom:    getenv("RESET_MAIL_FROM", ""),
		ResetPageURL:     getenv("RESET_PAGE_URL", "https://www.stereo3d.studio/reset-password"),
	}
	if c.MediaRelayOrigin == "off" {
		c.MediaRelayOrigin = ""
	}
	for _, o := range strings.Split(getenv("CORS_ORIGINS", "*"), ",") {
		if o = strings.TrimSpace(o); o != "" {
			c.CORSOrigins = append(c.CORSOrigins, strings.TrimRight(o, "/"))
		}
	}
	for key, val := range map[string]string{
		"GCP_PROJECT_ID":    c.GCPProjectID,
		"MODAL_BASE_URL":    c.ModalBaseURL,
		"STRIPE_SECRET_KEY": c.StripeSecretKey,
	} {
		if val == "" {
			return nil, fmt.Errorf("missing required env var %s", key)
		}
	}
	return c, nil
}

func getenv(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}
