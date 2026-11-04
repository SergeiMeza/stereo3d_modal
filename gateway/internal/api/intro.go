package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"golang.org/x/text/language"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Lifelike brand intro (BL-25). Every Lifelike run gets the intro: 3 s on
// previews, 4 s otherwise (free, paid, Express), in the customer's
// language. Only an account with an active Business or Studio plan may
// turn it off. The intro is never billed: quotes, holds and charges use
// the customer's own video length. Behind lifelike_intro_enabled (code
// default false until the pipeline's API is live on test): off, no intro
// field is sent at all.

const (
	introPreviewS = 3
	introRunS     = 4
)

// normalizeLocale turns a locale or an Accept-Language value into the
// BCP-47 tag the pipeline reads: the language alone (ja, de, en), except
// Chinese by script (zh-Hans, zh-Hant) and Portuguese by region (pt-BR,
// pt-PT). "" when nothing parses.
func normalizeLocale(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	var tag language.Tag
	if tags, _, err := language.ParseAcceptLanguage(raw); err == nil && len(tags) > 0 {
		tag = tags[0]
	} else if t, err := language.Parse(raw); err == nil {
		tag = t
	} else {
		return ""
	}
	base, conf := tag.Base()
	if conf == language.No || base.String() == "und" {
		return ""
	}
	switch base.String() {
	case "zh":
		script, _ := tag.Script()
		if s := script.String(); s == "Hant" || s == "Hans" {
			return "zh-" + s
		}
		return "zh-Hans"
	case "pt":
		region, _ := tag.Region()
		return "pt-" + region.String()
	}
	return base.String()
}

// introLanguage is the account's saved locale, else the request's
// Accept-Language, else English.
func introLanguage(cust *store.Customer, r *http.Request) string {
	if cust != nil && cust.Locale != "" {
		return cust.Locale
	}
	if r != nil {
		if l := normalizeLocale(r.Header.Get("Accept-Language")); l != "" {
			return l
		}
	}
	return "en"
}

// introOptOutAllowed: only an active Business or Studio plan may turn the
// intro off.
func introOptOutAllowed(cust *store.Customer, now time.Time) bool {
	return cust != nil && cust.Plan.Active(now) && (cust.Plan.Tier == pricing.TierBusiness || cust.Plan.Tier == pricing.TierStudio)
}

// applyIntro records the intro on a new Lifelike run's params (sent by
// lifelikeBody at submit). Nothing when the flag is off.
func (s *Service) applyIntro(ctx context.Context, r *http.Request, uid, step string, params *store.Params) {
	if !s.Pricing.Rates(ctx).LifelikeIntroEnabled {
		return
	}
	var cust *store.Customer
	if s.Store != nil {
		cust, _ = s.Store.GetCustomer(ctx, uid)
	}
	secs := introRunS
	if step == store.StepLifelikePreview {
		secs = introPreviewS
	}
	if cust != nil && cust.LifelikeIntroOff && introOptOutAllowed(cust, time.Now()) {
		secs = 0 // a Business/Studio plan's opt-out
	}
	params.IntroS = &secs
	params.IntroLanguage = introLanguage(cust, r)
}

// GET /v1/account/settings → {lifelike_intro, lifelike_intro_editable,
// locale}; PATCH {lifelike_intro?, locale? (null clears)} → the same.
// lifelike_intro (default true) can be changed only while a Business or
// Studio plan is active (409 plan_required); without one it reads true.
func (s *Service) HandleAccountSettings(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	if r.Method == http.MethodPatch {
		var req struct {
			LifelikeIntro  *bool           `json:"lifelike_intro"`
			Locale         json.RawMessage `json:"locale"`
			Dismissed      json.RawMessage `json:"dismissed"`
			SimulateAppPro *bool           `json:"simulate_app_pro"`
			onboardingPatch
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10)).Decode(&req); err != nil {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
			return
		}
		if verr := req.onboardingPatch.validate(); verr != nil {
			httpx.WriteErr(ctx, w, verr)
			return
		}
		dismissed, derr := parseDismissed(req.Dismissed, time.Now().UTC())
		if derr != nil {
			httpx.WriteErr(ctx, w, derr)
			return
		}
		if req.SimulateAppPro != nil && (s.Cfg == nil || s.Cfg.Env == "prod") {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusForbidden, "test_only", "simulate_app_pro is for test only"))
			return
		}
		if _, err := s.ensureCustomerID(ctx, user); err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		cust, err := s.Store.GetCustomer(ctx, user.UID)
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		if req.LifelikeIntro != nil && !introOptOutAllowed(cust, time.Now()) {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "plan_required",
				"Only Business and Studio plans can turn the intro off."))
			return
		}
		var locale *string
		if len(req.Locale) > 0 {
			var v *string
			if json.Unmarshal(req.Locale, &v) != nil {
				httpx.WriteErr(ctx, w, httpx.ErrInvalid("locale is a BCP-47 tag or null"))
				return
			}
			n := ""
			if v != nil {
				if n = normalizeLocale(*v); n == "" {
					httpx.WriteErr(ctx, w, httpx.ErrInvalid("locale is a BCP-47 tag such as ja, pt-BR or zh-Hans"))
					return
				}
			}
			locale = &n
		}
		if _, err := s.Store.UpdateCustomer(ctx, user.UID, func(c *store.Customer) error {
			if req.LifelikeIntro != nil {
				c.LifelikeIntroOff = !*req.LifelikeIntro
			}
			if locale != nil {
				c.Locale = *locale
			}
			req.onboardingPatch.apply(c)
			if req.SimulateAppPro != nil {
				c.SimulateAppPro = *req.SimulateAppPro
				slog.WarnContext(ctx, "TEST simulate_app_pro set", "uid", user.UID, "simulate_app_pro", c.SimulateAppPro, "env", s.Cfg.Env)
			}
			for k, t := range dismissed {
				if c.Dismissed == nil {
					c.Dismissed = map[string]time.Time{}
				}
				if t == nil {
					delete(c.Dismissed, k)
				} else {
					c.Dismissed[k] = *t
				}
			}
			return nil
		}); err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
	}
	cust, _ := s.Store.GetCustomer(ctx, user.UID)
	editable := introOptOutAllowed(cust, time.Now())
	out := map[string]any{"lifelike_intro": !(editable && cust.LifelikeIntroOff), "lifelike_intro_editable": editable, "locale": nil}
	if cust != nil && cust.Locale != "" {
		out["locale"] = cust.Locale
	}
	for k, v := range s.onboardingSettings(ctx, user.UID, cust) { // owner 2026-11-04
		out[k] = v
	}
	out["dismissed"] = dismissedJSON(cust) // plans surfaces dismissed (placement → time)
	httpx.WriteOK(w, out)
}
