// Gateway entrypoint: wiring + routes. See gateway/DESIGN.md.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"strings"

	"spatial-ai-labs/stereo3d-gateway/internal/api"
	"spatial-ai-labs/stereo3d-gateway/internal/auth"
	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/gcsx"
	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/notify"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"

	"cloud.google.com/go/firestore"
)

func main() {
	// Cloud Logging parses JSON logs into structured entries; "severity" is
	// the field it keys levels on.
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			if a.Key == slog.LevelKey {
				a.Key = "severity"
			}
			return a
		},
	})))

	ctx := context.Background()
	cfg, err := config.Load()
	if err != nil {
		slog.Error("config", "err", err)
		os.Exit(1)
	}

	verifier, err := auth.New(ctx, cfg.FirebaseProjectID)
	if err != nil {
		slog.Error("firebase auth init", "err", err)
		os.Exit(1)
	}
	st, err := store.New(ctx, cfg.GCPProjectID, cfg.Env)
	if err != nil {
		slog.Error("firestore init", "err", err)
		os.Exit(1)
	}
	defer st.Close()
	// pricing shares a Firestore client but reads only config/pricing_{env}.
	fsClient, err := firestore.NewClient(ctx, cfg.GCPProjectID)
	if err != nil {
		slog.Error("firestore init (pricing)", "err", err)
		os.Exit(1)
	}
	defer fsClient.Close()
	gcs, err := gcsx.New(ctx, cfg.BucketName, cfg.BucketPrefix)
	if err != nil {
		slog.Error("gcs init", "err", err)
		os.Exit(1)
	}
	defer gcs.Close()

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

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteOK(w, map[string]string{"status": "ok", "env": cfg.Env})
	})
	mux.HandleFunc("POST /webhooks/stripe", svc.HandleStripeWebhook)
	mux.HandleFunc("POST /internal/reconcile", svc.HandleReconcile)

	// Authenticated client routes.
	authed := func(h func(http.ResponseWriter, *http.Request, *api.AuthedUser)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			u, err := verifier.FromRequest(r)
			if err != nil {
				httpx.WriteErr(r.Context(), w, httpx.ErrUnauthorized())
				return
			}
			h(w, r, &api.AuthedUser{UID: u.UID, Email: u.Email})
		}
	}
	withID := func(h func(http.ResponseWriter, *http.Request, *api.AuthedUser, string)) func(http.ResponseWriter, *http.Request, *api.AuthedUser) {
		return func(w http.ResponseWriter, r *http.Request, u *api.AuthedUser) {
			id := r.PathValue("id")
			if len(id) != 12 || strings.ContainsFunc(id, func(c rune) bool {
				return !strings.ContainsRune("0123456789abcdef", c)
			}) {
				httpx.WriteErr(r.Context(), w, httpx.ErrNotFound("conversion"))
				return
			}
			h(w, r, u, id)
		}
	}

	mux.HandleFunc("POST /v1/customers", authed(svc.HandleEnsureCustomer))
	mux.HandleFunc("GET /v1/billing", authed(svc.HandleGetBilling))
	mux.HandleFunc("POST /v1/billing/setup-intent", authed(svc.HandleCreateSetupIntent))
	mux.HandleFunc("POST /v1/billing/settle", authed(svc.HandleSettleBilling))
	mux.HandleFunc("POST /v1/billing/portal", authed(svc.HandleBillingPortal))
	mux.HandleFunc("POST /v1/uploads", authed(svc.HandleCreateUpload))
	mux.HandleFunc("POST /v1/conversions", authed(svc.HandleCreateConversion))
	mux.HandleFunc("GET /v1/conversions", authed(svc.HandleListConversions))
	mux.HandleFunc("GET /v1/conversions/{id}", authed(withID(svc.HandleGetConversion)))
	mux.HandleFunc("GET /v1/conversions/{id}/downloads", authed(withID(svc.HandleDownloads)))
	mux.HandleFunc("DELETE /v1/conversions/{id}", authed(withID(svc.HandleCancelConversion)))

	// Pro step pipeline (web/DESIGN.md): 1 video = 1 project.
	mux.HandleFunc("POST /v1/projects", authed(svc.HandleCreateProject))
	mux.HandleFunc("GET /v1/projects", authed(svc.HandleListProjects))
	mux.HandleFunc("GET /v1/projects/{id}", authed(withID(svc.HandleGetProject)))
	mux.HandleFunc("PATCH /v1/projects/{id}", authed(withID(svc.HandleUpdateProject)))
	mux.HandleFunc("DELETE /v1/projects/{id}", authed(withID(svc.HandleArchiveProject)))
	mux.HandleFunc("PATCH /v1/projects/{id}/scenes", authed(withID(svc.HandleUpdateScenes)))
	mux.HandleFunc("POST /v1/projects/{id}/depth-map", authed(withID(svc.HandleSetProjectDepthMap)))
	mux.HandleFunc("DELETE /v1/projects/{id}/depth-map", authed(withID(svc.HandleDeleteProjectDepthMap)))
	mux.HandleFunc("POST /v1/projects/{id}/profile", authed(withID(svc.HandleProfileProject)))
	mux.HandleFunc("POST /v1/projects/{id}/quotes", authed(withID(svc.HandleQuoteStep)))
	mux.HandleFunc("POST /v1/projects/{id}/conversions", authed(withID(svc.HandleCreateStepConversion)))

	slog.Info("gateway listening", "port", cfg.Port, "env", cfg.Env)
	handler := httpx.WithCORS(cfg.CORSOrigins, httpx.WithRequestID(mux))
	if err := http.ListenAndServe(":"+cfg.Port, handler); err != nil {
		slog.Error("server exited", "err", err)
		os.Exit(1)
	}
}
