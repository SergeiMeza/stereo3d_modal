package api

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"golang.org/x/text/language"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Lifelike brand intro (BL-25). Every Lifelike run gets the intro: 3 s on
// previews, 4 s otherwise (free, paid, Express), in the customer's
// language. Only Commercial use removes it, on any plan (owner 2026-11-09;
// the Business/Studio opt-out is gone, its stored value ignored). The intro is never billed: quotes, holds and charges use
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
	if params.Commercial {
		secs = 0 // Commercial use has no brand intro (owner 2026-11-09)
	}
	params.IntroS = &secs
	params.IntroLanguage = introLanguage(cust, r)
}

// GET /v1/account/settings → {locale, mail_locale, notify_ready, …};
// PATCH {locale?
// (null clears), mail_locale? (null clears), notify_ready?} → the same.
// locale is the Lifelike intro's language; mail_locale the mails' (the
// web's UI language); notify_ready (default true) the "3D video ready"
// mail.
// lifelike_intro (the removed Business/Studio opt-out, owner 2026-11-09) is
// ignored in a PATCH.
func (s *Service) HandleAccountSettings(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	if r.Method == http.MethodPatch {
		var req struct {
			LifelikeIntro  *bool           `json:"lifelike_intro"`
			Locale         json.RawMessage `json:"locale"`
			Dismissed      json.RawMessage `json:"dismissed"`
			SimulateAppPro *bool           `json:"simulate_app_pro"`
			BusinessSetup  json.RawMessage `json:"business_setup"`
			// MailLocale: the language mails use (the web's UI language;
			// null clears). NotifyReady: the "3D video ready" mail.
			MailLocale  json.RawMessage `json:"mail_locale"`
			NotifyReady *bool           `json:"notify_ready"`
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
		bsetup, bsSet, bsErr := parseBusinessSetup(req.BusinessSetup, time.Now().UTC())
		if bsErr != nil {
			httpx.WriteErr(ctx, w, bsErr)
			return
		}
		var keepKeys map[string]bool
		if len(dismissed) > 0 {
			keys := []string{}
			if cur, cerr := s.Store.GetCustomer(ctx, user.UID); cerr == nil {
				for k := range cur.Dismissed {
					keys = append(keys, k)
				}
			}
			for k, t := range dismissed {
				keys = append(keys, k)
				if id := dismissedProject(k); id != "" && t != nil {
					if p, perr := s.Store.GetProject(ctx, id); perr != nil || p.UID != user.UID || p.Deleted {
						httpx.WriteErr(ctx, w, httpx.ErrInvalid("dismissed: "+strconv.Quote(k)+" isn't one of your projects"))
						return
					}
				}
			}
			var kerr error
			if keepKeys, kerr = s.keepDismissed(ctx, user.UID, keys); kerr != nil {
				httpx.WriteErr(ctx, w, kerr)
				return
			}
		}
		var mailLocale *string
		if len(req.MailLocale) > 0 {
			var v *string
			if json.Unmarshal(req.MailLocale, &v) != nil {
				httpx.WriteErr(ctx, w, httpx.ErrInvalid("mail_locale is a BCP-47 tag or null"))
				return
			}
			n := ""
			if v != nil {
				if n = normalizeLocale(*v); n == "" {
					httpx.WriteErr(ctx, w, httpx.ErrInvalid("mail_locale is a BCP-47 tag such as ja, de or zh-Hant"))
					return
				}
			}
			mailLocale = &n
		}
		if req.SimulateAppPro != nil && (s.Cfg == nil || s.Cfg.Env == "prod") {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusForbidden, "test_only", "simulate_app_pro is for test only"))
			return
		}
		if _, err := s.ensureCustomerID(ctx, user); err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		if _, err := s.Store.GetCustomer(ctx, user.UID); err != nil {
			httpx.WriteErr(ctx, w, err)
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
			if locale != nil {
				c.Locale = *locale
			}
			if mailLocale != nil {
				c.MailLocale = *mailLocale
			}
			if req.NotifyReady != nil {
				c.NotifyReadyOff = !*req.NotifyReady
			}
			req.onboardingPatch.apply(c)
			if bsSet {
				c.BusinessSetup = bsetup
			}
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
			if keepKeys != nil {
				for k := range c.Dismissed {
					if !keepKeys[k] {
						delete(c.Dismissed, k) // archived, deleted or not theirs
					}
				}
				capDismissed(c.Dismissed)
			}
			return nil
		}); err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
	}
	cust, _ := s.Store.GetCustomer(ctx, user.UID)
	out := map[string]any{"locale": nil}
	if cust != nil && cust.Locale != "" {
		out["locale"] = cust.Locale
	}
	out["mail_locale"], out["notify_ready"] = nil, cust == nil || !cust.NotifyReadyOff
	if cust != nil && cust.MailLocale != "" {
		out["mail_locale"] = cust.MailLocale
	}
	for k, v := range s.onboardingSettings(ctx, user.UID, cust) { // owner 2026-11-04
		out[k] = v
	}
	out["dismissed"] = dismissedJSON(cust)          // plans surfaces dismissed (placement → time)
	out["business_setup"] = businessSetupJSON(cust) // Business/Studio setup answers
	httpx.WriteOK(w, out)
}
