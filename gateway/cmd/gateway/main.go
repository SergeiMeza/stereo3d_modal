// Gateway entrypoint: wiring + routes. See gateway/DESIGN.md.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/api"
	"spatial-ai-labs/stereo3d-gateway/internal/app"
	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/emailcode"
	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/identity"
	"spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/mediahost"
)

// appRequestBudget bounds every app-facing request, Modal calls included,
// under the app's 60 s URLSession timeout.
const appRequestBudget = 50 * time.Second

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

	built, err := app.Build(ctx, cfg)
	if err != nil {
		slog.Error("init", "err", err)
		os.Exit(1)
	}
	defer built.Close()
	svc, verifier, fsClient := built.Svc, built.Verifier, built.FS
	// Cloud Run sends SIGTERM before stopping an instance: flush the
	// queued download log (M8) and exit.
	go func() {
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGTERM, os.Interrupt)
		<-sig
		built.Close()
		os.Exit(0)
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		httpx.WriteOK(w, map[string]string{"status": "ok", "env": cfg.Env})
	})
	mux.HandleFunc("POST /webhooks/stripe", svc.HandleStripeWebhook)
	// The TEST mode endpoint was registered at /webhook (found 2026-11-03:
	// every test event 404ed); both paths serve the same handler.
	mux.HandleFunc("POST /webhook", svc.HandleStripeWebhook)
	// Public price list (S3D-18): no auth, cacheable, CORS like every route.
	mux.HandleFunc("GET /v1/pricing", svc.HandlePublicPricing)
	mux.HandleFunc("POST /internal/reconcile", svc.HandleReconcile)

	// Sign-in through the gateway for browsers that can't reach Google
	// (identity package). Same Firebase uid and tokens as the JS SDK.
	ips := identity.NewIPPolicy(cfg.LBIPs, cfg.RelayIPs)
	idh := identity.NewHandlers(identity.New(cfg.FirebaseWebAPIKey), ips)
	// Relay resets mail a link to the site's own reset page: the provider's
	// email links to a host blocked in mainland China.
	idh.SiteReset = &identity.SiteReset{
		Codes:   verifier,
		Mail:    mail.NewResend(cfg.ResendAPIKey, cfg.ResetMailFrom),
		PageURL: cfg.ResetPageURL,
	}
	mux.HandleFunc("POST /v1/auth/signin", idh.SignIn)
	mux.HandleFunc("POST /v1/auth/signup", idh.SignUp)
	mux.HandleFunc("POST /v1/auth/refresh", idh.Refresh)
	mux.HandleFunc("POST /v1/auth/reset", idh.Reset)
	mux.HandleFunc("POST /v1/auth/reset/confirm", idh.ResetConfirm)

	// Sign-in with a one-time email code (S3D-70), web and China mode.
	ech := emailcode.NewHandlers(&emailcode.Service{
		Store:    emailcode.NewFirestoreStore(fsClient, cfg.Env),
		Users:    verifier,
		Sessions: idh.Client,
		Mail:     mail.NewResend(cfg.ResendAPIKey, cfg.ResetMailFrom),
	}, ips)
	mux.HandleFunc("POST /v1/auth/email/start", ech.Start)
	mux.HandleFunc("POST /v1/auth/email/verify", ech.Verify)

	// Authenticated client routes.
	authed := func(h func(http.ResponseWriter, *http.Request, *api.AuthedUser)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			u, err := verifier.FromRequest(r)
			if err != nil {
				httpx.WriteErr(r.Context(), w, httpx.ErrUnauthorized())
				return
			}
			// Answer the app inside its 60 s URLSession timeout: a Modal call
			// still waiting at 50 s gives up here, and the reconciler, which
			// waits up to an hour, takes the conversion over.
			ctx, cancel := context.WithTimeout(r.Context(), appRequestBudget)
			defer cancel()
			h(w, r.WithContext(ctx), &api.AuthedUser{UID: u.UID, Email: u.Email})
		}
	}
	// Admin console routes (spec M1): its own origin only, the svs_admin
	// claim, a second factor; money actions check auth_time inside.
	admin := func(h func(http.ResponseWriter, *http.Request, *api.AdminUser)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'")
			if o := r.Header.Get("Origin"); o != "" && !slices.Contains(cfg.AdminOrigins, o) {
				httpx.WriteErr(r.Context(), w, httpx.Err(http.StatusForbidden, "origin_not_allowed", "the admin API answers the admin console only"))
				return
			}
			a, err := verifier.AdminFromRequest(r)
			if err != nil {
				httpx.WriteErr(r.Context(), w, httpx.ErrUnauthorized())
				return
			}
			if !a.IsAdmin {
				httpx.WriteErr(r.Context(), w, httpx.Err(http.StatusForbidden, "no_access", "This account has no access."))
				return
			}
			if !a.MFA {
				httpx.WriteErr(r.Context(), w, httpx.Err(http.StatusForbidden, "mfa_required", "sign in with your second factor"))
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 55*time.Second)
			defer cancel()
			h(w, r.WithContext(ctx), &api.AdminUser{UID: a.UID, Email: a.Email, AuthTime: a.AuthTime})
		}
	}
	adminID := func(h func(http.ResponseWriter, *http.Request, *api.AdminUser, string), key string) func(http.ResponseWriter, *http.Request, *api.AdminUser) {
		return func(w http.ResponseWriter, r *http.Request, a *api.AdminUser) { h(w, r, a, r.PathValue(key)) }
	}
	mux.HandleFunc("GET /v1/admin/cases", admin(svc.HandleAdminCases))
	mux.HandleFunc("POST /v1/admin/cases", admin(svc.HandleAdminOpenCase))
	mux.HandleFunc("GET /v1/admin/cases/{id}", admin(adminID(svc.HandleAdminCase, "id")))
	mux.HandleFunc("POST /v1/admin/cases/{id}/actions", admin(adminID(svc.HandleAdminCaseAction, "id")))
	mux.HandleFunc("GET /v1/admin/accounts/{uid}", admin(adminID(svc.HandleAdminAccount, "uid")))
	mux.HandleFunc("POST /v1/admin/accounts/{uid}/actions", admin(adminID(svc.HandleAdminAccountAction, "uid")))
	mux.HandleFunc("GET /v1/admin/disputes/summary", admin(svc.HandleAdminDisputes))
	mux.HandleFunc("GET /v1/admin/policy", admin(svc.HandleAdminPolicy))
	mux.HandleFunc("GET /v1/admin/mail-previews", admin(svc.HandleAdminMailPreviews))
	mux.HandleFunc("POST /v1/admin/reconcile", admin(svc.HandleAdminReconcile)) // M3 on demand
	mux.HandleFunc("GET /v1/admin/blocklist", admin(svc.HandleAdminBlocklist))
	mux.HandleFunc("GET /v1/admin/onboarding/headsets", admin(svc.HandleAdminOnboardingHeadsets)) // onboarding 2026-11-04
	mux.HandleFunc("POST /v1/admin/blocklist", admin(svc.HandleAdminBlocklist))

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
	mux.HandleFunc("POST /v1/billing/settle", authed(svc.HandleSettle2)) // C11 collectOutstanding
	mux.HandleFunc("GET /v1/billing/history", authed(svc.HandleBillingHistory))
	mux.HandleFunc("GET /v1/billing/invoices", authed(svc.HandleListInvoices))               // C6, P10
	mux.HandleFunc("GET /v1/billing/balance", authed(svc.HandleGetBalance))                  // v7 N13
	mux.HandleFunc("POST /v1/billing/balance/topup", authed(svc.HandleTopup))                // P17
	mux.HandleFunc("PUT /v1/billing/balance/settings", authed(svc.HandlePutBalanceSettings)) // P18, P19
	mux.HandleFunc("GET /v1/billing/balance/entries", authed(svc.HandleBalanceEntries))
	mux.HandleFunc("GET /v1/billing/usage", authed(svc.HandleUsage))
	mux.HandleFunc("POST /v1/billing/plan", authed(svc.HandleStartPlan)) // pricing 2026-11
	mux.HandleFunc("POST /v1/billing/plan/cancel", authed(svc.HandleCancelPlan))
	mux.HandleFunc("POST /v1/billing/pay-now", authed(svc.HandlePayNow))
	mux.HandleFunc("POST /v1/billing/photo-pack", authed(svc.HandlePhotoPackWithdrawn)) // 410
	mux.HandleFunc("POST /v1/billing/portal", authed(svc.HandleBillingPortal))
	// Our own Billing (spec v6.2 D4/F): methods, backup order, company.
	mux.HandleFunc("GET /v1/billing/methods", authed(svc.HandleListMethods))
	mux.HandleFunc("POST /v1/billing/methods/setup", authed(svc.HandleSetupMethod))
	mux.HandleFunc("POST /v1/billing/methods/{id}/default", authed(withID(svc.HandleSetDefaultMethod)))
	mux.HandleFunc("PUT /v1/billing/methods/order", authed(svc.HandlePutMethodOrder))
	mux.HandleFunc("DELETE /v1/billing/methods/{id}", authed(withID(svc.HandleRemoveMethod)))
	mux.HandleFunc("GET /v1/billing/company", authed(svc.HandleGetCompany))
	mux.HandleFunc("PUT /v1/billing/company", authed(svc.HandlePutCompany))
	mux.HandleFunc("POST /v1/billing/company/tax-ids", authed(svc.HandleAddTaxID))
	mux.HandleFunc("DELETE /v1/billing/company/tax-ids/{id}", authed(withID(svc.HandleDeleteTaxID)))
	mux.HandleFunc("POST /v1/account/delete", authed(svc.HandleDeleteAccount))
	mux.HandleFunc("GET /v1/account/settings", authed(svc.HandleAccountSettings))   // BL-25
	mux.HandleFunc("PATCH /v1/account/settings", authed(svc.HandleAccountSettings)) // BL-25
	mux.HandleFunc("POST /v1/events", authed(svc.HandleEvents))                     // onboarding 2026-11-04
	mux.HandleFunc("POST /v1/auth/profile", authed(func(w http.ResponseWriter, r *http.Request, _ *api.AuthedUser) {
		idh.Profile(w, r)
	}))
	mux.HandleFunc("GET /v1/pro", authed(svc.HandleProStatus))
	mux.HandleFunc("POST /v1/pro/refresh", authed(svc.HandleProRefresh))
	mux.HandleFunc("GET /v1/limits", authed(svc.HandleLimits))
	mux.HandleFunc("POST /v1/uploads", authed(svc.HandleCreateUpload))
	mux.HandleFunc("POST /v1/uploads/status", authed(svc.HandleUploadStatus))
	mux.HandleFunc("POST /v1/conversions", authed(svc.HandleCreateConversion))
	mux.HandleFunc("GET /v1/conversions", authed(svc.HandleListConversions))
	mux.HandleFunc("GET /v1/conversions/{id}", authed(withID(svc.HandleGetConversion)))
	mux.HandleFunc("GET /v1/conversions/{id}/downloads", authed(withID(svc.HandleDownloads)))
	mux.HandleFunc("POST /v1/conversions/{id}/plays", authed(withID(svc.HandleLogPlay))) // M8
	mux.HandleFunc("DELETE /v1/conversions/{id}", authed(withID(svc.HandleCancelConversion)))
	mux.HandleFunc("POST /v1/conversions/{id}/report", authed(withID(svc.HandleReportConversion)))
	mux.HandleFunc("POST /v1/conversions/{id}/pay-now", authed(withID(svc.HandleRunPayNow)))
	mux.HandleFunc("POST /v1/conversions/{id}/handoff", authed(withID(svc.HandleCreateHandoff))) // B17
	mux.HandleFunc("GET /v1/handoff/{code}", svc.HandleGetHandoff)                               // public, read-only
	mux.HandleFunc("POST /v1/handoff/{code}/pay", svc.HandleHandoffPay)                          // public

	// Pro step pipeline (web/DESIGN.md): 1 video = 1 project.
	mux.HandleFunc("POST /v1/projects", authed(svc.HandleCreateProject))
	mux.HandleFunc("GET /v1/projects", authed(svc.HandleListProjects))
	mux.HandleFunc("GET /v1/projects/{id}", authed(withID(svc.HandleGetProject)))
	mux.HandleFunc("PATCH /v1/projects/{id}", authed(withID(svc.HandleUpdateProject)))
	mux.HandleFunc("DELETE /v1/projects/{id}", authed(withID(svc.HandleArchiveProject)))
	mux.HandleFunc("POST /v1/projects/{id}/delete", authed(withID(svc.HandleDeleteProject)))
	mux.HandleFunc("POST /v1/projects/{id}/keep", authed(withID(svc.HandleKeepProject)))
	mux.HandleFunc("PATCH /v1/projects/{id}/scenes", authed(withID(svc.HandleUpdateScenes)))
	mux.HandleFunc("POST /v1/projects/{id}/depth-map", authed(withID(svc.HandleSetProjectDepthMap)))
	mux.HandleFunc("DELETE /v1/projects/{id}/depth-map", authed(withID(svc.HandleDeleteProjectDepthMap)))
	mux.HandleFunc("POST /v1/projects/{id}/analyze", authed(withID(svc.HandleRetryAnalyze)))
	mux.HandleFunc("POST /v1/projects/{id}/profile", authed(withID(svc.HandleProfileProject)))
	mux.HandleFunc("POST /v1/projects/{id}/quotes", authed(withID(svc.HandleQuoteStep)))
	mux.HandleFunc("POST /v1/projects/{id}/conversions", authed(withID(svc.HandleCreateStepConversion)))

	slog.Info("gateway listening", "port", cfg.Port, "env", cfg.Env)
	// Storage links answered to browsers that came through the relay point
	// at the China media host (mediahost); everyone else's are untouched.
	media := mediahost.New(cfg.MediaRelayOrigin, cfg.BucketName, cfg.BucketPrefix, func(r *http.Request) bool {
		_, viaRelay := ips.ClientIP(r)
		return viaRelay
	})
	handler := httpx.WithSplitCORS(cfg.CORSOrigins, cfg.AdminOrigins, "/v1/admin/", httpx.WithRequestID(media.Middleware(mux)))
	if err := http.ListenAndServe(":"+cfg.Port, handler); err != nil {
		slog.Error("server exited", "err", err)
		os.Exit(1)
	}
}
