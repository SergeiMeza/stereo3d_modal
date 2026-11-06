// Gateway entrypoint: wiring + routes. See gateway/DESIGN.md.
package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"slices"
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
	mux.HandleFunc("POST /webhooks/revenuecat", svc.HandleRevenueCatWebhook) // Pro changes from the app's stores
	// The TEST mode endpoint was registered at /webhook (found 2026-11-03:
	// every test event 404ed); both paths serve the same handler.
	mux.HandleFunc("POST /webhook", svc.HandleStripeWebhook)
	// Public price list (S3D-18): no auth, cacheable, CORS like every route.
	mux.HandleFunc("GET /v1/pricing", svc.HandlePublicPricing)
	mux.HandleFunc("POST /internal/reconcile", svc.HandleReconcile)
	// svs-backend's account-switch bookkeeping (proxy key only; 404 otherwise).
	mux.HandleFunc("GET /internal/holdings/{uid}", svc.HandleHoldings)

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
	codes := &emailcode.Service{
		Store:    emailcode.NewFirestoreStore(fsClient, cfg.Env),
		Users:    verifier,
		Sessions: idh.Client,
		Mail:     mail.NewResend(cfg.ResendAPIKey, cfg.ResetMailFrom),
	}
	ech := emailcode.NewHandlers(codes, ips)
	// Sessions without the SDK (passkey session:true, Apple/Google links)
	// and email codes for linking (/v1/account/identities).
	svc.Sessions, svc.EmailCodes = idh.Client, codes
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
			h(w, r.WithContext(ctx), &api.AuthedUser{UID: u.UID, Email: u.Email, AuthTime: u.AuthTime})
		}
	}
	// Admin console routes (spec M1): its own origin only, the svs_admin
	// claim and a passkey session (X-Admin-Session, ADR 0135; the only
	// second factor); money actions check the assertion's freshness
	// inside. adminToken (the passkey routes) needs the token
	// alone: the passkey is what they set up or prove.
	adminWith := func(secondFactor bool, h func(http.ResponseWriter, *http.Request, *api.AdminUser)) http.HandlerFunc {
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
			au, ok, serr := svc.AdminUserFor(r, a.UID, a.Email, a.AuthTime)
			if secondFactor && serr != nil { // session_expired | invalid_session: the console drops its token
				e := httpx.Err(http.StatusUnauthorized, api.SessionErrCode(serr), "Your admin session ended. Confirm with your passkey again.")
				e.Details = map[string]any{"method": "passkey"}
				httpx.WriteErr(r.Context(), w, e)
				return
			}
			if secondFactor && !ok {
				e := httpx.Err(http.StatusUnauthorized, "session_required", "Confirm with your passkey.")
				e.Details = map[string]any{"methods": []string{"passkey"}}
				httpx.WriteErr(r.Context(), w, e)
				return
			}
			ctx, cancel := context.WithTimeout(r.Context(), 55*time.Second)
			defer cancel()
			h(w, r.WithContext(ctx), au)
		}
	}
	admin := func(h func(http.ResponseWriter, *http.Request, *api.AdminUser)) http.HandlerFunc {
		return adminWith(true, h)
	}
	adminToken := func(h func(http.ResponseWriter, *http.Request, *api.AdminUser)) http.HandlerFunc {
		return adminWith(false, h)
	}
	adminID := func(h func(http.ResponseWriter, *http.Request, *api.AdminUser, string), key string) func(http.ResponseWriter, *http.Request, *api.AdminUser) {
		return func(w http.ResponseWriter, r *http.Request, a *api.AdminUser) { h(w, r, a, r.PathValue(key)) }
	}
	// Customer passkeys (ADR 0136): sign-in is unauthenticated.
	mux.HandleFunc("POST /v1/auth/passkey/options", svc.HandleCustomerPasskeySignInOptions)
	mux.HandleFunc("POST /v1/auth/passkey/verify", svc.HandleCustomerPasskeySignInVerify)
	mux.HandleFunc("GET /v1/account/passkeys", authed(svc.HandleCustomerPasskeys))
	mux.HandleFunc("POST /v1/account/passkeys/register/options", authed(svc.HandleCustomerPasskeyRegisterOptions))
	mux.HandleFunc("POST /v1/account/passkeys/register/verify", authed(svc.HandleCustomerPasskeyRegisterVerify))
	cpkID := func(h func(http.ResponseWriter, *http.Request, *api.AuthedUser, string)) func(http.ResponseWriter, *http.Request, *api.AuthedUser) {
		return func(w http.ResponseWriter, r *http.Request, u *api.AuthedUser) {
			id := r.PathValue("id")
			if !api.ValidPasskeyID(id) {
				httpx.WriteErr(r.Context(), w, httpx.ErrNotFound("passkey"))
				return
			}
			h(w, r, u, id)
		}
	}
	mux.HandleFunc("PATCH /v1/account/passkeys/{id}", authed(cpkID(svc.HandleCustomerPasskeyRename)))
	mux.HandleFunc("DELETE /v1/account/passkeys/{id}", authed(cpkID(svc.HandleCustomerPasskeyDelete)))
	// Linked sign-in methods, server-side (the app's sign-in contract).
	mux.HandleFunc("GET /v1/account/identities", authed(svc.HandleIdentities))
	mux.HandleFunc("POST /v1/account/identities/link", authed(svc.HandleLinkIdentity))
	mux.HandleFunc("DELETE /v1/account/identities/{provider}", authed(func(w http.ResponseWriter, r *http.Request, u *api.AuthedUser) {
		svc.HandleUnlinkIdentity(w, r, u, r.PathValue("provider"))
	}))
	mux.HandleFunc("GET /v1/admin/passkey-adoption", admin(svc.HandleAdminPasskeyAdoption))

	// Admin passkeys and sessions (ADR 0135).
	mux.HandleFunc("POST /v1/admin/passkeys/register/options", adminToken(svc.HandlePasskeyRegisterOptions))
	mux.HandleFunc("POST /v1/admin/passkeys/register/verify", adminToken(svc.HandlePasskeyRegisterVerify))
	mux.HandleFunc("GET /v1/admin/passkeys", adminToken(svc.HandleAdminPasskeys))
	mux.HandleFunc("DELETE /v1/admin/passkeys/{id}", adminToken(func(w http.ResponseWriter, r *http.Request, a *api.AdminUser) {
		id := r.PathValue("id")
		if !api.ValidPasskeyID(id) {
			httpx.WriteErr(r.Context(), w, httpx.ErrNotFound("passkey"))
			return
		}
		svc.HandleAdminDeletePasskey(w, r, a, id)
	}))
	mux.HandleFunc("POST /v1/admin/session/options", adminToken(svc.HandleAdminSessionOptions))
	mux.HandleFunc("POST /v1/admin/session/verify", adminToken(svc.HandleAdminSessionVerify))
	mux.HandleFunc("GET /v1/admin/cases", admin(svc.HandleAdminCases))
	mux.HandleFunc("POST /v1/admin/cases", admin(svc.HandleAdminOpenCase))
	mux.HandleFunc("GET /v1/admin/cases/{id}", admin(adminID(svc.HandleAdminCase, "id")))
	mux.HandleFunc("POST /v1/admin/cases/{id}/actions", admin(adminID(svc.HandleAdminCaseAction, "id")))
	mux.HandleFunc("GET /v1/admin/accounts", admin(svc.HandleAdminAccountSearch)) // ?q= email prefix or uid (BL-29)
	mux.HandleFunc("GET /v1/admin/efws", admin(svc.HandleAdminOpenEFWs))          // open early fraud warnings, with or without a case (BL-29)
	mux.HandleFunc("GET /v1/admin/grants", admin(svc.HandleAdminAllGrants))       // every Grant Pro grant (BL-29)
	mux.HandleFunc("GET /v1/admin/runs/{id}", admin(func(w http.ResponseWriter, r *http.Request, a *api.AdminUser) {
		id := r.PathValue("id")
		if !api.ValidResourceID(id) {
			httpx.WriteErr(r.Context(), w, httpx.Err(http.StatusNotFound, "run_not_found", "No run with that ID."))
			return
		}
		svc.HandleAdminRun(w, r, a, id)
	}))
	mux.HandleFunc("GET /v1/admin/accounts/{uid}", admin(adminID(svc.HandleAdminAccount, "uid")))
	mux.HandleFunc("POST /v1/admin/accounts/{uid}/actions", admin(adminID(svc.HandleAdminAccountAction, "uid")))
	mux.HandleFunc("GET /v1/admin/accounts/{uid}/grants", admin(adminID(svc.HandleAdminGrants, "uid")))    // Grant Pro 2026-11-04
	mux.HandleFunc("POST /v1/admin/accounts/{uid}/grants", admin(adminID(svc.HandleAdminGrantPro, "uid"))) // fresh sign-in
	mux.HandleFunc("DELETE /v1/admin/accounts/{uid}/grants/{id}", admin(func(w http.ResponseWriter, r *http.Request, a *api.AdminUser) {
		id := r.PathValue("id")
		if !api.ValidResourceID(id) {
			httpx.WriteErr(r.Context(), w, httpx.ErrNotFound("grant"))
			return
		}
		svc.HandleAdminRevokeGrant(w, r, a, r.PathValue("uid"), id)
	}))
	mux.HandleFunc("GET /v1/admin/disputes/summary", admin(svc.HandleAdminDisputes))
	mux.HandleFunc("GET /v1/admin/policy", admin(svc.HandleAdminPolicy))
	mux.HandleFunc("GET /v1/admin/mail-previews", admin(svc.HandleAdminMailPreviews))
	mux.HandleFunc("POST /v1/admin/reconcile", admin(svc.HandleAdminReconcile)) // M3 on demand
	mux.HandleFunc("GET /v1/admin/blocklist", admin(svc.HandleAdminBlocklist))
	mux.HandleFunc("GET /v1/admin/onboarding/headsets", admin(svc.HandleAdminOnboardingHeadsets))    // onboarding 2026-11-04
	mux.HandleFunc("GET /v1/admin/plans/surfaces", admin(svc.HandleAdminPlansSurfaces))              // plans surfaces 2026-11-04
	mux.HandleFunc("GET /v1/admin/feedback", admin(svc.HandleAdminFeedback))                         // web and app feedback, read only
	mux.HandleFunc("GET /v1/admin/feedback/seen", admin(svc.HandleAdminFeedbackSeen))                // BL-29
	mux.HandleFunc("POST /v1/admin/feedback/seen", admin(svc.HandleAdminFeedbackSeenSet))            // BL-29
	mux.HandleFunc("GET /v1/admin/onboarding/business_funnel", admin(svc.HandleAdminBusinessFunnel)) // business setup 2026-11-04
	mux.HandleFunc("POST /v1/admin/blocklist", admin(svc.HandleAdminBlocklist))

	withID := func(h func(http.ResponseWriter, *http.Request, *api.AuthedUser, string)) func(http.ResponseWriter, *http.Request, *api.AuthedUser) {
		return func(w http.ResponseWriter, r *http.Request, u *api.AuthedUser) {
			id := r.PathValue("id")
			if !api.ValidResourceID(id) {
				httpx.WriteErr(r.Context(), w, httpx.ErrNotFound("conversion"))
				return
			}
			h(w, r, u, id)
		}
	}
	// "Get another format" for a finished run (ADR 0137).
	mux.HandleFunc("GET /v1/runs/{id}/formats", authed(withID(svc.HandleRunFormats)))
	mux.HandleFunc("POST /v1/runs/{id}/formats", authed(withID(svc.HandleRunFormatAdd)))

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
	mux.HandleFunc("POST /v1/plans/preview-change", authed(svc.HandlePreviewPlanChange)) // plan changes 2026-11-04
	mux.HandleFunc("POST /v1/plans/change", authed(svc.HandlePlanChange))
	mux.HandleFunc("DELETE /v1/plans/scheduled-change", authed(svc.HandleCancelScheduledChange))
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
	// Stripe tax id ids (txi_…) aren't our 12-hex ids: their own check.
	mux.HandleFunc("DELETE /v1/billing/company/tax-ids/{id}", authed(func(w http.ResponseWriter, r *http.Request, u *api.AuthedUser) {
		id := r.PathValue("id")
		if !api.ValidTaxIDRef(id) {
			httpx.WriteErr(r.Context(), w, httpx.ErrNotFound("tax id"))
			return
		}
		svc.HandleDeleteTaxID(w, r, u, id)
	}))
	mux.HandleFunc("POST /v1/account/delete", authed(svc.HandleDeleteAccount))
	mux.HandleFunc("GET /v1/account/delete", authed(svc.HandleDeletePreview)) // what a delete would do
	mux.HandleFunc("POST /v1/account/plan/cancel", authed(svc.HandleAccountPlanCancel))
	mux.HandleFunc("POST /v1/account/plan/resume", authed(svc.HandleAccountPlanResume))
	mux.HandleFunc("GET /v1/account/settings", authed(svc.HandleAccountSettings))   // BL-25
	mux.HandleFunc("PATCH /v1/account/settings", authed(svc.HandleAccountSettings)) // BL-25
	mux.HandleFunc("POST /v1/events", authed(svc.HandleEvents))                     // onboarding 2026-11-04
	mux.HandleFunc("POST /v1/contact", authed(svc.HandleContact))                   // sales enquiries 2026-11-04
	// Feedback: signed in or out (an invalid token is still 401).
	mux.HandleFunc("POST /v1/feedback", func(w http.ResponseWriter, r *http.Request) {
		var user *api.AuthedUser
		if r.Header.Get("Authorization") != "" {
			u, err := verifier.FromRequest(r)
			if err != nil {
				httpx.WriteErr(r.Context(), w, httpx.ErrUnauthorized())
				return
			}
			user = &api.AuthedUser{UID: u.UID, Email: u.Email}
		}
		svc.HandleFeedback(w, r, user)
	})
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
	handler := httpx.WithSplitCORS(cfg.CORSOrigins, cfg.AdminOrigins, "/v1/admin/", httpx.WithRequestID(httpx.WithTrustedProxy(cfg.SVSProxyKey, media.Middleware(mux))))
	if err := http.ListenAndServe(":"+cfg.Port, handler); err != nil {
		slog.Error("server exited", "err", err)
		os.Exit(1)
	}
}
