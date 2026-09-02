package api

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/stripe/stripe-go/v78"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"strconv"
	"strings"
)

// Pay-as-you-go billing endpoints (web pro flow).
//
// Onboarding saves a card via a SetupIntent; GET /v1/billing is the
// read-through status the web client gates on (it also heals the default
// payment method after onboarding or a portal edit). Paid steps are blocked
// with 402s until a card is on file and no charge_failed conversion is
// outstanding; POST /v1/billing/settle retries the outstanding charges.

// unpaidLimit bounds the delinquency probe; one unpaid conversion already
// blocks new paid work, the exact count doesn't matter.
const unpaidLimit = 10

// holdThresholdCents: quotes at or above this place an off-session hold on
// the saved card BEFORE the job runs (captured on success); below it the
// card is charged only on success with no hold — everyday runs don't leave
// pending charges on statements. Raised $5 → $100 with the 2026-07-03
// pricing recalibration (quotes grew ~10×; at $5 nearly every run held).
// Code constant by design.
const holdThresholdCents = 10000

// jobDescription renders a conversion as the user-facing charge description:
// it appears on the Stripe dashboard payment, the emailed receipt, and is
// copied into PaymentIntent metadata for support.
// presetOutputHeight mirrors PRESETS in app/pipelines/video.py (the output
// short side each preset renders at) for the payment metadata below. Keep in
// sync when presets change — an unknown preset just omits the field.
var presetOutputHeight = map[string]int{
	"draft": 1080, "1080p": 1080, "qhd": 1440, "3k": 1620, "4k": 2160,
}

// jobMetadataFromConversion builds the support-facing PaymentIntent
// metadata from the conversion alone: the full configuration (preset,
// inpaint, warp, formats, fps, depth knobs, per-scene overrides) plus the
// quote's billable length and the stages the run REUSED instead of
// computing. Pure — the project's source-video facts are layered on by
// Service.jobMetadata. Values are short strings well inside Stripe's
// 50-key / 500-char metadata limits.
func jobMetadataFromConversion(conv *store.Conversion) map[string]string {
	m := map[string]string{}
	put := func(k, v string) {
		if v != "" {
			m[k] = v
		}
	}
	num := func(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }
	pa := conv.Params
	put("kind", conv.Kind)
	put("step", conv.Step)
	put("preset", pa.Preset)
	if pa.Inpaint != "" || pa.Warp != "" {
		inpaint := pa.Inpaint
		if inpaint == "" {
			inpaint = "propainter" // the pipeline default
		}
		warp := pa.Warp
		if warp == "" {
			warp = "forward"
		}
		put("inpaint", inpaint)
		put("warp", warp)
	}
	put("formats", strings.Join(pa.Formats, ","))
	if pa.TargetFPS > 0 {
		put("target_fps", num(pa.TargetFPS))
	}
	if pa.DepthRes > 0 {
		put("depth_res", strconv.Itoa(pa.DepthRes))
	}
	if pa.DepthScale > 0 {
		put("depth_scale", num(pa.DepthScale))
	}
	if pa.DepthOnly {
		put("depth_only", "true")
	}
	if pa.DepthSource != "" {
		put("depth_source", "uploaded")
	}
	if n := len(pa.SceneOverrides); n > 0 {
		put("scene_overrides", strconv.Itoa(n))
		pass := 0
		for _, ov := range pa.SceneOverrides {
			if ov.Passthrough {
				pass++
			}
		}
		if pass > 0 {
			put("passthrough_scenes", strconv.Itoa(pass))
		}
	}
	if b := conv.Quote.Breakdown; b != nil {
		switch v := b["billable_seconds"].(type) {
		case float64:
			put("billable_seconds", num(v))
		case int64:
			put("billable_seconds", strconv.FormatInt(v, 10))
		}
		// []string before the Firestore round-trip, []any after it
		switch v := b["reuse_stages"].(type) {
		case []string:
			put("reused_stages", strings.Join(v, ","))
		case []any:
			parts := make([]string, 0, len(v))
			for _, x := range v {
				if s, ok := x.(string); ok {
					parts = append(parts, s)
				}
			}
			put("reused_stages", strings.Join(parts, ","))
		}
	}
	if h := presetOutputHeight[pa.Preset]; h > 0 {
		put("output_height", strconv.Itoa(h))
	}
	return m
}

// jobMetadata = jobMetadataFromConversion + the project's source-video
// facts (resolution, fps, duration, frame and scene counts). The project
// read is best-effort: a metadata miss must never block money movement.
func (s *Service) jobMetadata(ctx context.Context, conv *store.Conversion) map[string]string {
	m := jobMetadataFromConversion(conv)
	if conv.ProjectID == "" {
		return m
	}
	p, err := s.Store.GetProject(ctx, conv.ProjectID)
	if err != nil || p == nil {
		return m
	}
	if p.Probe != nil {
		m["source_res"] = strconv.Itoa(p.Probe.Width) + "x" + strconv.Itoa(p.Probe.Height)
		m["source_fps"] = strconv.FormatFloat(p.Probe.FPS, 'f', 3, 64)
		m["video_duration_s"] = strconv.FormatFloat(p.Probe.DurationS, 'f', 2, 64)
		m["video_frames"] = strconv.Itoa(p.Probe.NumFrames)
	}
	if p.Scenes != nil {
		m["scene_cuts"] = strconv.Itoa(len(p.Scenes.Cuts))
	}
	return m
}

func jobDescription(conv *store.Conversion) string {
	switch conv.Step {
	case store.StepDepthPreview:
		return "Depth preview"
	case store.StepStereoPreview:
		if conv.Params.Inpaint != "" && conv.Params.Inpaint != "none" {
			return "Stereo preview with inpainting"
		}
		return "Stereo preview"
	case store.StepProduction:
		return "Production 3D render"
	}
	if conv.Kind == "image" {
		return "3D image conversion"
	}
	return "3D video conversion"
}

// refreshCardCache reads the live default payment method from Stripe and
// folds it into the uid → customer cache the conversion-create gate reads.
// On a Stripe read error the stale cache is returned — billing status must
// still render during a Stripe blip.
func (s *Service) refreshCardCache(ctx context.Context, uid, customerID string) *store.Customer {
	card, err := s.Stripe.DefaultCard(customerID)
	if err != nil {
		httpx.Log(ctx).Warn("default card lookup failed (serving cached)", "uid", uid, "err", err)
		if cust, gerr := s.Store.GetCustomer(ctx, uid); gerr == nil {
			return cust
		}
		return &store.Customer{StripeCustomerID: customerID}
	}
	cust, err := s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error {
		if card == nil {
			c.DefaultPaymentMethod, c.CardBrand, c.CardLast4 = "", "", ""
			c.CardExpMonth, c.CardExpYear = 0, 0
		} else {
			c.DefaultPaymentMethod = card.PaymentMethodID
			c.CardBrand, c.CardLast4 = card.Brand, card.Last4
			c.CardExpMonth, c.CardExpYear = card.ExpMonth, card.ExpYear
		}
		c.CardUpdatedAt = time.Now().UTC()
		return nil
	})
	if err != nil {
		httpx.Log(ctx).Warn("card cache update failed", "uid", uid, "err", err)
		if cust, gerr := s.Store.GetCustomer(ctx, uid); gerr == nil {
			return cust
		}
		return &store.Customer{StripeCustomerID: customerID}
	}
	return cust
}

// unpaidEntry serializes one charge_failed conversion for the billing UI.
func (s *Service) unpaidEntry(ctx context.Context, conv *store.Conversion) map[string]any {
	entry := map[string]any{
		"conversion_id": conv.ID,
		"step":          conv.Step,
		"amount_cents":  conv.Quote.AmountCents,
		"currency":      conv.Quote.Currency,
		"needs_action":  false,
	}
	if conv.Stripe.PaymentIntentID != "" {
		if pi, err := s.Stripe.GetPaymentIntent(conv.Stripe.PaymentIntentID); err == nil {
			switch pi.Status {
			case stripe.PaymentIntentStatusRequiresAction, stripe.PaymentIntentStatusRequiresConfirmation:
				// The saved card is fine — the bank wants 3DS. The client
				// completes it with confirmCardPayment(client_secret).
				entry["needs_action"] = true
				entry["client_secret"] = pi.ClientSecret
			}
		} else {
			httpx.Log(ctx).Warn("unpaid PI lookup failed", "conversion_id", conv.ID, "err", err)
		}
	}
	return entry
}

func (s *Service) billingStatus(ctx context.Context, user *AuthedUser, cust *store.Customer) (map[string]any, error) {
	cust = s.ensureLifetimeSeeded(ctx, user.UID, cust)
	unpaid, err := s.Store.ListUserByPIStatus(ctx, user.UID, store.PIChargeFailed, unpaidLimit)
	if err != nil {
		return nil, err
	}
	// Failed batches are listed once (as a batch); their conversions also
	// read charge_failed, so skip those here.
	failedBatches, err := s.Store.ListUserBatchesByState(ctx, user.UID, store.BatchFailed, unpaidLimit)
	if err != nil {
		return nil, err
	}
	entries := make([]map[string]any, 0, len(unpaid)+len(failedBatches))
	for _, b := range failedBatches {
		entries = append(entries, s.failedBatchEntry(ctx, b))
	}
	for _, conv := range unpaid {
		if conv.Stripe.BatchID != "" {
			continue
		}
		entries = append(entries, s.unpaidEntry(ctx, conv))
	}
	resp := map[string]any{
		"has_payment_method": cust.DefaultPaymentMethod != "",
		"delinquent":         len(entries) > 0,
		"unpaid":             entries,
		"publishable_key":    s.Stripe.PublishableKey,
		"tier":               s.tierEntry(ctx, cust),
	}
	if cust.PhotoCredits > 0 {
		resp["photo_credits"] = cust.PhotoCredits // leftover pack balance, honored until spent
	}
	if open, oerr := s.Store.OpenBatchFor(ctx, user.UID); oerr == nil && open != nil {
		resp["pending"] = pendingEntry(open)
	} else if oerr != nil {
		httpx.Log(ctx).Warn("open batch lookup failed", "uid", user.UID, "err", oerr)
	}
	if cust.DefaultPaymentMethod != "" {
		resp["card"] = map[string]any{
			"brand":     cust.CardBrand,
			"last4":     cust.CardLast4,
			"exp_month": cust.CardExpMonth,
			"exp_year":  cust.CardExpYear,
		}
	}
	return resp, nil
}

// GET /v1/billing — the web client's billing gate: does the caller have a
// chargeable card on file, and is any automatic charge outstanding? Ensures
// the billing profile and heals the Stripe default payment method, so
// polling this after a SetupIntent confirm completes onboarding.
func (s *Service) HandleGetBilling(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	cust := s.refreshCardCache(ctx, user.UID, customerID)
	resp, err := s.billingStatus(ctx, user, cust)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	httpx.WriteOK(w, resp)
}

// POST /v1/billing/setup-intent — start saving a card for off-session
// charges (the onboarding flow's Payment Element binds to the returned
// client_secret).
func (s *Service) HandleCreateSetupIntent(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	sheet, err := s.Stripe.CreateSetupIntent(customerID, user.UID)
	if err != nil {
		httpx.Log(ctx).Error("setup intent failed", "uid", user.UID, "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "could not start card setup; try again"))
		return
	}
	httpx.WriteOK(w, sheet)
}

// POST /v1/billing/settle — retry the outstanding automatic charges against
// the CURRENT default card (refreshed first, so a card added in the portal
// is picked up). Returns the first 3DS challenge as requires_action +
// client_secret for the web confirmCardPayment fallback.
func (s *Service) HandleSettleBilling(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	s.refreshCardCache(ctx, user.UID, customerID)
	// Failed batches first: re-arm and charge (their conversions flip back
	// to batched, so the per-conversion loop below never double-charges).
	if failedBatches, berr := s.Store.ListUserBatchesByState(ctx, user.UID, store.BatchFailed, unpaidLimit); berr == nil {
		for _, b := range failedBatches {
			if _, cerr := s.rearmBatch(ctx, b); cerr != nil {
				httpx.Log(ctx).Warn("settle batch charge failed", "batch_id", b.ID, "err", cerr)
			}
		}
	}
	unpaid, err := s.Store.ListUserByPIStatus(ctx, user.UID, store.PIChargeFailed, unpaidLimit)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	for _, conv := range unpaid {
		if conv.Stripe.BatchID != "" {
			continue // settled with its batch above
		}
		// Re-arm the charge (charge_failed → charge_pending) and run the
		// standard settlement path. A conflict means a concurrent settle
		// already claimed it — skip.
		armed, terr := s.Store.Transition(ctx, conv.ID, []string{store.StateSucceeded}, func(c *store.Conversion) error {
			if c.Stripe.PIStatus != store.PIChargeFailed {
				return store.ErrStateConflict
			}
			c.Stripe.PIStatus = store.PIChargePending
			return nil
		})
		if terr != nil {
			continue
		}
		if _, cerr := s.chargeConversion(ctx, armed); cerr != nil {
			httpx.Log(ctx).Warn("settle charge failed", "conversion_id", conv.ID, "err", cerr)
		}
	}

	remaining, err := s.Store.ListUserByPIStatus(ctx, user.UID, store.PIChargeFailed, unpaidLimit)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	stillFailed, _ := s.Store.ListUserBatchesByState(ctx, user.UID, store.BatchFailed, unpaidLimit)
	resp := map[string]any{
		"settled":         len(remaining) == 0 && len(stillFailed) == 0,
		"publishable_key": s.Stripe.PublishableKey,
	}
	for _, b := range stillFailed {
		entry := s.failedBatchEntry(ctx, b)
		if entry["needs_action"] == true {
			resp["requires_action"] = true
			resp["client_secret"] = entry["client_secret"]
			break
		}
	}
	for _, conv := range remaining {
		if resp["requires_action"] == true {
			break
		}
		entry := s.unpaidEntry(ctx, conv)
		if entry["needs_action"] == true {
			resp["requires_action"] = true
			resp["client_secret"] = entry["client_secret"]
			break
		}
	}
	if len(remaining)+len(stillFailed) > 0 && resp["requires_action"] != true {
		resp["message"] = "The charge was declined again. Update your card in the billing portal, then retry."
	}
	httpx.WriteOK(w, resp)
}

// requireBillable gates paid pro-step creation: a default card must be on
// file and no automatic charge may be outstanding. 402s carry machine codes
// the web client routes on (no_payment_method → onboarding; billing_overdue
// → settle flow).
func (s *Service) requireBillable(ctx context.Context, user *AuthedUser) (*store.Customer, error) {
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	if err == nil && cust.DefaultPaymentMethod == "" && cust.StripeCustomerID != "" {
		// The card cache may be cold right after a SetupIntent confirm
		// (only /v1/billing's read path heals it) — refresh before 402ing
		// a user whose card IS on file at Stripe. See HandleLimits.
		cust = s.refreshCardCache(ctx, user.UID, cust.StripeCustomerID)
	}
	if errors.Is(err, store.ErrNotFound) || (err == nil && cust.DefaultPaymentMethod == "") {
		return nil, httpx.Err(http.StatusPaymentRequired, "no_payment_method",
			"add a payment method before starting a conversion")
	}
	if err != nil {
		return nil, err
	}
	unpaid, err := s.Store.ListUserByPIStatus(ctx, user.UID, store.PIChargeFailed, 1)
	if err != nil {
		return nil, err
	}
	if len(unpaid) > 0 {
		return nil, httpx.Err(http.StatusPaymentRequired, "billing_overdue",
			"an automatic payment failed — settle your balance before starting new work")
	}
	return s.ensureLifetimeSeeded(ctx, user.UID, cust), nil
}
