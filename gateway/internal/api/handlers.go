package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"path"
	"slices"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/probe"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

var (
	allowedPresets = []string{"draft", "1080p", "qhd", "3k", "4k"}
	allowedFormats = []string{"sbs", "half_sbs", "tb", "half_tb", "anaglyph", "mvhevc"}
	allowedExts    = []string{".mp4", ".mov", ".m4v", ".webm", ".png", ".jpg", ".jpeg", ".heic"}
	videoExts      = []string{".mp4", ".mov", ".m4v", ".webm"}
)

// maxDisplacement is deliberately tighter than the Modal API's (0, 0.1] rail;
// beyond ~0.03 output is uncomfortable, not a user-facing knob worth exposing.
const maxDisplacement = 0.03

// ------------------------------------------------------------- customers

// ensureCustomerID returns the caller's Stripe customer id, creating the
// customer (and the uid → customer mapping) on first use.
func (s *Service) ensureCustomerID(ctx context.Context, user *AuthedUser) (string, error) {
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	if err == nil {
		return cust.StripeCustomerID, nil
	}
	if !errors.Is(err, store.ErrNotFound) {
		// A transient read error must NOT mint a new Stripe customer — that
		// would overwrite the mapping and orphan saved payment methods.
		return "", err
	}
	id, err := s.Stripe.EnsureCustomer(user.UID, user.Email)
	if err != nil {
		return "", err
	}
	err = s.Store.PutCustomer(ctx, user.UID, &store.Customer{
		StripeCustomerID: id, Email: user.Email, CreatedAt: time.Now().UTC(),
	})
	if errors.Is(err, store.ErrAlreadyExists) {
		// Lost a concurrent race — the other request's customer wins.
		if cust, gerr := s.Store.GetCustomer(ctx, user.UID); gerr == nil {
			return cust.StripeCustomerID, nil
		}
	}
	if err != nil {
		return "", err
	}
	return id, nil
}

// POST /v1/customers — ensure a Stripe customer exists for the caller.
func (s *Service) HandleEnsureCustomer(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	id, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.WriteOK(w, map[string]string{"customer_id": id})
}

// POST /v1/billing/portal — a Stripe customer-portal session so the user
// can manage saved payment methods and receipts (the /account page's
// "Manage billing" button). Ensures the billing profile first, so it works
// for accounts that predate the ensure-at-sign-in client flow.
func (s *Service) HandleBillingPortal(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		ReturnURL string `json:"return_url"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	if !strings.HasPrefix(req.ReturnURL, "https://") && !strings.HasPrefix(req.ReturnURL, "http://") {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("return_url must be an absolute http(s) URL"))
		return
	}
	id, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	url, err := s.Stripe.BillingPortalURL(id, req.ReturnURL)
	if err != nil {
		httpx.Log(ctx).Error("billing portal session failed", "uid", user.UID, "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "could not open the billing portal; try again"))
		return
	}
	httpx.WriteOK(w, map[string]string{"url": url})
}

// ------------------------------------------------------------- uploads

// POST /v1/uploads {filename, content_type} → signed PUT URL + gcs_key.
func (s *Service) HandleCreateUpload(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		Filename    string `json:"filename"`
		ContentType string `json:"content_type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	ext := strings.ToLower(path.Ext(req.Filename))
	if !slices.Contains(allowedExts, ext) {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("unsupported file type "+ext))
		return
	}
	// The upload id doubles as the conversion id the client passes back.
	id := store.NewID()
	key := s.GCS.UploadKey(user.UID, id, ext)
	url, err := s.GCS.SignedPutURL(key, req.ContentType, uploadURLTTL)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.WriteOK(w, map[string]any{
		"upload_id":  id,
		"gcs_key":    key,
		"upload_url": url,
		"headers":    map[string]string{"Content-Type": req.ContentType},
		"expires_in": int(uploadURLTTL.Seconds()),
	})
}

// ------------------------------------------------------------- conversions

type createConversionReq struct {
	GCSKey       string   `json:"gcs_key"`
	Kind         string   `json:"kind"` // video | image
	Preset       string   `json:"preset"`
	Formats      []string `json:"formats"`
	Displacement float64  `json:"displacement"`
	TargetFPS    float64  `json:"target_fps"`
	// Frame-exact half-open trim [from_frame, to_frame) — the API takes
	// frames, never seconds (frame doctrine, web/DESIGN.md).
	FromFrame  int    `json:"from_frame"`
	ToFrame    int    `json:"to_frame"`
	AppVersion string `json:"app_version"`
	Platform   string `json:"platform"`
}

// validate clamps and whitelists — anything not validated here never reaches
// Modal (see modalBody).
func (req *createConversionReq) validate() error {
	if req.GCSKey == "" {
		return httpx.ErrInvalid("gcs_key is required (from POST /v1/uploads)")
	}
	// Kind is derived from the extension, never trusted from the client: a
	// video priced as an image (flat 50¢) would be free GPU burn.
	ext := strings.ToLower(path.Ext(req.GCSKey))
	derived := "image"
	if slices.Contains(videoExts, ext) {
		derived = "video"
	}
	if req.Kind != "" && req.Kind != derived {
		return httpx.ErrInvalid("kind does not match the uploaded file type")
	}
	req.Kind = derived
	if req.Preset == "" {
		req.Preset = "1080p"
	}
	if !slices.Contains(allowedPresets, req.Preset) {
		return httpx.ErrInvalid("preset must be one of " + strings.Join(allowedPresets, "|"))
	}
	if len(req.Formats) == 0 {
		req.Formats = []string{"mvhevc", "half_sbs"}
	}
	for _, f := range req.Formats {
		if !slices.Contains(allowedFormats, f) {
			return httpx.ErrInvalid("unsupported format " + f)
		}
	}
	if req.Displacement < 0 || req.Displacement > maxDisplacement {
		return httpx.ErrInvalid("displacement must be in (0, 0.03]")
	}
	if req.TargetFPS < 0 || req.TargetFPS > 120 {
		return httpx.ErrInvalid("target_fps must be in (0, 120]")
	}
	if req.FromFrame < 0 || req.ToFrame < 0 || (req.ToFrame > 0 && req.ToFrame <= req.FromFrame) {
		return httpx.ErrInvalid("invalid trim range: need 0 <= from_frame < to_frame")
	}
	return nil
}

// POST /v1/conversions — probe → quote → PaymentIntent hold → record.
func (s *Service) HandleCreateConversion(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()

	// Idempotent retry: same user + same Idempotency-Key returns the
	// original — INCLUDING fresh payment-sheet material while it's still
	// payable (the lost-response case is exactly what the header is for).
	idemKey := r.Header.Get("Idempotency-Key")
	if idemKey != "" {
		prior, err := s.Store.FindByIdemKey(ctx, user.UID, idemKey)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			httpx.WriteErr(ctx, w, err)
			return
		}
		if err == nil {
			var sheet any
			if prior.State == store.StateCreated {
				if ps, perr := s.Stripe.PaymentSheetFor(prior.Stripe.CustomerID, prior.Stripe.PaymentIntentID); perr == nil {
					sheet = ps
				}
			}
			httpx.WriteOK(w, s.conversionResponse(prior, sheet))
			return
		}
	}

	var req createConversionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	if err := req.validate(); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if !s.GCS.InPrefix(req.GCSKey) || !strings.Contains(req.GCSKey, "/users/"+user.UID+"/") {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("gcs_key is not one of your uploads"))
		return
	}

	rates := s.Pricing.Rates(ctx)
	if n, err := s.Store.CountActiveForUser(ctx, user.UID); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	} else if n >= rates.MaxActivePerUser {
		httpx.WriteErr(ctx, w, httpx.ErrConflict("too many active conversions; wait for one to finish"))
		return
	}

	// Probe the uploaded object (size + streams) — the only trusted price input.
	size, err := s.GCS.Stat(ctx, req.GCSKey)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("upload not found; PUT the file to the signed URL first"))
		return
	}
	if size > rates.MaxSourceBytes {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("source file too large"))
		return
	}
	probeURL, err := s.GCS.SignedGetURL(req.GCSKey, 10*time.Minute)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}

	src := store.Source{GCSKey: req.GCSKey, Bytes: size}
	var quote *store.Quote
	if req.Kind == "video" {
		media, err := probe.Video(ctx, probeURL)
		if err != nil {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("could not read video metadata: upload a valid video file"))
			return
		}
		if media.DurationS > rates.MaxDurationS {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("video exceeds the maximum supported duration"))
			return
		}
		src.DurationS, src.Frames, src.FPS = media.DurationS, media.Frames, media.FPS
		src.Width, src.Height = media.Width, media.Height

		billable, berr := billableSeconds(media.Frames, media.FPS, req.FromFrame, req.ToFrame)
		if berr != nil {
			httpx.WriteErr(ctx, w, berr)
			return
		}
		q, err := s.Pricing.QuoteVideo(ctx, pricing.VideoInputs{
			Preset: req.Preset, BillableS: billable,
			Width: media.Width, Height: media.Height, FPS: media.FPS,
		})
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		quote = &store.Quote{AmountCents: q.AmountCents, Currency: q.Currency, RateVersion: q.RateVersion, Breakdown: q.Breakdown}
	} else {
		media, err := probe.Image(ctx, probeURL)
		if err != nil {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("could not read image metadata: upload a valid image file"))
			return
		}
		src.Width, src.Height = media.Width, media.Height
		q, err := s.Pricing.QuoteImage(ctx)
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		quote = &store.Quote{AmountCents: q.AmountCents, Currency: q.Currency, RateVersion: q.RateVersion, Breakdown: q.Breakdown}
	}

	// Conversion id: reuse the upload id so source path, conversion, Stripe
	// metadata, and logs all share one identifier. Re-running a conversion on
	// the same upload (different preset, etc.) gets a fresh id. The id must be
	// final BEFORE the Stripe hold is created — PI metadata carries it and the
	// webhook routes by it.
	id := uploadIDFromKey(req.GCSKey)
	if id == "" {
		id = store.NewID()
	} else if _, err := s.Store.GetConversion(ctx, id); err == nil {
		id = store.NewID()
	}

	conv := &store.Conversion{
		ID: id, UID: user.UID, Env: s.Cfg.Env, Kind: req.Kind,
		Client: store.Client{AppVersion: req.AppVersion, Platform: req.Platform},
		Source: src,
		Params: store.Params{
			Preset: req.Preset, Formats: req.Formats, Displacement: req.Displacement,
			TargetFPS: req.TargetFPS, FromFrame: req.FromFrame, ToFrame: req.ToFrame,
		},
		Quote:   *quote,
		IdemKey: idemKey,
	}
	sheet, err := s.createPaidConversion(ctx, user, conv)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.WriteOK(w, s.conversionResponse(conv, sheet))
}

// billableSeconds derives the priced duration from frame-exact trim.
func billableSeconds(frames int, fps float64, fromFrame, toFrame int) (float64, *httpx.APIError) {
	if fps <= 0 || frames <= 0 {
		return 0, httpx.ErrInvalid("source has no readable duration")
	}
	end := frames
	if toFrame > 0 && toFrame < end {
		end = toFrame
	}
	if fromFrame >= end {
		return 0, httpx.ErrInvalid("trim range is outside the video")
	}
	return float64(end-fromFrame) / fps, nil
}

// createPaidConversion finalizes a conversion record + its Stripe hold.
// conv must arrive with ID, UID, Env, Kind, Source, Params, Quote (and any
// project fields) set. On failure the hold is canceled and the analyze
// credit restored — no orphaned money.
func (s *Service) createPaidConversion(ctx context.Context, user *AuthedUser, conv *store.Conversion) (*stripex.PaymentSheet, error) {
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	if errors.Is(err, store.ErrNotFound) {
		s.restoreCredit(ctx, conv)
		return nil, httpx.ErrInvalid("no billing profile; call POST /v1/customers first")
	}
	if err != nil {
		s.restoreCredit(ctx, conv)
		return nil, err
	}
	sheet, err := s.Stripe.CreateHold(cust.StripeCustomerID, conv.Quote.AmountCents, conv.Quote.Currency, stripex.Job{
		ConversionID: conv.ID,
		UID:          user.UID,
		Description:  jobDescription(conv),
		ReceiptEmail: user.Email,
	})
	if err != nil {
		httpx.Log(ctx).Error("stripe hold failed", "conversion_id", conv.ID, "err", err)
		s.restoreCredit(ctx, conv)
		return nil, httpx.Err(http.StatusBadGateway, "payment_error", "could not start payment; try again")
	}
	conv.State = store.StateCreated
	conv.Stripe = store.Stripe{CustomerID: cust.StripeCustomerID, PaymentIntentID: sheet.PaymentIntentID}
	if err := s.Store.CreateConversion(ctx, conv); err != nil {
		// Don't leave an orphaned hold (or a consumed credit) behind a
		// failed write.
		_ = s.Stripe.CancelHold(sheet.PaymentIntentID)
		s.restoreCredit(ctx, conv)
		return nil, err
	}
	httpx.Log(ctx).Info("conversion created",
		"conversion_id", conv.ID, "uid", user.UID, "kind", conv.Kind,
		"step", conv.Step, "project_id", conv.ProjectID,
		"amount_cents", conv.Quote.AmountCents, "payment_intent", sheet.PaymentIntentID)
	return sheet, nil
}

// GET /v1/conversions/{id}
func (s *Service) HandleGetConversion(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	conv, err := s.ownedConversion(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	// Read-through poll keeps interactive polling fresh between sweeps.
	if conv.State == store.StateProcessing &&
		(conv.Modal.LastPolledAt == nil || time.Since(*conv.Modal.LastPolledAt) > pollStaleness) {
		if refreshed, err := s.refreshFromModal(ctx, conv); err == nil && refreshed != nil {
			conv = refreshed
		}
	}
	httpx.WriteOK(w, s.conversionResponse(conv, nil))
}

// GET /v1/conversions
func (s *Service) HandleListConversions(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	convs, err := s.Store.ListUserConversions(ctx, user.UID, 50)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	out := make([]map[string]any, 0, len(convs))
	for _, c := range convs {
		out = append(out, s.conversionResponse(c, nil))
	}
	httpx.WriteOK(w, map[string]any{"conversions": out})
}

// GET /v1/conversions/{id}/downloads — signed GET URLs for outputs.
func (s *Service) HandleDownloads(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	conv, err := s.ownedConversion(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if conv.State != store.StateSucceeded {
		httpx.WriteErr(ctx, w, httpx.ErrConflict("conversion has no outputs yet"))
		return
	}
	if gateErr := downloadPaymentGate(conv); gateErr != nil {
		httpx.WriteErr(ctx, w, gateErr)
		return
	}
	urls := map[string]string{}
	for name, key := range conv.Outputs {
		u, err := s.GCS.SignedGetURL(key, downloadTTL)
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		urls[name] = u
	}
	httpx.WriteOK(w, map[string]any{
		"downloads":  urls,
		"expires_in": int(downloadTTL.Seconds()),
	})
}

// downloadPaymentGate blocks output downloads for a conversion whose
// automatic charge FAILED (pi_status charge_failed): the work succeeded but
// the money never arrived, so the deliverables stay locked until
// POST /v1/billing/settle clears the debt. Deliberately narrow — the
// normal post-success states (capture_pending while the reconciler captures
// a hold, charge_pending while a charge is in flight, succeeded) and
// legacy/free conversions with no payment intent all pass, so downloads
// never flicker locked during ordinary settlement. Same 402 machine code
// the create path uses (billing_overdue), so the web client routes to the
// existing settle flow.
func downloadPaymentGate(conv *store.Conversion) *httpx.APIError {
	if conv.Stripe.PIStatus == store.PIChargeFailed || conv.Stripe.PIStatus == store.PICaptureFailed {
		return httpx.Err(http.StatusPaymentRequired, "billing_overdue",
			"the payment for this conversion failed — settle your balance before downloading")
	}
	return nil
}

// cancelWindow: a job may only be canceled within this long of its Modal
// submission. Past it the GPU spend is committed — the run settles (and
// bills) normally. Conversions not yet submitted (payment hold pending)
// stay cancelable indefinitely so users are never trapped with a hold.
const cancelWindow = time.Minute

var errCancelWindowClosed = errors.New("cancel window closed")

// DELETE /v1/conversions/{id} — cancel job + release hold.
func (s *Service) HandleCancelConversion(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	conv, err := s.ownedConversion(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if store.IsTerminal(conv.State) {
		httpx.WriteOK(w, s.conversionResponse(conv, nil))
		return
	}
	// Claim the cancel via the state machine FIRST — if the job just settled
	// (e.g. reconciler captured the hold a moment ago) this conflicts and we
	// return the terminal state instead of touching the money. The
	// cancel_pending marker makes the hold release crash-safe (reconciler
	// sweeps it), and releaseHold is the one place that touches the PI.
	// The cancel-window check runs INSIDE the transaction so a submit that
	// lands between our read and the claim can't be canceled past its window.
	updated, err := s.Store.Transition(ctx, id, store.ActiveStates, func(c *store.Conversion) error {
		if c.Modal.SubmittedAt != nil && time.Since(*c.Modal.SubmittedAt) > cancelWindow {
			return errCancelWindowClosed
		}
		c.State = store.StateCanceled
		c.Stripe.PIStatus = store.PICancelPending
		return nil
	})
	if errors.Is(err, errCancelWindowClosed) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "cancel_window_closed",
			"this job has been running for over a minute and can no longer be canceled"))
		return
	}
	if errors.Is(err, store.ErrStateConflict) {
		if current, gerr := s.Store.GetConversion(ctx, id); gerr == nil {
			httpx.WriteOK(w, s.conversionResponse(current, nil))
			return
		}
	}
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	// Use the POST-transition snapshot: the job may have been submitted
	// between our read and the transition commit.
	if updated.Modal.JobID != "" {
		if err := s.Modal.CancelJob(ctx, updated.Modal.JobID); err != nil {
			httpx.Log(ctx).Warn("modal cancel failed", "conversion_id", id, "err", err)
		}
	}
	if released, rerr := s.releaseHold(ctx, updated); rerr == nil && released != nil {
		updated = released
	}
	httpx.Log(ctx).Info("conversion canceled", "conversion_id", id, "uid", user.UID)
	httpx.WriteOK(w, s.conversionResponse(updated, nil))
}

// ---------------------------------------------------------------- helpers

type AuthedUser struct {
	UID   string
	Email string
}

func (s *Service) ownedConversion(ctx context.Context, user *AuthedUser, id string) (*store.Conversion, error) {
	conv, err := s.Store.GetConversion(ctx, id)
	if errors.Is(err, store.ErrNotFound) {
		return nil, httpx.ErrNotFound("conversion")
	}
	if err != nil {
		return nil, err
	}
	// 404 (not 403) for other users' conversions — don't confirm existence.
	if conv.UID != user.UID {
		return nil, httpx.ErrNotFound("conversion")
	}
	return conv, nil
}

// conversionResponse is the single client-facing serialization. Firestore
// internals (Stripe ids, internal errors, raw keys) stay server-side.
func (s *Service) conversionResponse(c *store.Conversion, sheet any) map[string]any {
	resp := map[string]any{
		"conversion_id": c.ID,
		"state":         c.State,
		"kind":          c.Kind,
		"params":        c.Params,
	}
	if c.ProjectID != "" {
		resp["project_id"] = c.ProjectID
		resp["step"] = c.Step
		resp["scenes_version"] = c.ScenesVer
	}
	resp["quote"] = map[string]any{
		"amount_cents": c.Quote.AmountCents,
		"currency":     c.Quote.Currency,
		"breakdown":    c.Quote.Breakdown,
	}
	resp["progress"] = c.Modal.Progress
	resp["stage"] = c.Modal.Stage
	resp["eta_seconds"] = c.Modal.ETASeconds
	// Once submitted, cancel is only allowed for cancelWindow — tell the
	// client when the button should disappear. Absent before submission
	// (always cancelable) and on terminal states (nothing to cancel).
	if !store.IsTerminal(c.State) && c.Modal.SubmittedAt != nil {
		resp["cancelable_until"] = c.Modal.SubmittedAt.Add(cancelWindow).Format(time.RFC3339)
	}
	resp["created_at"] = c.CreatedAt.Format(time.RFC3339)
	resp["updated_at"] = c.UpdatedAt.Format(time.RFC3339)
	if c.State == store.StateSucceeded {
		names := make([]string, 0, len(c.Outputs))
		for name := range c.Outputs {
			names = append(names, name)
		}
		slices.Sort(names)
		resp["outputs"] = names // fetch URLs via /downloads
	}
	if c.Error != nil {
		resp["error"] = map[string]string{"code": c.Error.Code, "message": c.Error.UserMessage}
	}
	// Auto-billed conversions surface how the money went so the client can
	// react without touching Stripe ids: a pending 3DS challenge on the hold
	// (auto_hold, state=created) carries the client_secret for the saved-card
	// confirm; succeeded runs report the charge/capture outcome.
	switch c.Stripe.Mode {
	case store.BillingModeAuto, store.BillingModeAutoHold:
		if c.State == store.StateCreated && c.Stripe.ClientSecret != "" {
			resp["billing"] = map[string]any{
				"status":          "requires_action",
				"client_secret":   c.Stripe.ClientSecret,
				"publishable_key": s.Stripe.PublishableKey,
			}
		}
		if c.State == store.StateSucceeded {
			switch c.Stripe.PIStatus {
			case store.PISucceeded:
				resp["billing"] = map[string]any{"status": "charged", "charged_cents": c.Stripe.CapturedCents}
			case store.PIChargeFailed, store.PICaptureFailed:
				resp["billing"] = map[string]any{"status": "charge_failed"}
			default:
				resp["billing"] = map[string]any{"status": "charge_pending"}
			}
		}
	}
	if sheet != nil {
		resp["payment"] = sheet
	}
	return resp
}

// uploadIDFromKey extracts the upload id from ".../users/{uid}/{id}/source.ext".
func uploadIDFromKey(key string) string {
	parts := strings.Split(key, "/")
	if len(parts) < 2 {
		return ""
	}
	return parts[len(parts)-2]
}
