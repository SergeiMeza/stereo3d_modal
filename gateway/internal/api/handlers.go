package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path"
	"slices"
	"strings"
	"time"

	"cloud.google.com/go/storage"
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

// §6 source rails (docs/MOBILE.md; published via GET /v1/limits): reject
// only what genuinely breaks decode; oversized-but-decodable input is
// downscaled by preprocess, over-fps input auto-decimated.
const (
	maxSourceWidth  = 7680
	maxSourceHeight = 4320
	maxSourceFPS    = 120
	autoDecimateFPS = 60.0
)

// ------------------------------------------------------------- customers

// ensureCustomerID returns the caller's Stripe customer id, creating the
// customer (and the uid → customer mapping) on first use.
func (s *Service) ensureCustomerID(ctx context.Context, user *AuthedUser) (string, error) {
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	if err == nil && cust.StripeCustomerID != "" {
		return cust.StripeCustomerID, nil
	}
	if err == nil {
		// A record without a customer (a restored or moved plan landed
		// first): the account's own customer is made now; the plan's
		// subscription stays where it is.
		id, err := s.Stripe.EnsureCustomer(user.UID, firstNonEmpty(cust.Email, user.Email))
		if err != nil {
			return "", err
		}
		if _, err := s.Store.UpdateCustomer(ctx, user.UID, func(c *store.Customer) error {
			if c.StripeCustomerID == "" {
				c.StripeCustomerID = id
			}
			id = c.StripeCustomerID
			return nil
		}); err != nil {
			return "", err
		}
		return id, nil
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
	// Only a live account opens its own customer's portal: never a deleted
	// one, and not while a plan moved off this account still runs on this
	// customer (the portal could resume it on this card for the other
	// account). Cards are managed in Billing meanwhile.
	if s.refusedForDeletion(ctx, w, user.UID) {
		return
	}
	if cust, err := s.Store.GetCustomer(ctx, user.UID); err == nil && cust.PlanMovedSub != "" {
		if sub, err := s.Stripe.GetSubscription(cust.PlanMovedSub); err != nil || sub.Live() {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "portal_unavailable",
				"Your plan moved to another account, so the billing portal is closed until it ends. Manage your cards in Billing."))
			return
		}
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

// POST /v1/uploads {filename, content_type[, resumable, method, bytes]} →
// upload ticket. With bytes, a file over the cap of method (none = classic,
// S3D-42) is refused before anything is uploaded; project creation checks
// the stored object again either way.
//
// By default the ticket is one signed PUT URL for the whole file. With
// resumable: true (the web app in China mode, whose relay caps a request
// body at 25 MB) the gateway opens a resumable upload session for the same
// key and content type and answers its URL with resumable: true; the client
// PUTs chunks to it with Content-Range. Either way the object lands at
// gcs_key and the next step Stats it as before.
func (s *Service) HandleCreateUpload(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		Filename    string `json:"filename"`
		ContentType string `json:"content_type"`
		Resumable   bool   `json:"resumable"`
		Method      string `json:"method"`
		Bytes       int64  `json:"bytes"`
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
	if req.Bytes > 0 {
		method, merr := s.resolveMethod(req.Method)
		if merr != nil {
			httpx.WriteErr(ctx, w, merr)
			return
		}
		if serr := sourceBytesError(s.Pricing.Rates(ctx), req.Bytes, method); serr != nil {
			httpx.WriteErr(ctx, w, serr)
			return
		}
		if req.Method != "" { // web uploads name their method (B14 is web-only)
			if lerr := s.checkNewProjectRoom(ctx, user.UID, req.Bytes); lerr != nil {
				httpx.WriteErr(ctx, w, lerr)
				return
			}
		}
	}
	// The upload id doubles as the conversion id the client passes back.
	id := store.NewID()
	key := s.GCS.UploadKey(user.UID, id, ext)
	if name := cleanFilename(req.Filename); name != "" && slices.Contains(videoExts, ext) && s.Store != nil {
		// the project made from it shows the device's file name
		if err := s.Store.PutUploadName(ctx, id, user.UID, name); err != nil {
			httpx.Log(ctx).Warn("upload name not kept", "upload_id", id, "err", err)
		}
	}
	if req.Resumable {
		session, err := s.GCS.StartResumableUpload(ctx, key, req.ContentType, r.Header.Get("Origin"))
		if err != nil {
			httpx.Log(ctx).Error("resumable upload session failed", "uid", user.UID, "upload_id", id, "err", err)
			httpx.WriteErr(ctx, w, httpx.ErrServiceBusy())
			return
		}
		httpx.WriteOK(w, map[string]any{
			"upload_id":  id,
			"gcs_key":    key,
			"upload_url": session,
			"resumable":  true,
			"headers":    map[string]string{},
			"expires_in": int(resumableSessionTTL.Seconds()),
		})
		return
	}
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

// POST /v1/uploads/status {gcs_key} → {gcs_key, exists, bytes}: whether the
// upload has landed, and its size. A browser can't read the answer to the
// last chunk of a resumable upload (storage sends it without CORS headers),
// so the web client asks here whether the object is complete.
func (s *Service) HandleUploadStatus(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		GCSKey string `json:"gcs_key"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	if !s.GCS.InPrefix(req.GCSKey) || !strings.Contains(req.GCSKey, "/users/"+user.UID+"/") {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("gcs_key is not one of your uploads"))
		return
	}
	size, err := s.GCS.Stat(ctx, req.GCSKey)
	if errors.Is(err, storage.ErrObjectNotExist) {
		httpx.WriteOK(w, map[string]any{"gcs_key": req.GCSKey, "exists": false, "bytes": 0})
		return
	}
	if err != nil {
		httpx.WriteErr(ctx, w, uploadStatError(err))
		return
	}
	httpx.WriteOK(w, map[string]any{"gcs_key": req.GCSKey, "exists": true, "bytes": size})
}

// ------------------------------------------------------------- conversions

type createConversionReq struct {
	GCSKey       string   `json:"gcs_key"`
	Kind         string   `json:"kind"` // video | image
	Preset       string   `json:"preset"`
	Formats      []string `json:"formats"`
	Displacement float64  `json:"displacement"`
	// Placement (optional, video + image): job-wide [far, near] planes as
	// fractions of displacement, so the app's cloud output can match its
	// on-device kernel. Absent = pipeline default (-1.0, +0.5).
	Placement []float64 `json:"placement"`
	TargetFPS float64   `json:"target_fps"`
	// Frame-exact half-open trim [from_frame, to_frame) — the API takes
	// frames, never seconds (frame doctrine, web/DESIGN.md).
	FromFrame int `json:"from_frame"`
	ToFrame   int `json:"to_frame"`
	// Mobile contract (docs/MOBILE.md). Video: depth_model vda|da2,
	// warp, inpaint (none|migan|propainter), depth_res. Images: warp,
	// inpaint (lama|migan), stereo_mode.
	DepthModel string `json:"depth_model"`
	Warp       string `json:"warp"`
	Inpaint    string `json:"inpaint"`
	StereoMode string `json:"stereo_mode"`
	DepthRes   int    `json:"depth_res"`
	// OutputDepthmap (images): include a colorized depth PNG in the
	// outputs. Pointer so "unset" keeps the pipeline default (true).
	OutputDepthmap *bool  `json:"output_depthmap"`
	AppVersion     string `json:"app_version"`
	Platform       string `json:"platform"`
}

var allowedDepthModels = []string{"vda", "da2"} // da3/depth-pro stay R&D-only
var allowedVideoInpaint = []string{"none", "migan", "propainter"}
var allowedImageInpaint = []string{"lama", "migan"}
var allowedStereoModes = []string{"both", "left", "right"}

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
		if req.Kind == "image" {
			req.Formats = []string{"sbs"}
		} else {
			req.Formats = []string{"mvhevc", "half_sbs"}
		}
	}
	for _, f := range req.Formats {
		if !slices.Contains(allowedFormats, f) {
			return httpx.ErrInvalid("unsupported format " + f)
		}
		// The still pipeline composes sbs|half_sbs|tb|half_tb|anaglyph;
		// there is no spatial-photo (MV-HEVC) output for images yet.
		if req.Kind == "image" && f == "mvhevc" {
			return httpx.ErrInvalid("format mvhevc applies to video conversions only")
		}
	}
	if req.Displacement < 0 || req.Displacement > maxDisplacement {
		return httpx.ErrInvalid("displacement must be in (0, 0.03]")
	}
	if req.Placement != nil {
		if len(req.Placement) != 2 || req.Placement[0] >= req.Placement[1] ||
			req.Placement[0] < -maxPlacement || req.Placement[1] > maxPlacement {
			return httpx.ErrInvalid(fmt.Sprintf(
				"placement invalid: need [far, near] with -%g <= far < near <= %g", maxPlacement, maxPlacement))
		}
	}
	if req.TargetFPS < 0 || req.TargetFPS > 120 {
		return httpx.ErrInvalid("target_fps must be in (0, 120]")
	}
	if req.FromFrame < 0 || req.ToFrame < 0 || (req.ToFrame > 0 && req.ToFrame <= req.FromFrame) {
		return httpx.ErrInvalid("invalid trim range: need 0 <= from_frame < to_frame")
	}
	if req.Warp != "" && !slices.Contains(allowedWarp, req.Warp) {
		return httpx.ErrInvalid("warp must be forward|backward")
	}
	if req.StereoMode != "" && !slices.Contains(allowedStereoModes, req.StereoMode) {
		return httpx.ErrInvalid("stereo_mode must be both|left|right")
	}
	if req.Kind == "video" {
		if req.DepthModel != "" && !slices.Contains(allowedDepthModels, req.DepthModel) {
			return httpx.ErrInvalid("depth_model must be vda|da2")
		}
		if req.Inpaint != "" && !slices.Contains(allowedVideoInpaint, req.Inpaint) {
			return httpx.ErrInvalid("inpaint must be none|migan|propainter")
		}
		if req.Warp == "backward" {
			if req.Inpaint != "" && req.Inpaint != "none" {
				return httpx.ErrInvalid("warp backward cannot be combined with inpaint " + req.Inpaint + " (a gather warp has no gaps to fill)")
			}
			req.Inpaint = "none"
		}
		if req.DepthRes != 0 && (req.DepthRes < minDepthRes || req.DepthRes > maxDepthRes || req.DepthRes%14 != 0) {
			return httpx.ErrInvalid("depth_res must be a multiple of 14 in [140, 2520]")
		}
		if req.StereoMode != "" {
			return httpx.ErrInvalid("stereo_mode applies to image conversions only")
		}
		if req.OutputDepthmap != nil {
			return httpx.ErrInvalid("output_depthmap applies to image conversions only")
		}
	} else { // image
		if req.DepthModel != "" || req.DepthRes != 0 {
			return httpx.ErrInvalid("depth_model/depth_res apply to video conversions only")
		}
		if req.Inpaint != "" && !slices.Contains(allowedImageInpaint, req.Inpaint) {
			return httpx.ErrInvalid("image inpaint must be lama|migan")
		}
		if req.Warp == "backward" && req.Inpaint != "" {
			return httpx.ErrInvalid("warp backward cannot be combined with an inpaint model (a gather warp has no gaps to fill)")
		}
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
		if prior, gerr := s.Store.GetConversion(ctx, s.idempotentConversionID(user.UID, idemKey)); gerr == nil && prior.UID == user.UID {
			s.replayConversion(ctx, w, user, prior.ID) // P3
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
		httpx.WriteErr(ctx, w, httpx.ErrTooManyActive(rates.MaxActivePerUser))
		return
	}

	// Probe the uploaded object (size + streams) — the only trusted price input.
	size, err := s.GCS.Stat(ctx, req.GCSKey)
	if err != nil {
		httpx.WriteErr(ctx, w, uploadStatError(err))
		return
	}
	if size > rates.MaxSourceBytes {
		httpx.WriteErr(ctx, w, httpx.ErrSource("source_too_large", "source file too large"))
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
			httpx.WriteErr(ctx, w, probeError(err, "could not read video metadata: upload a valid video file"))
			return
		}
		if media.DurationS > rates.MaxDurationS {
			httpx.WriteErr(ctx, w, httpx.ErrSource("source_too_long", "video exceeds the maximum supported duration"))
			return
		}
		// §6 rails (docs/MOBILE.md): normalize, don't reject — the pipeline
		// downscales to the preset anyway. Hard limits only where decode
		// genuinely breaks; >60 fps auto-decimates unless the client asked
		// for a rate (reported back via params.target_fps).
		if media.Width > maxSourceWidth || media.Height > maxSourceHeight {
			httpx.WriteErr(ctx, w, httpx.ErrSource("source_too_large_dimensions", "video resolution exceeds the 8K maximum"))
			return
		}
		if media.FPS > maxSourceFPS {
			httpx.WriteErr(ctx, w, httpx.ErrSource("source_fps_too_high", "frame rate exceeds the 120 fps maximum"))
			return
		}
		if req.TargetFPS == 0 && media.FPS > autoDecimateFPS {
			req.TargetFPS = media.FPS / 2
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
			Inpaint: req.Inpaint,
		})
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		quote = &store.Quote{AmountCents: q.AmountCents, Currency: q.Currency, RateVersion: q.RateVersion, Breakdown: q.Breakdown}
	} else {
		media, err := probe.Image(ctx, probeURL)
		if err != nil {
			httpx.WriteErr(ctx, w, probeError(err, "could not read image metadata: upload a valid image file"))
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
	// With an Idempotency-Key the id derives from it instead (P3), so two
	// racing retries can't make two runs.
	id := uploadIDFromKey(req.GCSKey)
	switch {
	case idemKey != "":
		id = s.idempotentConversionID(user.UID, idemKey)
	case id == "":
		id = store.NewID()
	default:
		if _, err := s.Store.GetConversion(ctx, id); err == nil {
			id = store.NewID()
		}
	}

	conv := &store.Conversion{
		ID: id, UID: user.UID, Env: s.Cfg.Env, Kind: req.Kind,
		Client: store.Client{AppVersion: req.AppVersion, Platform: req.Platform},
		Source: src,
		Params: store.Params{
			Preset: req.Preset, Formats: req.Formats, Displacement: req.Displacement,
			Placement: req.Placement,
			TargetFPS: req.TargetFPS, FromFrame: req.FromFrame, ToFrame: req.ToFrame,
			DepthModel: req.DepthModel, Warp: req.Warp, Inpaint: req.Inpaint,
			StereoMode: req.StereoMode, DepthRes: req.DepthRes,
			OutputDepthmap: req.OutputDepthmap,
		},
		Quote:   *quote,
		IdemKey: idemKey,
	}

	// Stills (docs/MOBILE.md §3): free daily allowance first (the quota
	// slot is consumed here and never refunded), then a leftover photo-pack
	// credit (packs were withdrawn 2026-09-02; balances are honored and
	// refunded if the run never delivers), else the still is a paid,
	// metered conversion at image_cents that joins the account's batch
	// exactly like a video — card required, same overdue gate, charged
	// after the fact, never on its own.
	if conv.Kind == "image" && quote.AmountCents > 0 {
		if conv.Quote.Breakdown == nil {
			conv.Quote.Breakdown = map[string]any{}
		}
		_, free, qerr := s.Store.ConsumeDailyImageQuota(ctx, user.UID, rates.FreeImagesPerDay)
		if qerr != nil {
			httpx.WriteErr(ctx, w, qerr)
			return
		}
		if free {
			conv.Quote.Breakdown["free_image"] = true
			conv.Quote.Breakdown["free_daily_image"] = true
			conv.Quote.AmountCents = 0
		} else {
			_, ok, cerr := s.Store.ConsumePhotoCredit(ctx, user.UID)
			if cerr != nil {
				httpx.WriteErr(ctx, w, cerr)
				return
			}
			if ok {
				conv.Quote.Breakdown["photo_credit"] = true
				conv.Quote.AmountCents = 0
			}
		}
	}

	if conv.Quote.AmountCents == 0 {
		// Nothing to bill: enters at "paid" with no Stripe state at all.
		conv.State = store.StatePaid
		if err := s.Store.CreateConversion(ctx, conv); err != nil {
			// The free slot or photo credit was taken above; give it back,
			// or a failed write (a burst running out the request's time)
			// spends an allowance on a conversion that never existed.
			// Detached: the request's own deadline may be what ran out.
			rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			if conv.Quote.Breakdown["free_daily_image"] == true {
				if rerr := s.Store.RefundDailyImageQuota(rctx, user.UID); rerr != nil {
					httpx.Log(ctx).Warn("daily quota refund failed", "uid", user.UID, "err", rerr)
				}
			}
			s.refundPhotoCredit(rctx, conv)
			cancel()
			if errors.Is(err, store.ErrAlreadyExists) {
				s.replayConversion(ctx, w, user, conv.ID) // P3: a racing retry won
				return
			}
			httpx.WriteErr(ctx, w, err)
			return
		}
		httpx.Log(ctx).Info("conversion created (free)",
			"conversion_id", conv.ID, "uid", user.UID, "kind", conv.Kind)
		if serr := s.submitInline(ctx, conv.ID); serr != nil {
			httpx.Log(ctx).Warn("inline submit failed; reconciler will retry",
				"conversion_id", conv.ID, "err", serr)
		} else if fresh, gerr := s.Store.GetConversion(ctx, conv.ID); gerr == nil {
			conv = fresh
		}
		httpx.WriteOK(w, s.conversionResponse(conv, nil))
		return
	}

	// Paid: the same auto-billing flow as the pro steps — saved card
	// required, threshold hybrid (hold ≥ $100, else charge on success).
	// No PaymentSheet in the response; a 402 routes the client to the
	// SetupIntent onboarding / settle flows.
	cust, berr := s.requireBillable(ctx, user)
	if berr != nil {
		httpx.WriteErr(ctx, w, berr)
		return
	}
	s.finalizeAutoBilled(ctx, w, user, cust, conv, func() {})
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
		Metadata:     s.jobMetadata(ctx, conv),
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

// GET /v1/limits — everything a client needs BEFORE uploading anything:
// hard limits, the user's current usage/allowances, billing standing, and
// the rate card for a clearly-labeled local estimate (docs/MOBILE.md §5).
// The authoritative quote is still the server's at submit time.
func (s *Service) HandleLimits(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	rates := s.Pricing.Rates(ctx)

	active, err := s.Store.CountActiveForUser(ctx, user.UID)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	freeImages, err := s.Store.RemainingDailyImageQuota(ctx, user.UID, rates.FreeImagesPerDay)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	hasCard, delinquent := false, false
	var unpaidCents, pendingCents int64
	var tier map[string]any
	if cust, cerr := s.Store.GetCustomer(ctx, user.UID); cerr == nil {
		// DefaultPaymentMethod is a cache only /v1/billing's read path
		// heals. An empty value right after a SetupIntent confirm is the
		// one state that yields a false negative (mobile gates on this
		// field), so refresh from Stripe just for that case; a populated
		// cache going stale merely fails the eventual charge, which the
		// billing_overdue path already handles. No Stripe call on the
		// steady-state (card-on-file) read, and a missing customer record
		// means no SetupIntent ever ran — don't mint one here.
		if cust.DefaultPaymentMethod == "" && cust.StripeCustomerID != "" {
			cust = s.refreshCardCache(ctx, user.UID, cust.StripeCustomerID)
		}
		hasCard = cust.DefaultPaymentMethod != ""
		tier = s.tierEntry(ctx, cust, false) // the mobile limits: the app's ladder, unchanged
		if open, oerr := s.Store.OpenBatchFor(ctx, user.UID); oerr == nil && open != nil {
			pendingCents = open.TotalCents
		}
	}
	if tier == nil {
		tier = s.tierEntry(ctx, nil, false)
	}
	if unpaid, uerr := s.Store.ListUserByPIStatus(ctx, user.UID, store.PIChargeFailed, unpaidLimit); uerr == nil {
		delinquent = len(unpaid) > 0
		for _, c := range unpaid {
			unpaidCents += c.Quote.AmountCents
		}
	}

	httpx.WriteOK(w, map[string]any{
		"limits": map[string]any{
			"max_duration_s":      rates.MaxDurationS,
			"max_source_bytes":    rates.MaxSourceBytes,
			"max_active_per_user": rates.MaxActivePerUser,
			"max_width":           maxSourceWidth,
			"max_height":          maxSourceHeight,
			"max_fps":             maxSourceFPS,
			// above the preset's output height we downscale rather than
			// reject; above 60 fps we decimate unless target_fps is given
			"normalize_height":  2160,
			"auto_decimate_fps": autoDecimateFPS,
		},
		"usage": s.usageEntry(ctx, user.UID, active, freeImages),
		// the 48-hour wait: clients ask "Keep my account" on sign-in
		"account_deletion": s.deletionState(ctx, user.UID),
		// Per-method source caps (0 = unlimited) and availability.
		"methods": map[string]any{
			store.MethodLifelike: map[string]any{
				"max_source_duration_s": rates.MaxSourceDurationFor(store.MethodLifelike),
				"max_source_bytes":      rates.MaxSourceBytesFor(store.MethodLifelike),
				"available":             s.assignWorkspace().Lifelike != nil, // where new projects go (S3D-40)
				"new_projects":          s.assignWorkspace().Lifelike != nil,
				// the web offers Foveated Detail on this (same flag as
				// /v1/pricing methods.lifelike.foveation.enabled)
				"foveation": rates.FoveationEnabled,
			},
			store.MethodClassic: map[string]any{
				"max_source_duration_s": rates.MaxSourceDurationFor(store.MethodClassic),
				"max_source_bytes":      rates.MaxSourceBytesFor(store.MethodClassic),
				"available":             true,  // existing classic projects keep running
				"new_projects":          false, // S3D-44: not offered for new projects
			},
		},
		"default_method": s.defaultMethod(),
		"billing": map[string]any{
			"has_payment_method": hasCard,
			"delinquent":         delinquent,
			"unpaid_cents":       unpaidCents,
			"pending_cents":      pendingCents,
			"tier":               tier,
		},
		"rates": map[string]any{
			"rate_version":                     rates.RateVersion,
			"currency":                         rates.Currency,
			"cents_per_minute":                 rates.CentsPerMinute,
			"image_cents":                      rates.ImageCents,
			"free_images_per_day":              rates.FreeImagesPerDay,
			"minimum_cents":                    rates.MinimumCents,
			"min_billable_seconds":             rates.MinBillableSeconds,
			"cost_margin_multiplier":           rates.CostMarginMultiplier,
			"discount_threshold_cents":         rates.DiscountThresholdCents,
			"discount_pct":                     rates.DiscountPct,
			"inpaint_multiplier":               rates.InpaintMultiplier,
			"migan_production_multiplier":      rates.MiganProductionMultiplier,
			"production_no_inpaint_multiplier": rates.ProductionNoInpaintMultiplier,
			"hold_threshold_cents":             tier["hold_threshold_cents"],
			// pro steps quoted above this are charged before they start
			"precharge_threshold_cents": rates.PrechargeThreshold(),
		},
	})
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
	out := s.conversionResponse(conv, nil)
	s.addPaymentDocs(ctx, []map[string]any{out}, []*store.Conversion{conv}, true)
	httpx.WriteOK(w, out)
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
	gone := map[string]bool{}
	for _, c := range convs {
		if c.Sample || s.projectGone(ctx, c, gone) {
			continue // the onboarding sample isn't a conversion of theirs
		}
		out = append(out, s.conversionResponse(c, nil))
	}
	httpx.WriteOK(w, map[string]any{"conversions": out})
}

// GET /v1/conversions/{id}/downloads — signed GET URLs for outputs, signed
// afresh on every request (24 h each), so a client whose links expired
// just asks again.
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
	if conv.Sample {
		httpx.WriteOK(w, sampleDownloads(conv)) // the CDN's shared files
		return
	}
	s.noteWatched(ctx, conv) // onboarding: their first download
	// Never locked for payment reasons (S3D-22, the App Store way): a
	// failed charge refuses NEW paid runs (payment_method_needed) instead.
	// files: one entry per output with its download name (S3D-31,
	// download_names.go), which also rides each signed URL as
	// Content-Disposition for project runs; a split output is one entry
	// per part (part: N). filename is exactly the Content-Disposition name,
	// so a run without one (the mobile one-shot, URL unchanged) has none.
	// downloads (name → URL) stays for older clients.
	var names map[string]string
	var project *store.Project
	if conv.ProjectID != "" {
		if p, perr := s.Store.GetProject(ctx, conv.ProjectID); perr == nil {
			project = p
			if err := requireFiles(p); err != nil { // S3D-24: erased
				httpx.WriteErr(ctx, w, err)
				return
			}
			if err := s.outstandingLock(ctx, user.UID); err != nil { // C10 (S3D-35)
				httpx.WriteErr(ctx, w, err)
				return
			}
			if conv.DisputeID != "" { // B11: locked while its charge is disputed
				httpx.WriteErr(ctx, w, httpx.Err(http.StatusForbidden, "disputed", "Unavailable while disputed with your bank"))
				return
			}
			project = s.noteProjectUse(ctx, p, false) // downloading is a use
		}
		convs, lerr := s.Store.ListProjectConversions(ctx, conv.ProjectID, 100)
		if lerr != nil || !slices.ContainsFunc(convs, func(c *store.Conversion) bool { return c.ID == conv.ID }) {
			convs = append(convs, conv) // older than the listing window
		}
		names = projectDownloadNames(project, convs)[conv.ID]
	}
	urls := map[string]string{}
	files := make([]outputFile, 0, len(conv.Outputs))
	for name, key := range conv.Outputs {
		filename := names[name]
		var u string
		if filename != "" {
			u, err = s.GCS.SignedGetURLAs(key, downloadTTL, contentDisposition(filename))
		} else {
			u, err = s.GCS.SignedGetURL(key, downloadTTL) // mobile one-shot: unchanged
		}
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		urls[name] = u
		format, part := splitOutputName(name)
		f := outputFile{Name: name, Format: format, Part: part, URL: u, Filename: filename}
		if size, serr := s.GCS.Stat(ctx, key); serr == nil {
			f.SizeBytes = size
		}
		files = append(files, f)
	}
	sortOutputFiles(files)
	s.logIssued(r, conv, files) // M8
	httpx.WriteOK(w, map[string]any{
		"downloads":  urls,
		"files":      files,
		"expires_in": int(downloadTTL.Seconds()),
	})
}

// cancelWindow: a job may only be canceled within this long of its start
// (cancelable). Past it the GPU spend is committed — the run settles (and
// bills) normally. Conversions not yet submitted (payment hold pending)
// stay cancelable indefinitely so users are never trapped with a hold.
const cancelWindow = time.Minute

var errCancelWindowClosed = errors.New("cancel window closed")

// runStartedAt is when the cancel window opened: the run's GPU start as
// polls saw it, else its submission (nil before submission).
func runStartedAt(c *store.Conversion) *time.Time {
	if c.Modal.StartedAt != nil {
		return c.Modal.StartedAt
	}
	return c.Modal.SubmittedAt
}

// cancelable (S3D-19/S3D-23, both methods, pre-charged or batched): before
// submission; any time while the run waits in line for a GPU with nothing
// started yet; else for cancelWindow after it started. Every case is
// refunded in full (pre-charged) or never charged (batched).
func cancelable(c *store.Conversion, now time.Time) bool {
	if store.IsTerminal(c.State) {
		return false
	}
	if c.Modal.SubmittedAt == nil {
		return true
	}
	if c.Modal.WaitingForGPU && c.Modal.StartedAt == nil {
		return true
	}
	return now.Sub(*runStartedAt(c)) <= cancelWindow
}

// noteStart records the run's GPU start from a poll (see Modal.StartedAt):
// leaving the queue starts it now; a run that never queued counts from its
// submission once a cancel window has passed. prevWaiting is the record's
// waiting_for_gpu before this poll.
func noteStart(c *store.Conversion, prevWaiting, waitingNow bool, now time.Time) {
	if c.Modal.StartedAt != nil || waitingNow || c.Modal.SubmittedAt == nil {
		return
	}
	switch {
	case prevWaiting:
		c.Modal.StartedAt = &now
	case now.Sub(*c.Modal.SubmittedAt) > cancelWindow:
		submitted := *c.Modal.SubmittedAt
		c.Modal.StartedAt = &submitted
	}
}

// DELETE /v1/conversions/{id} — cancel job + release hold (or refund a
// pre-charged run).
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
	// Whether it still waits in line decides the window: read it fresh.
	if conv.State == store.StateProcessing &&
		(conv.Modal.LastPolledAt == nil || time.Since(*conv.Modal.LastPolledAt) > pollStaleness) {
		_, _ = s.refreshFromModal(ctx, conv)
	}
	// Claim the cancel via the state machine FIRST — if the job just settled
	// (e.g. reconciler captured the hold a moment ago) this conflicts and we
	// return the terminal state instead of touching the money. The
	// cancel_pending marker makes the hold release crash-safe (reconciler
	// sweeps it), and releaseHold is the one place that touches the PI.
	// The cancel-window check runs INSIDE the transaction so a submit that
	// lands between our read and the claim can't be canceled past its window.
	updated, err := s.Store.Transition(ctx, id, store.ActiveStates, func(c *store.Conversion) error {
		if !cancelable(c, time.Now()) {
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
	if client := s.modalFor(updated); updated.Modal.JobID != "" && client != nil {
		if err := client.CancelJob(ctx, updated.Modal.JobID); err != nil {
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
	UID      string
	Email    string
	AuthTime time.Time // the ID token's auth_time (zero when unknown)
	// Anonymous: signed in anonymously (no sign-in method); its deletion
	// never waits (owner 2026-11-07).
	Anonymous bool
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
	// A deleted project's runs are gone with it.
	if conv.UID != user.UID || s.projectGone(ctx, conv, nil) {
		return nil, httpx.ErrNotFound("conversion")
	}
	return s.backfillSampleRun(ctx, conv), nil // a sample run stored before half_sbs joined
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
	if c.Params.OutputQuality != "" {
		resp["quality"] = c.Params.OutputQuality // standard | high | master (web Lifelike)
	}
	if cents := campaignCentsOf(c); cents > 0 {
		resp["campaign_cents"] = cents // the launch offer (also in quote.breakdown)
	}
	// The Files "Details" panel: when the run left the line (so "Took"
	// leaves the wait out), the free previews it used, whether it was
	// ordered as a Quick look, and whether the brand intro was on.
	resp["started_at"] = nil
	if c.Modal.StartedAt != nil {
		resp["started_at"] = c.Modal.StartedAt.UTC().Format(time.RFC3339)
	}
	resp["free_preview_units"] = nil
	if fp := c.FreePreview; fp != nil && !fp.Returned {
		resp["free_preview_units"] = fp.Units
	}
	resp["quick_look"] = c.Params.QuickLook
	resp["intro"] = (c.Params.IntroS != nil && *c.Params.IntroS > 0) || c.Modal.IntroFrames > 0
	if len(c.OutputsMedia) > 0 {
		resp["outputs_media"] = c.OutputsMedia // {name: {video_kbps, overall_kbps?, audio_codec?, audio_kbps?, source}}
	}
	if c.Modal.OutputBitDepth > 0 {
		resp["output_bit_depth"] = c.Modal.OutputBitDepth // the spatial file's, from the worker
	}
	if c.Modal.OutputBitDepthReason != "" {
		resp["output_bit_depth_reason"] = c.Modal.OutputBitDepthReason // why 10 didn't apply
	}
	if c.ProjectID != "" {
		req := c.Params.Bitrate // what was asked: auto, match_source, a number of Mbit/s or master
		if req == "" {
			req = "auto"
		}
		resp["bitrate_requested"] = req
	}
	if c.Method == store.MethodLifelike && c.Step != "" {
		paid := false // a 1080p run quoted before 2026-11-07 paid for it
		switch v := c.Quote.Breakdown["foveation_cents"].(type) {
		case int64:
			paid = v > 0
		case float64:
			paid = v > 0
		}
		fv := map[string]any{"applied": c.Params.Foveation != "", "included": c.Params.Preset == foveationIncludedPreset && !paid}
		if fv["included"] == true && c.Params.Foveation == "" {
			fv["reason"] = "output_not_below_source"
		}
		resp["foveation"] = fv
	}
	if split := splitBilling(c); split != nil {
		resp["pay_split"] = split // credit and balance first: the covered part and the card's
	}
	// Adaptive Pricing: what the card paid in the customer's currency,
	// {amount_minor, currency}; null when USD, unknown or not a card.
	resp["presentment"] = c.Stripe.Presentment
	resp["method"] = store.MethodOr(c.Method)
	if c.Sample {
		resp["sample"] = true
	}
	if c.ProjectID != "" {
		resp["project_id"] = c.ProjectID
		resp["step"] = c.Step
		resp["scenes_version"] = c.ScenesVer
		// When the money moves: "before" = charged up front and refunded
		// if the run fails (pre-charged), "after" = billed on success.
		resp["charge_timing"] = "after"
		if c.Stripe.Mode == store.BillingModeAutoPrecharge {
			resp["charge_timing"] = "before"
		}
	}
	resp["quote"] = map[string]any{
		"amount_cents": c.Quote.AmountCents,
		"currency":     c.Quote.Currency,
		"breakdown":    c.Quote.Breakdown,
	}
	resp["progress"] = c.Modal.Progress
	resp["stage"] = c.Modal.Stage
	resp["eta_seconds"], resp["eta_source"] = runETA(c, time.Now())
	resp["waiting_for_gpu"] = c.Modal.WaitingForGPU && !store.IsTerminal(c.State)
	// 5K-8K Lifelike outputs are experimental (the job says so once done).
	if c.Modal.Experimental || (store.MethodOr(c.Method) == store.MethodLifelike && presetOutputHeight[c.Params.Preset] > originalEyeAboveShortSide) {
		resp["experimental"] = true
	}
	resp["queued_s"] = c.Modal.QueuedS
	if store.MethodOr(c.Method) == store.MethodLifelike {
		// Lifelike scheduling (additive): the priority and GPU count the
		// job echoed (what was asked until it does); an Express run waiting
		// for a GPU waits at most queue_wait_max_seconds for a running
		// standard piece.
		prio := c.Modal.Priority
		if prio == "" {
			prio = "standard"
			if c.Params.Express {
				prio = "express"
			}
		}
		resp["priority"] = prio
		if c.Modal.GPUWorkers > 0 {
			resp["max_gpu_workers"] = c.Modal.GPUWorkers
		}
		if prio == "express" && c.Modal.WaitingForGPU && !store.IsTerminal(c.State) && s.Pricing != nil {
			resp["queue_wait_max_seconds"] = s.Pricing.Rates(context.Background()).ExpressMaxWaitS()
		}
	}
	if len(c.Parts) > 0 {
		resp["parts"] = c.Parts
	}
	// cancelable says whether the button shows now; cancelable_until when
	// it goes, once the run has started (absent before submission and while
	// it waits in line with nothing started — cancelable throughout).
	if !store.IsTerminal(c.State) {
		now := time.Now()
		resp["cancelable"] = cancelable(c, now)
		if c.Modal.SubmittedAt != nil && !(c.Modal.WaitingForGPU && c.Modal.StartedAt == nil) {
			resp["cancelable_until"] = runStartedAt(c).Add(cancelWindow).Format(time.RFC3339)
		}
	}
	if isOverdue(c, time.Now()) {
		resp["overdue"] = true // the client offers "Report it"
	}
	if n := len(c.Support.Reports); n > 0 {
		resp["reported_at"] = c.Support.Reports[n-1].At.Format(time.RFC3339)
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
	resp["payment"] = paymentStatus(c)
	// Auto-billed conversions surface how the money went so the client can
	// react without touching Stripe ids: a pending 3DS challenge on the hold
	// (auto_hold, state=created) carries the client_secret for the saved-card
	// confirm; succeeded runs report the charge/capture outcome.
	switch c.Stripe.Mode {
	case store.BillingModeFreePreview:
		b := map[string]any{"status": "free_preview"}
		if c.FreePreview != nil {
			b["units"] = c.FreePreview.Units
			b["returned"] = c.FreePreview.Returned
		}
		resp["billing"] = b
	case store.BillingModeBalance:
		if b := balanceBilling(c); b != nil {
			resp["billing"] = b
		}
		if c.ProjectID != "" {
			resp["charge_timing"] = "before"
			resp["payment_flow"] = store.FlowBalance
		}
	case store.BillingModeAutoPrecharge:
		if b := prechargeBilling(c); b != nil {
			resp["billing"] = b
		} else {
			resp["billing"] = map[string]any{
				"status":          "requires_action",
				"client_secret":   c.Stripe.ClientSecret,
				"publishable_key": s.Stripe.PublishableKey,
			}
		}
	case store.BillingModeAuto, store.BillingModeAutoHold:
		if c.State == store.StateFailed || c.State == store.StateCanceled || c.State == store.StateExpired {
			// "Cancelled, not charged" (S3D-33): nothing was taken.
			resp["billing"] = map[string]any{"status": "not_charged"}
		}
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
			// capture_failed is our lapsed hold, not the user's to settle
			// (support follows it up from Slack): it reads as pending.
			case store.PIChargeFailed:
				resp["billing"] = map[string]any{"status": "charge_failed"}
			case store.PIBatched:
				// On the account's running tab — charged with the user's
				// other steps when the batch closes (GET /v1/billing.pending).
				resp["billing"] = map[string]any{"status": "batched", "batch_id": c.Stripe.BatchID}
			default:
				resp["billing"] = map[string]any{"status": "charge_pending"}
			}
		}
	}
	if b := payNowBilling(c, s.publishableKey()); b != nil {
		resp["billing"] = b // the sheet's run waiting for its payment (spec v6 F)
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

// uploadStatError tells a missing upload (the client's mistake) from storage
// failing to answer in time (ours; worth another try).
func uploadStatError(err error) *httpx.APIError {
	if errors.Is(err, storage.ErrObjectNotExist) {
		return httpx.ErrInvalid("upload not found; PUT the file to the signed URL first")
	}
	return httpx.ErrServiceBusy()
}

// probeError tells a file ffprobe can't read from a probe that ran out of
// time under load, which read as a bad file and failed the item for good.
func probeError(err error, unreadable string) *httpx.APIError {
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) {
		return httpx.ErrServiceBusy()
	}
	return httpx.ErrSource("source_unsupported", unreadable)
}

// replayConversion answers a request whose Idempotency-Key already made a
// run (P3: the id is derived from uid + key, and a racing second request
// loses the Firestore Create): the existing run, with the mobile hold's
// sheet material while it still waits for the client.
func (s *Service) replayConversion(ctx context.Context, w http.ResponseWriter, user *AuthedUser, id string) {
	prior, err := s.Store.GetConversion(ctx, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if prior.UID != user.UID {
		httpx.WriteErr(ctx, w, httpx.ErrNotFound("conversion"))
		return
	}
	var sheet any
	if prior.ProjectID == "" && prior.State == store.StateCreated && prior.Stripe.Mode == "" && prior.Stripe.PaymentIntentID != "" {
		if ps, perr := s.Stripe.PaymentSheetFor(prior.Stripe.CustomerID, prior.Stripe.PaymentIntentID); perr == nil {
			sheet = ps
		}
	}
	httpx.WriteOK(w, s.conversionResponse(prior, sheet))
}

// idempotentConversionID is the run id for a request carrying an
// Idempotency-Key (P3): derived from the account and the key, so two
// racing requests aim at ONE document and Firestore's Create lets only one
// through. Without a key, a fresh id.
func (s *Service) idempotentConversionID(uid, key string) string {
	if key == "" {
		return store.NewID()
	}
	return store.IdemConversionID(s.Cfg.Env, uid, key)
}
