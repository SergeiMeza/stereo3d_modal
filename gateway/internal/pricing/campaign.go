package pricing

import (
	"math"
	"slices"
	"strconv"
	"time"
)

// Launch campaign (owner 2026-11-07): pct off web production runs, Lifelike
// and Classic alike ("web app only", "up to 2K"), whose output preset is
// at most max_preset (qhd: 1080p and 1440p; "2K"
// is 2560×1440, there's no 2K preset), between starts_at and ends_at
// (open-ended without it). It comes after the plan or Pro discount, on the
// whole run (base plus add-ons: quality, Foveated, express), then the
// per-run minimum holds, then credit and balance pay first. The app paths
// and the mobile one-shot get nothing.
type CampaignDef struct {
	Enabled bool `firestore:"enabled" json:"enabled"`
	// Pct: 25 or 0.25 both mean a quarter off.
	Pct       float64    `firestore:"pct" json:"pct"`
	MaxPreset string     `firestore:"max_preset" json:"max_preset"`
	StartsAt  *time.Time `firestore:"starts_at" json:"starts_at"`
	EndsAt    *time.Time `firestore:"ends_at" json:"ends_at"`
	Label     string     `firestore:"label" json:"label"`
}

// testCampaign: TEST runs it from 2026-11-07 so it can be tried; prod
// has none until the release (starts_at set with the owner's yes).
func testCampaign() *CampaignDef {
	start := time.Date(2026, 11, 7, 0, 0, 0, 0, time.UTC)
	end := time.Date(2027, 1, 11, 7, 59, 59, 0, time.UTC) // the end of Jan 10, Pacific
	return &CampaignDef{Enabled: true, Pct: 25, MaxPreset: "qhd", StartsAt: &start, EndsAt: &end, Label: "Launch offer until Jan 10"}
}

// CampaignShare is the campaign's fraction off, held to [0, 0.9].
func (r *Rates) CampaignShare() float64 {
	c := r.Campaign
	if c == nil {
		return 0
	}
	p := c.Pct
	if p > 1 {
		p /= 100
	}
	return math.Max(0, math.Min(p, 0.9))
}

// CampaignActive: on, started and not ended at now.
func (r *Rates) CampaignActive(now time.Time) bool {
	c := r.Campaign
	if c == nil || !c.Enabled || r.CampaignShare() <= 0 || c.StartsAt == nil || now.Before(*c.StartsAt) {
		return false
	}
	return c.EndsAt == nil || now.Before(*c.EndsAt)
}

// CampaignCovers: the output preset is at or below max_preset (qhd when
// unset); presets outside the Lifelike list never are.
func (r *Rates) CampaignCovers(preset string) bool {
	max := "qhd"
	if r.Campaign != nil && r.Campaign.MaxPreset != "" {
		max = r.Campaign.MaxPreset
	}
	i, j := slices.Index(LifelikePresets, preset), slices.Index(LifelikePresets, max)
	return i >= 0 && j >= 0 && i <= j
}

// CampaignLabel is the breakdown line: "Launch offer −25%".
func (r *Rates) CampaignLabel() string {
	return "Launch offer −" + strconv.Itoa(int(math.Round(r.CampaignShare()*100))) + "%"
}

// campaignCents is a run's campaign line (0 when it doesn't apply).
func (r *Rates) campaignCents(in StepInputs, afterDiscount int64) int64 {
	if !in.Web || in.Step != "production" || !r.CampaignCovers(cmpOr(in.OutputPreset, in.Preset)) {
		return 0
	}
	now := in.Now
	if now.IsZero() {
		now = time.Now()
	}
	if !r.CampaignActive(now) {
		return 0
	}
	return int64(math.Round(float64(afterDiscount) * r.CampaignShare()))
}

// applyCampaign writes the offer's lines into a quote's breakdown and
// returns its cents (both methods: Lifelike and Classic, owner 2026-11-07).
func (r *Rates) applyCampaign(in StepInputs, afterDiscount int64, bd map[string]any) int64 {
	campaign := r.campaignCents(in, afterDiscount)
	bd["campaign_cents"] = campaign
	if campaign > 0 {
		bd["campaign_label"], bd["campaign_pct"] = r.CampaignLabel(), round4(r.CampaignShare())
		if r.Campaign.Label != "" {
			bd["campaign_name"] = r.Campaign.Label
		}
	}
	return campaign
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// PublicCampaign is GET /v1/pricing's campaign {active, pct, percent,
// max_preset, presets, methods, starts_at, ends_at, label}; active false without one.
func (r *Rates) PublicCampaign(now time.Time) map[string]any {
	out := map[string]any{"active": r.CampaignActive(now)}
	if r.Campaign == nil {
		return out
	}
	c := r.Campaign
	presets := []string{}
	for _, p := range LifelikePresets {
		if r.CampaignCovers(p) {
			presets = append(presets, p)
		}
	}
	out["pct"], out["percent"], out["max_preset"], out["presets"] = r.CampaignShare(), int(math.Round(r.CampaignShare()*100)), cmpOr(c.MaxPreset, "qhd"), presets
	out["starts_at"], out["ends_at"], out["label"] = c.StartsAt, c.EndsAt, c.Label
	out["methods"] = []string{"lifelike", "classic"} // both, web production only
	return out
}
