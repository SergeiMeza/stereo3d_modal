// Package app builds the gateway's Service from its config, for the
// gateway itself and the svs-admin CLI (the same functions, spec M1).
package app

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/api"
	"spatial-ai-labs/stereo3d-gateway/internal/auth"
	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/gcsx"
	"spatial-ai-labs/stereo3d-gateway/internal/identity"
	"spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/notify"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/revenuecat"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"

	"cloud.google.com/go/firestore"
)

// Built is the wired service and what must be closed after it.
type Built struct {
	Svc      *api.Service
	Verifier *auth.Verifier
	FS       *firestore.Client
	close    []func()
}

// Close flushes the download log and closes the clients.
func (b *Built) Close() {
	if b.Svc != nil && b.Svc.Downloads != nil {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		b.Svc.Downloads.Flush(ctx)
		cancel()
	}
	for i := len(b.close) - 1; i >= 0; i-- {
		b.close[i]()
	}
}

// Build wires the Service.
func Build(ctx context.Context, cfg *config.Config) (*Built, error) {
	b := &Built{}
	verifier, err := auth.New(ctx, cfg.FirebaseProjectID)
	if err != nil {
		return nil, fmt.Errorf("firebase auth init: %w", err)
	}
	b.Verifier = verifier
	st, err := store.New(ctx, cfg.GCPProjectID, cfg.Env)
	if err != nil {
		return nil, fmt.Errorf("firestore init: %w", err)
	}
	b.close = append(b.close, func() { st.Close() })
	// pricing shares a Firestore client but reads only config/pricing_{env}.
	fsClient, err := firestore.NewClient(ctx, cfg.GCPProjectID)
	if err != nil {
		b.Close()
		return nil, fmt.Errorf("firestore init (pricing): %w", err)
	}
	b.FS = fsClient
	b.close = append(b.close, func() { fsClient.Close() })
	gcs, err := gcsx.New(ctx, cfg.BucketName, cfg.BucketPrefix)
	if err != nil {
		b.Close()
		return nil, fmt.Errorf("gcs init: %w", err)
	}
	b.close = append(b.close, func() { gcs.Close() })

	api.SetClientIPPolicy(identity.NewIPPolicy(cfg.LBIPs, cfg.RelayIPs)) // the addresses clientIP trusts
	svc := &api.Service{
		Cfg:     cfg,
		Auth:    verifier,
		Store:   st,
		Pricing: pricing.New(fsClient, cfg.Env),
		Stripe:  stripex.New(cfg.StripeSecretKey, cfg.StripeWebhookSecret, cfg.StripePublishableKey, cfg.Env),
		Modal:   modalapi.New(cfg.ModalBaseURL, cfg.ModalTokenID, cfg.ModalTokenSecret),
		GCS:     gcs,
		Slack:   notify.NewSlack(cfg.SlackWebhookURL, cfg.Env),
	}
	svc.Mail = mail.NewResend(cfg.ResendAPIKey, cfg.ResetMailFrom)
	svc.RevenueCat = revenuecat.New(cfg.RevenueCatKey)             // S3D-67 Pro check
	svc.RevenueCat.SetGate(api.RCGate(cfg.Env, svc.Pricing.Rates)) // TEST: allowlisted uids only, reads and writes
	slog.Info("revenuecat", "configured", svc.RevenueCat.Configured())
	if cfg.LifelikeBaseURL != "" {
		svc.Lifelike = modalapi.New(cfg.LifelikeBaseURL, cfg.LifelikeTokenID, cfg.LifelikeTokenSecret)
	}
	slog.Info("lifelike", "enabled", svc.Lifelike != nil, "base_url", cfg.LifelikeBaseURL)
	// Modal workspaces (S3D-40): the clients above are the default one.
	svc.DefaultWorkspaceID = cfg.DefaultWorkspaceID
	svc.ExtraWorkspaces = map[string]*api.Workspace{}
	for _, w := range cfg.ExtraWorkspaces {
		svc.ExtraWorkspaces[w.ID] = api.NewWorkspace(w)
	}
	slog.Info("modal workspaces", "default", cfg.DefaultWorkspaceID, "extra", len(cfg.ExtraWorkspaces))
	svc.Downloads = st.NewDownloadLog(2 * time.Second) // M8
	b.Svc = svc
	return b, nil
}
