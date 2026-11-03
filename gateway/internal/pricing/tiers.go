package pricing

import (
	"math"
	"slices"
)

// Tier pricing (Stereo3D pricing proposal 2026-11, BL-19; owner-approved
// for TEST 2026-11-03, prod defaults unchanged). With tier_pricing on:
//
//   - Lifelike has four explicit price tables per preset, per output
//     minute at 24 fps: list, Pro (~15% off), Business (~20%), Studio
//     (~25%) (owner 2026-11-04); Classic takes tier_pct off its own
//     prices (production).
//   - Add-ons ride on top of the run's price, as shares of its base:
//     Foveated Detail +30%, Master bitrate +20%, Express +50% (included
//     in Business and Studio).
//   - Bulk: bulk_pct off runs whose list total is over the threshold
//     ($50). Never stacked: a run gets the bigger of bulk and its tier.
//     The quote names the one discount that applied.
//   - Free previews per plan period (see FreePreviewAllowance); a free
//     preview quotes $0.

// Subscriber tiers, best first.
const (
	TierNone     = ""
	TierPro      = "pro"
	TierBusiness = "business"
	TierStudio   = "studio"
)

// Add-on names.
const (
	AddOnFoveated = "foveated"
	AddOnMaster   = "master"
	AddOnExpress  = "express"
)

// PlanDef is a web plan (Business, Studio): Stripe Billing subscription on
// the web's own product, its monthly credit spent at the plan's prices.
type PlanDef struct {
	Name            string `firestore:"name" json:"name"`
	MonthlyCents    int64  `firestore:"monthly_cents" json:"monthly_cents"`
	CreditCents     int64  `firestore:"credit_cents" json:"credit_cents"`
	MaxActiveRuns   int    `firestore:"max_active_runs" json:"max_active_runs"`
	Seats           int    `firestore:"seats" json:"seats"`
	FreePreviews    int    `firestore:"free_previews" json:"free_previews_per_period"`
	ExpressIncluded bool   `firestore:"express_included" json:"express_included"`
	StripePriceID   string `firestore:"stripe_price_id" json:"-"`
	// Interval: how the plan bills (month | year; "" = month); PriceCents
	// what each bill is (Studio: $11,988 a year). The credit and the free
	// previews always come every month (credit_interval).
	Interval       string `firestore:"interval" json:"interval"`
	PriceCents     int64  `firestore:"price_cents" json:"price_cents"`
	CreditInterval string `firestore:"-" json:"credit_interval"`
	LookupKey      string `firestore:"lookup_key" json:"-"`
}

// Yearly: the plan bills once a year (its credit still comes monthly).
func (p PlanDef) Yearly() bool { return p.Interval == "year" }

func testLifelikeList() map[string]int64 {
	return map[string]int64{"1080p": 400, "qhd": 550, "3k": 800, "4k": 1000, "5k": 1600, "6k": 2000, "8k": 2800}
}

func testLifelikeTiers() map[string]map[string]int64 {
	return map[string]map[string]int64{
		TierPro:      {"1080p": 340, "qhd": 470, "3k": 680, "4k": 850, "5k": 1360, "6k": 1700, "8k": 2380},
		TierBusiness: {"1080p": 320, "qhd": 440, "3k": 640, "4k": 800, "5k": 1280, "6k": 1600, "8k": 2240},
		TierStudio:   {"1080p": 300, "qhd": 410, "3k": 600, "4k": 750, "5k": 1200, "6k": 1500, "8k": 2100},
	}
}

func defaultTierPct() map[string]float64 {
	return map[string]float64{TierPro: 0.15, TierBusiness: 0.20, TierStudio: 0.25} // owner 2026-11-04 (was 25%/30%)
}

func defaultAddOnPct() map[string]float64 {
	return map[string]float64{AddOnFoveated: 0.30, AddOnMaster: 0.20, AddOnExpress: 0.50}
}

// Stripe TEST prices (products "Stereo3D Studio Business" / "Studio",
// made 2026-11-03 in test mode only).
func testPlans() map[string]PlanDef {
	return map[string]PlanDef{
		TierBusiness: {Name: "Business", MonthlyCents: 29900, CreditCents: 40000, MaxActiveRuns: 3, Seats: 3,
			FreePreviews: 50, ExpressIncluded: true, Interval: "month", PriceCents: 29900, CreditInterval: "month",
			LookupKey: "svs_web_business_monthly", StripePriceID: "price_1UXaxSAVV5NpxADIFAwxnmfV"},
		// Studio bills yearly (owner 2026-11-04): $11,988 (12 × $999), with
		// $1,500 of credit and 200 free previews every month of the year.
		TierStudio: {Name: "Studio", MonthlyCents: 99900, CreditCents: 150000, MaxActiveRuns: 8, Seats: 10,
			FreePreviews: 200, ExpressIncluded: true, Interval: "year", PriceCents: 1198800, CreditInterval: "month",
			LookupKey: "svs_web_studio_yearly", StripePriceID: "price_1UXjsfAVV5NpxADIVWtelcNn"},
	}
}

// Free previews per period, by what the person holds (no rollover).
func defaultFreePreviews() map[string]int {
	return map[string]int{
		"pro_weekly": 5, "pro_monthly": 20, "pro_yearly": 240, "pro_pass_3m": 60, "pro_pass_6m": 120,
		"pro_lifetime": 20, // per month: Lifetime keeps the Monthly-sized allowance
		TierBusiness:   50, TierStudio: 200,
		"intro": 1, // non-subscribers: one on their first project
	}
}

// applyTestTierDefaults switches the test environment to the 2026-11
// pricing.
func applyTestTierDefaults(r *Rates) {
	r.TierPricing = true
	r.LifelikePriceCentsPerMinute = testLifelikeList()
	r.LifelikeTierPrices = testLifelikeTiers()
	r.DiscountThresholdCents = 5000
	r.FreePreviewsEnabled = true
	r.PlansEnabled = true
	r.Plans = testPlans()
	r.RateVersion = "2026-11-03.tiers-test"
}

// TierPct is a tier's share off Classic prices (and the nominal share of
// the Lifelike tables).
func (r *Rates) TierPct(tier string) float64 {
	if tier == TierNone {
		return 0
	}
	if v, ok := r.TierPctOverride[tier]; ok && v >= 0 {
		return min(v, 0.9)
	}
	return defaultTierPct()[tier]
}

// AddOnPct is an add-on's share of the base.
func (r *Rates) AddOnPct(name string) float64 {
	if v, ok := r.AddOnPctOverride[name]; ok && v >= 0 {
		return v
	}
	if name == AddOnFoveated && r.FoveationPriceMultiplier > 0 {
		return r.FoveationPriceMultiplier - 1
	}
	return defaultAddOnPct()[name]
}

// LifelikeTierPrice is a preset's per-minute price for a tier (list when
// the tier has no table entry).
func (r *Rates) LifelikeTierPrice(tier, preset string) (int64, bool) {
	list, ok := r.lifelikePrice(preset)
	if !ok || tier == TierNone {
		return list, ok
	}
	if v := r.LifelikeTierPrices[tier][preset]; v > 0 {
		return v, true
	}
	if v := testLifelikeTiers()[tier][preset]; v > 0 && r.TierPricing {
		return v, true
	}
	return list, true
}

// Plan is a plan's definition (ok=false when unknown or plans are off).
func (r *Rates) Plan(tier string) (PlanDef, bool) {
	if !r.PlansEnabled {
		return PlanDef{}, false
	}
	p, ok := r.Plans[tier]
	if p.Interval == "" {
		p.Interval = "month"
	}
	if p.PriceCents == 0 {
		p.PriceCents = p.MonthlyCents
	}
	p.CreditInterval = "month" // the credit always comes monthly
	return p, ok
}

// FreePreviewAllowance is the number of free previews for an allowance
// key (pro_monthly, business, intro, …).
func (r *Rates) FreePreviewAllowance(key string) int {
	if !r.FreePreviewsEnabled {
		return 0
	}
	if v, ok := r.FreePreviewsOverride[key]; ok {
		return v
	}
	if p, ok := r.Plan(key); ok && p.FreePreviews > 0 {
		return p.FreePreviews
	}
	return defaultFreePreviews()[key]
}

// FreePreviewDailyCap is the fair-use cap on free previews a day (20).
func (r *Rates) FreePreviewDailyCap() int {
	if r.FreePreviewsPerDay > 0 {
		return r.FreePreviewsPerDay
	}
	return 20
}

// FreePreviewSeconds is one free preview's length (5 s).
func (r *Rates) FreePreviewSeconds() float64 {
	if r.FreePreviewUnitSeconds > 0 {
		return r.FreePreviewUnitSeconds
	}
	return 5
}

// PreviewUnits is how many free previews a preview uses: one per 5 s
// started, doubled for Cinema (5K-8K) and for 60 fps.
func (r *Rates) PreviewUnits(preset string, seconds, fps float64) int {
	n := int(math.Ceil(seconds/r.FreePreviewSeconds() - 1e-9))
	n = max(n, 1)
	if slices.Contains([]string{"5k", "6k", "8k"}, preset) || fps >= 50 {
		n *= 2
	}
	return n
}

// tierQuote is the 2026-11 composition of one run: the list and tier
// bases, add-ons on each, bulk on the list total, and the one discount
// that gives the lowest price.
type tierQuote struct {
	ListBase, TierBase int64
	AddOns             map[string]int64 // on the list base
	AddOnPct           float64
	ListTotal          int64
	Final              int64
	DiscountKind       string // tier | bulk | ""
	DiscountCents      int64
	DiscountPct        float64
}

func (r *Rates) composeTier(listBase, tierBase int64, tier string, addOns []string, bulkAllowed bool) tierQuote {
	q := tierQuote{ListBase: listBase, TierBase: tierBase, AddOns: map[string]int64{}}
	for _, a := range addOns {
		pct := r.AddOnPct(a)
		q.AddOnPct += pct
		q.AddOns[a] = int64(math.Round(float64(listBase) * pct))
	}
	withAdds := func(base int64) int64 { return base + int64(math.Round(float64(base)*q.AddOnPct)) }
	q.ListTotal = withAdds(listBase)
	q.Final = q.ListTotal
	if tier != TierNone && tierBase < listBase {
		if t := withAdds(tierBase); t < q.Final {
			q.Final, q.DiscountKind = t, "tier"
			q.DiscountPct = r.TierPct(tier)
		}
	}
	if bulkAllowed && q.ListTotal > r.DiscountThresholdCents && r.DiscountPct > 0 {
		if b := q.ListTotal - int64(math.Round(float64(q.ListTotal)*r.DiscountPct)); b < q.Final {
			q.Final, q.DiscountKind, q.DiscountPct = b, "bulk", r.DiscountPct
		}
	}
	q.DiscountCents = q.ListTotal - q.Final
	return q
}

func (q tierQuote) discountJSON(tier string) map[string]any {
	if q.DiscountKind == "" {
		return nil
	}
	d := map[string]any{"kind": q.DiscountKind, "cents": q.DiscountCents, "pct": q.DiscountPct}
	if q.DiscountKind == "tier" {
		d["tier"] = tier
	}
	return d
}

// quoteLifelikeTiers is QuoteLifelike under tier pricing.
func (r *Rates) quoteLifelikeTiers(in StepInputs, listPerMin int64) (*Quote, error) {
	in.Tier = tierOf(in)
	tierPerMin, _ := r.LifelikeTierPrice(in.Tier, in.Preset)
	var addOns []string
	if in.Foveated {
		addOns = append(addOns, AddOnFoveated)
	}
	if in.Master {
		addOns = append(addOns, AddOnMaster)
	}
	expressIncluded := false
	if in.Express {
		if p, ok := r.Plan(in.Tier); ok && p.ExpressIncluded {
			expressIncluded = true
		} else {
			addOns = append(addOns, AddOnExpress)
		}
	}
	bd := map[string]any{
		"step": in.Step, "method": MethodLifelike, "preset": in.Preset,
		"billable_seconds":      math.Round(in.BillableS*100) / 100,
		"list_cents_per_minute": listPerMin, "cents_per_minute": tierPerMin,
		"tier": in.Tier, "pro": in.Tier != TierNone, "pricing": "tiers",
		"express": in.Express, "express_included": expressIncluded,
		"analyze_credit_cents": in.CreditCents,
	}
	var q tierQuote
	if in.Step == StepLifelikePreview {
		fps := in.EffectiveFPS
		if fps <= 0 {
			fps = fpsBase
		}
		frames := math.Round(in.BillableS * fps)
		perFrame := func(perMin int64) int64 { return int64(math.Round(frames * float64(perMin) / (60 * fpsBase))) }
		q = r.composeTier(perFrame(listPerMin), perFrame(tierPerMin), in.Tier, addOns, false) // previews: no bulk
		bd["frames"] = int64(frames)
		bd["cents_per_frame"] = round4(float64(tierPerMin) / (60 * fpsBase))
		bd["free_preview_units"] = in.Units
	} else {
		fpsF := fpsFactor(in.EffectiveFPS)
		base := func(perMin int64) int64 { return int64(math.Ceil(in.BillableS / 60 * float64(perMin) * fpsF)) }
		q = r.composeTier(base(listPerMin), base(tierPerMin), in.Tier, addOns, true)
		bd["fps_factor"] = round4(fpsF)
	}
	total := q.Final - in.CreditCents
	if floor := r.MinimumFor(in.Step); total < floor {
		total = floor
	}
	if in.FreePreview && in.Step == StepLifelikePreview {
		bd["free_preview"] = true
		bd["price_without_free_cents"] = total
		total = 0
	}
	r.fillTierBreakdown(bd, q, in)
	return &Quote{AmountCents: total, Currency: r.Currency, RateVersion: r.RateVersion, Breakdown: bd}, nil
}

// quoteClassicTiers finishes a Classic quote under tier pricing: Master
// bitrate on top, then the tier's share (production) or bulk, never both.
func (r *Rates) quoteClassicTiers(in StepInputs, afterReuse int64, bd map[string]any) *Quote {
	in.Tier = tierOf(in)
	var addOns []string
	if in.Master {
		addOns = append(addOns, AddOnMaster)
	}
	tierBase := afterReuse
	if in.Tier != TierNone && in.Step == "production" {
		tierBase = afterReuse - int64(math.Round(float64(afterReuse)*r.TierPct(in.Tier)))
	}
	q := r.composeTier(afterReuse, tierBase, in.Tier, addOns, true)
	total := q.Final - in.CreditCents
	if floor := r.MinimumFor(in.Step); total < floor {
		total = floor
	}
	bd["tier"], bd["pro"], bd["pricing"] = in.Tier, in.Tier != TierNone, "tiers"
	bd["analyze_credit_cents"] = in.CreditCents
	r.fillTierBreakdown(bd, q, in)
	return &Quote{AmountCents: total, Currency: r.Currency, RateVersion: r.RateVersion, Breakdown: bd}
}

// fillTierBreakdown writes the tier lines, keeping the older keys the
// web reads (subtotal_cents, discount_cents for bulk, pro_discount_* for
// the tier).
func (r *Rates) fillTierBreakdown(bd map[string]any, q tierQuote, in StepInputs) {
	bd["list_base_cents"], bd["base_cents"] = q.ListBase, q.ListBase
	bd["addons"], bd["addon_pct"] = q.AddOns, round4(q.AddOnPct)
	if c, ok := q.AddOns[AddOnFoveated]; ok {
		bd["foveation_cents"], bd["foveation_multiplier"] = c, 1+r.AddOnPct(AddOnFoveated)
	} else {
		bd["foveation_cents"], bd["foveation_multiplier"] = int64(0), 1.0
	}
	bd["subtotal_cents"] = q.ListTotal // list price with add-ons, before the discount
	bd["discount"] = q.discountJSON(in.Tier)
	bd["discount_cents"], bd["pro_discount_cents"], bd["pro_discount_pct"] = int64(0), int64(0), 0.0
	switch q.DiscountKind {
	case "bulk":
		bd["discount_cents"] = q.DiscountCents
	case "tier":
		bd["pro_discount_cents"], bd["pro_discount_pct"] = q.DiscountCents, q.DiscountPct
	}
}

// tierOf reads the tier, with Pro (S3D-67 callers) as the Pro tier.
func tierOf(in StepInputs) string {
	if in.Tier == TierNone && in.Pro {
		return TierPro
	}
	return in.Tier
}

// publicTiers adds the 2026-11 pricing to GET /v1/pricing: the four
// Lifelike tables, Classic's tier shares, add-ons, plans and free
// previews. The S3D-67 pro_discount key reads the Pro tier's share.
func (r *Rates) publicTiers(out map[string]any, enabled []string) {
	tables := map[string]map[string]int64{TierNone: {}}
	for _, t := range []string{TierPro, TierBusiness, TierStudio} {
		tables[t] = map[string]int64{}
	}
	for _, p := range enabled {
		for t := range tables {
			if v, ok := r.LifelikeTierPrice(t, p); ok {
				tables[t][p] = v
			}
		}
	}
	plans := map[string]any{}
	for _, t := range []string{TierBusiness, TierStudio} {
		if p, ok := r.Plan(t); ok {
			plans[t] = p
		}
	}
	allow := map[string]int{}
	for _, k := range []string{"pro_weekly", "pro_monthly", "pro_yearly", "pro_pass_3m", "pro_pass_6m", "pro_lifetime", TierBusiness, TierStudio, "intro"} {
		allow[k] = r.FreePreviewAllowance(k)
	}
	out["pricing_model"] = "tiers"
	out["tiers"] = map[string]any{
		"order": []string{TierStudio, TierBusiness, TierPro, "list"},
		// per output minute at 24 fps (fps factors unchanged), per preset
		"lifelike_cents_per_minute": map[string]any{
			"list": tables[TierNone], TierPro: tables[TierPro], TierBusiness: tables[TierBusiness], TierStudio: tables[TierStudio],
		},
		// Classic: the tier's share off its own production prices
		"classic_pct": map[string]float64{TierPro: r.TierPct(TierPro), TierBusiness: r.TierPct(TierBusiness), TierStudio: r.TierPct(TierStudio)},
		"pro_is":      "the SVS Pro entitlement or a running pass",
	}
	out["addons"] = map[string]any{
		AddOnFoveated: map[string]any{"pct": r.AddOnPct(AddOnFoveated), "methods": []string{"lifelike"}, "enabled": r.FoveationEnabled},
		AddOnMaster:   map[string]any{"pct": r.AddOnPct(AddOnMaster), "methods": []string{"lifelike", "classic"}, "request": map[string]any{"bitrate": "master"}},
		AddOnExpress: map[string]any{"pct": r.AddOnPct(AddOnExpress), "methods": []string{"lifelike"}, "request": map[string]any{"express": true},
			"included_in": []string{TierBusiness, TierStudio}, "effect": "first in the GPU line"},
		"on": "the run's price at its tier, before the bulk discount",
	}
	out["discount"] = map[string]any{"threshold_cents": r.DiscountThresholdCents, "pct": r.DiscountPct,
		"stacks_with_tier": false, "rule": "a run gets the bigger of bulk and its tier price, never both"}
	out["pro_discount"] = map[string]any{"pct": r.TierPct(TierPro), "applies_to": "production", "tiered": true}
	out["plans"] = plans
	out["free_previews"] = map[string]any{
		"enabled":       r.FreePreviewsEnabled,
		"allowances":    allow, // per period; intro = a non-subscriber's first project
		"periods":       map[string]string{"pro_weekly": "week", "pro_monthly": "month", "pro_yearly": "year", "pro_pass_3m": "pass", "pro_pass_6m": "pass", "pro_lifetime": "month", TierBusiness: "month", TierStudio: "month"},
		"unit_seconds":  r.FreePreviewSeconds(),
		"counts_double": []string{"5k", "6k", "8k", "60fps"},
		"daily_cap":     r.FreePreviewDailyCap(),
		"rollover":      false,
	}
}
