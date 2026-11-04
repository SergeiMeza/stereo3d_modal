package api

import (
	"context"
	"log/slog"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The app Pro onboarding variant (owner 2026-11-04): someone holding the
// Spatial Video Studio app's Pro gets onboarding.variant "app_pro" (its own
// welcome, once: app_pro_welcome_done), and the headsets the app already
// knows prefill the welcome (headsets_from_app).
//
// App Pro is an active Pro entitlement bought in the App Store or the Mac
// App Store, or a promotional grant that isn't ours (we grant "pro"
// promotionally beside a web plan). Not app Pro: Pro bought on the web
// (stripe, rc_billing) and Pro that comes with Business or Studio. On
// test, PATCH simulate_app_pro makes an account read as app Pro for the
// variant and the Pro price tier; prod refuses it.

const (
	variantDefault = "default"
	variantAppPro  = "app_pro"
)

// simulatedAppPro: the test switch, never on prod.
func (s *Service) simulatedAppPro(cust *store.Customer) bool {
	return cust != nil && cust.SimulateAppPro && s.Cfg != nil && s.Cfg.Env != "prod"
}

// appPro reports whether the account holds the app's Pro (any doubt: no).
func (s *Service) appPro(ctx context.Context, uid string, cust *store.Customer) bool {
	if s.simulatedAppPro(cust) {
		return true
	}
	if !s.RevenueCat.Configured() {
		return false
	}
	st, err := s.RevenueCat.Pro(ctx, uid)
	if err != nil || !st.Pro || st.Tier != "" {
		return false
	}
	switch st.Store {
	case "app_store", "mac_app_store":
		return true
	case "promotional":
		return !ourPlanGrantActive(cust, time.Now().UTC())
	}
	return false
}

// ourPlanGrantActive: we granted "pro" promotionally with a web plan, and
// that grant still runs.
func ourPlanGrantActive(cust *store.Customer, now time.Time) bool {
	if cust == nil || cust.Plan == nil {
		return false
	}
	p := cust.Plan
	return p.RCGrantedUntil != nil && p.RCGrantedUntil.After(now) && p.RCRevokedAt == nil
}

// appViewingAnswers maps the app's viewingDevice answer to the web's id
// ("" = none) and to the answer as we report it.
var appViewingAnswers = map[string]struct{ webID, answer string }{
	"appleVisionPro": {"avp", "apple_vision_pro"},
	"otherHeadset":   {"", "other_headset"}, // which headset isn't known
	"screenOnly":     {"", "screen_only"},
}

// headsetsFromApp is what the app knows, mapped to the web's ids: its
// onboarding answer (only Apple Vision Pro maps to one device), else the
// app having run on a Vision Pro. source: app_answer | app_device | "".
func headsetsFromApp(av *store.AppViewing) (ids []string, source, answer string) {
	ids = []string{}
	if av == nil {
		return ids, "", ""
	}
	if av.Answered {
		if a, ok := appViewingAnswers[av.ViewingDevice]; ok {
			answer = a.answer
			if a.webID != "" {
				return []string{a.webID}, "app_answer", answer
			}
		}
	}
	for _, d := range av.UsedDevices {
		if strings.HasPrefix(d, "RealityDevice") {
			return []string{"avp"}, "app_device", answer
		}
	}
	return ids, "", answer
}

// appOnboarding is the variant part of GET /v1/account/settings.
func (s *Service) appOnboarding(ctx context.Context, uid string, cust *store.Customer, ob map[string]any) {
	variant := variantDefault
	if s.appPro(ctx, uid, cust) {
		variant = variantAppPro
	}
	ob["variant"] = variant
	ob["app_pro_welcome_done"] = cust != nil && cust.Onboarding != nil && cust.Onboarding.AppProWelcomeDone
	var av *store.AppViewing
	if s.Store != nil {
		var err error
		if av, err = s.Store.GetAppViewing(ctx, uid); err != nil {
			slog.WarnContext(ctx, "app viewing answer unreadable", "uid", uid, "err", err)
		}
	}
	ids, source, answer := headsetsFromApp(av)
	ob["headsets_from_app"] = ids
	ob["headsets_from_app_source"] = nilIfEmpty(source)
	ob["app_viewing_device"] = nilIfEmpty(answer)
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}
