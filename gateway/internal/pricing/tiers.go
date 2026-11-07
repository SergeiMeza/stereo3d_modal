package pricing

import (
	"fmt"
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
	AddOnHigh     = "high" // High quality (owner 2026-11-07)
	AddOnExpress  = "express"
)

// PlanDef is a web plan (Business, Studio): Stripe Billing subscription on
// the web's own product, its monthly credit spent at the plan's prices.
type PlanDef struct {
	Name            string `firestore:"name" json:"name"`
	MonthlyCents    int64  `firestore:"monthly_cents" json:"monthly_cents"`
	CreditCents     int64  `firestore:"credit_cents" json:"credit_cents"`
	MaxActiveRuns   int    `firestore:"max_active_runs" json:"max_active_runs"`
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
	// MaxFPS: the top output rate the plan allows (120; without a plan 30,
	// /v1/pricing fps).
	MaxFPS int `firestore:"-" json:"max_fps"`
}

// ProPlanDef is a web Pro plan on our own Stripe (owner 2026-11-04): the
// App Store's prices, an intro modelled as a once-coupon on the first
// invoice (and, for Weekly, on the next cycles' draft invoices).
type ProPlanDef struct {
	ID            string    `firestore:"id" json:"id"`             // pro_weekly | pro_monthly | pro_yearly
	Interval      string    `firestore:"interval" json:"interval"` // week | month | year
	PriceCents    int64     `firestore:"price_cents" json:"price_cents"`
	Intro         *ProIntro `firestore:"intro,omitempty" json:"intro"`
	StripePriceID string    `firestore:"stripe_price_id" json:"-"`
	LookupKey     string    `firestore:"lookup_key" json:"-"`
	// CreditCents: the one-time usage credit on subscribing (owner
	// 2026-11-07, from pro_credit_cents; 0 = none): CreditOnce true,
	// CreditInterval "once".
	CreditCents    int64  `firestore:"-" json:"credit_cents"`
	CreditInterval string `firestore:"-" json:"credit_interval"`
	CreditOnce     bool   `firestore:"-" json:"credit_once"`
}

// ProIntro: price_cents for each of the first cycles invoices.
type ProIntro struct {
	PriceCents int64  `firestore:"price_cents" json:"price_cents"`
	Cycles     int    `firestore:"cycles" json:"cycles"`
	CouponID   string `firestore:"coupon_id" json:"-"`
}

// Stripe TEST product "Spatial Video Studio Pro" (prod_VZ4jvPAbtWTl2r).
// PRO-11 (owner 2026-11-07): the App Store's prices, $3.99 a week, $4.99 a
// month, $49.99 a year (TEST prices made 2026-11-07, the lookup keys moved
// to them); no intro offers (the app's are off; its free trial has no web
// counterpart). The 2026-11-04 prices and intro coupons stay in Stripe.
func testProPlans() map[string]ProPlanDef {
	return map[string]ProPlanDef{
		"pro_weekly":  {ID: "pro_weekly", Interval: "week", PriceCents: 399, StripePriceID: "price_1UYsNBAVV5NpxADI1ZH5UdIt", LookupKey: "svs_web_pro_weekly"},
		"pro_monthly": {ID: "pro_monthly", Interval: "month", PriceCents: 499, StripePriceID: "price_1UYsNCAVV5NpxADIpkEBpPGh", LookupKey: "svs_web_pro_monthly"},
		"pro_yearly":  {ID: "pro_yearly", Interval: "year", PriceCents: 4999, StripePriceID: "price_1UYsNDAVV5NpxADIZ6B59Yq1", LookupKey: "svs_web_pro_yearly"},
	}
}

// Pro's usage credit, once (owner 2026-11-07, replacing the monthly
// grant): $20 on every paid Pro, Lifetime too (a free trial counts,
// PRO-06), granted once per account and once per store purchase, expiring
// pro_credit_expiry_days after the grant. Keys are free-preview allowance
// keys. TEST only until prod's config sets pro_credit_cents.
func testProCredit() map[string]int64 {
	return map[string]int64{"pro_weekly": 2000, "pro_monthly": 2000, "pro_yearly": 2000, "pro_3m": 2000, "pro_6m": 2000,
		"pro_pass_3m": 2000, "pro_pass_6m": 2000, "pro_lifetime": 2000}
}

// ProCreditExpiryDays: how long the one-time Pro credit lasts (config
// pro_credit_expiry_days, default 30).
func (r *Rates) ProCreditExpiryDays() int {
	if r.ProCreditExpiryDaysOverride > 0 {
		return min(r.ProCreditExpiryDaysOverride, 366)
	}
	return 30
}

// ProCreditFor is the one-time Pro credit for what the person holds (0 =
// none or off).
func (r *Rates) ProCreditFor(key string) int64 {
	return max(r.ProCreditCents[key], 0)
}

// ProPlan is a web Pro plan by id.
func (r *Rates) ProPlan(id string) (ProPlanDef, bool) {
	if !r.PlansEnabled {
		return ProPlanDef{}, false
	}
	p, ok := r.ProPlans[id]
	if ok {
		p.CreditCents, p.CreditInterval, p.CreditOnce = r.ProCreditFor(id), "once", true
	}
	return p, ok
}

// ProPlanList is the Pro plans in order (weekly, monthly, yearly).
func (r *Rates) ProPlanList() []ProPlanDef {
	out := []ProPlanDef{}
	for _, id := range []string{"pro_weekly", "pro_monthly", "pro_yearly"} {
		if p, ok := r.ProPlan(id); ok {
			out = append(out, p)
		}
	}
	return out
}

// PlanMaxFPS is the top output rate with a Business or Studio plan.
const PlanMaxFPS = 120

// Yearly: the plan bills once a year (its credit still comes monthly).
func (p PlanDef) Yearly() bool { return p.Interval == "year" }

// TEST's Lifelike list follows pixels per eye with 1080p held at $4 (owner
// 2026-11-07): 4K is 4× 1080p. Prod keeps its own tables until the release
// sets them to match (release checklist: diff prod's /v1/pricing against
// TEST's).
func testLifelikeList() map[string]int64 {
	return map[string]int64{"1080p": 400, "qhd": 700, "3k": 900, "4k": 1600, "5k": 2800, "6k": 3600, "8k": 6400}
}

func testLifelikeTiers() map[string]map[string]int64 {
	return map[string]map[string]int64{
		TierPro:      {"1080p": 340, "qhd": 595, "3k": 765, "4k": 1360, "5k": 2380, "6k": 3060, "8k": 5440}, // −15%
		TierBusiness: {"1080p": 320, "qhd": 560, "3k": 720, "4k": 1280, "5k": 2240, "6k": 2880, "8k": 5120}, // −20%
		TierStudio:   {"1080p": 300, "qhd": 525, "3k": 675, "4k": 1200, "5k": 2100, "6k": 2700, "8k": 4800}, // −25%
	}
}

func defaultTierPct() map[string]float64 {
	return map[string]float64{TierPro: 0.15, TierBusiness: 0.20, TierStudio: 0.25} // owner 2026-11-04 (was 25%/30%)
}

func defaultAddOnPct() map[string]float64 {
	// Master +50% and High +30% (owner 2026-11-07, the quality tiers; Master
	// was +20%).
	return map[string]float64{AddOnFoveated: 0.30, AddOnMaster: 0.50, AddOnHigh: 0.30, AddOnExpress: 0.50, AddOnClassicMaster: 0.20}
}

// testAddOnPct: master bitrate +100% on TEST (owner 2026-11-07; was 20%);
// Express stays +50% (owner 2026-11-07, after a +100% try), foveated +30%.
func testAddOnPct() map[string]float64 {
	return map[string]float64{AddOnFoveated: 0.30, AddOnMaster: 0.50, AddOnHigh: 0.30, AddOnExpress: 0.50, AddOnClassicMaster: 1.00}
}

// AddOnClassicMaster: Classic's master bitrate keeps its own share (owner
// 2026-11-07: Classic stays on its bitrate list and prices, off the
// Lifelike quality scale): +20%, TEST +100%, as before the quality tiers.
// The breakdown still names it "master".
const AddOnClassicMaster = "classic_master"

// Stripe TEST prices (products "Spatial Video Studio Business plan" /
// "Spatial Video Studio Studio plan",
// made 2026-11-03 in test mode only).
func testPlans() map[string]PlanDef {
	return map[string]PlanDef{
		TierBusiness: {Name: "Business", MonthlyCents: 29900, CreditCents: 40000, MaxActiveRuns: 3,
			FreePreviews: 50, ExpressIncluded: true, Interval: "month", PriceCents: 29900, CreditInterval: "month",
			LookupKey: "svs_web_business_monthly", StripePriceID: "price_1UXaxSAVV5NpxADIFAwxnmfV"},
		// Studio bills yearly (owner 2026-11-04): $11,988 (12 × $999), with
		// $1,500 of credit and 200 free previews every month of the year.
		TierStudio: {Name: "Studio", MonthlyCents: 99900, CreditCents: 150000, MaxActiveRuns: 8,
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
	r.AddOnPctOverride = testAddOnPct()
	r.DiscountThresholdCents = 5000
	r.FreePreviewsEnabled = true
	r.PlansEnabled = true
	r.Plans = testPlans()
	r.ProPlans = testProPlans()
	r.ProCreditCents = testProCredit()
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
	p.MaxFPS = PlanMaxFPS
	return p, ok
}

// FreePreviewPeriods: how often each allowance resets (week | month |
// year | pass = once per pass).
var FreePreviewPeriods = map[string]string{"pro_weekly": "week", "pro_monthly": "month", "pro_yearly": "year",
	"pro_pass_3m": "pass", "pro_pass_6m": "pass", "pro_lifetime": "month", TierBusiness: "month", TierStudio: "month"}

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
// started (counted in source frames at srcFPS, so an NTSC 5 s is one),
// doubled for Cinema (5K-8K) and for 60 fps output (outFPS).
func (r *Rates) PreviewUnits(preset string, seconds, srcFPS, outFPS float64) int {
	n := int(StartedUnits(seconds, srcFPS, r.FreePreviewSeconds()))
	n = max(n, 1)
	if slices.Contains([]string{"5k", "6k", "8k"}, preset) || outFPS >= 50 {
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
	switch { // one quality add-on per run
	case in.Master || in.Quality == AddOnMaster:
		addOns = append(addOns, AddOnMaster)
	case in.Quality == AddOnHigh:
		addOns = append(addOns, AddOnHigh)
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
		minutes := billedMinutes(in.Step, in.BillableS, in.SourceFPS) // production: whole minutes, rounded up
		base := func(perMin int64) int64 { return int64(math.Ceil(minutes * float64(perMin) * fpsF)) }
		q = r.composeTier(base(listPerMin), base(tierPerMin), in.Tier, addOns, true)
		bd["fps_factor"] = round4(fpsF)
	}
	// the launch offer: after the plan or Pro discount, on the whole run
	campaign := r.applyCampaign(in, q.Final, bd)
	total := q.Final - campaign - in.CreditCents
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
		addOns = append(addOns, AddOnClassicMaster)
	}
	tierBase := afterReuse
	if in.Tier != TierNone && in.Step == "production" {
		tierBase = afterReuse - int64(math.Round(float64(afterReuse)*r.TierPct(in.Tier)))
	}
	q := r.composeTier(afterReuse, tierBase, in.Tier, addOns, true)
	if c, ok := q.AddOns[AddOnClassicMaster]; ok { // the breakdown's name for it, as before
		delete(q.AddOns, AddOnClassicMaster)
		q.AddOns[AddOnMaster] = c
	}
	campaign := r.applyCampaign(in, q.Final, bd) // the launch offer, web production at 1080p and 1440p
	total := q.Final - campaign - in.CreditCents
	if floor := r.MinimumFor(in.Step); total < floor {
		total = floor
	}
	bd["tier"], bd["pro"], bd["pricing"] = in.Tier, in.Tier != TierNone, "tiers"
	bd["analyze_credit_cents"] = in.CreditCents
	r.fillTierBreakdown(bd, q, in)
	delete(bd, "quality") // Classic isn't on the quality scale
	delete(bd, "quality_label")
	return &Quote{AmountCents: total, Currency: r.Currency, RateVersion: r.RateVersion, Breakdown: bd}
}

// fillTierBreakdown writes the tier lines, keeping the older keys the
// web reads (subtotal_cents, discount_cents for bulk, pro_discount_* for
// the tier).
func (r *Rates) fillTierBreakdown(bd map[string]any, q tierQuote, in StepInputs) {
	bd["list_base_cents"], bd["base_cents"] = q.ListBase, q.ListBase
	bd["addons"], bd["addon_pct"] = q.AddOns, round4(q.AddOnPct)
	for _, a := range []string{AddOnMaster, AddOnHigh} { // the quality line ("High quality +30%")
		if _, ok := q.AddOns[a]; ok {
			bd["quality"], bd["quality_label"] = a, fmt.Sprintf("%s quality +%d%%", qualityName[a], int(math.Round(r.AddOnPct(a)*100)))
		}
	}
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
		AddOnFoveated: map[string]any{"pct": r.AddOnPct(AddOnFoveated), "methods": []string{"lifelike"}, "enabled": r.FoveationEnabled,
			"included_presets": []string{"1080p"}}, // free and always on at 1080p (owner 2026-11-07)
		AddOnMaster: map[string]any{"pct": r.AddOnPct(AddOnMaster), "methods": []string{"lifelike", "classic"},
			"classic_pct": r.AddOnPct(AddOnClassicMaster), // Classic's own share (bitrate "master")
			"request":     map[string]any{"quality": "master"}, "legacy_request": map[string]any{"bitrate": "master"}},
		AddOnHigh: map[string]any{"pct": r.AddOnPct(AddOnHigh), "methods": []string{"lifelike"}, "request": map[string]any{"quality": "high"}},
		AddOnExpress: map[string]any{"pct": r.AddOnPct(AddOnExpress), "methods": []string{"lifelike"}, "request": map[string]any{"express": true},
			"included_in": []string{TierBusiness, TierStudio}, "effect": "first in the GPU line"},
		"on": "the run's price at its tier, before the bulk discount",
	}
	hfr := r.QualityHFRFactor
	if hfr <= 0 {
		hfr = 1.4
	}
	// the web's output quality tiers (owner 2026-11-07): one per run
	out["quality"] = map[string]any{"tiers": QualityTiers, "default": QualityStandard, "methods": []string{"lifelike"},
		QualityStandard: map[string]any{"mode": "crf_capped", "cap_mbps": qualityAnchors(QualityStandard, r), "price_pct": 0.0},
		QualityHigh:     map[string]any{"mode": "target", "mbps": qualityAnchors(QualityHigh, r), "price_pct": r.AddOnPct(AddOnHigh)},
		QualityMaster: map[string]any{"mode": "target", "mbps": qualityAnchors(QualityMaster, r), "price_pct": r.AddOnPct(AddOnMaster),
			"bit_depth": r.QualityBitDepth()},
		"hfr_factor": hfr, "hfr_applies_to": []string{QualityStandard, QualityHigh}, "scale": "per-eye pixels between the 1080p and 4k values"}
	out["discount"] = map[string]any{"threshold_cents": r.DiscountThresholdCents, "pct": r.DiscountPct,
		"stacks_with_tier": false, "rule": "a run gets the bigger of bulk and its tier price, never both"}
	out["pro_discount"] = map[string]any{"pct": r.TierPct(TierPro), "applies_to": "production", "tiered": true}
	out["plans"] = plans
	out["pro_plans"] = r.ProPlanList() // [{id, interval, price_cents, intro|null, credit_cents, credit_interval}]
	// Pro's usage credit, once (owner 2026-11-07): {cents: 2000, once,
	// expires_days, paid_only, trial_counts, stacks_with_plan: false};
	// cents_by_kind is what each Pro gets ({} and cents 0 when off).
	proCredit := r.ProCreditCents
	if proCredit == nil {
		proCredit = map[string]int64{}
	}
	out["pro_credit"] = map[string]any{"cents": proCredit["pro_monthly"], "cents_by_kind": proCredit, "once": true,
		"expires_days": r.ProCreditExpiryDays(), "rollover": false, "paid_only": true, "trial_counts": true, "stacks_with_plan": false}
	out["free_previews"] = map[string]any{
		"enabled":       r.FreePreviewsEnabled,
		"allowances":    allow, // per period; intro = a non-subscriber's first project
		"periods":       FreePreviewPeriods,
		"unit_seconds":  r.FreePreviewSeconds(),
		"counts_double": []string{"5k", "6k", "8k", "60fps"},
		"daily_cap":     r.FreePreviewDailyCap(),
		"rollover":      false,
	}
}

var qualityName = map[string]string{AddOnMaster: "Master", AddOnHigh: "High"}

// Quality tiers.
const (
	QualityStandard = "standard"
	QualityHigh     = "high"
	QualityMaster   = "master"
)

// QualityTiers are the request's choices, in order.
var QualityTiers = []string{QualityStandard, QualityHigh, QualityMaster}

func qualityAnchors(tier string, r *Rates) map[string]float64 {
	var cfg, def map[string]float64
	switch tier {
	case QualityStandard:
		cfg, def = r.QualityStandardCapMbps, map[string]float64{"1080p": 25, "4k": 40}
	case QualityHigh:
		cfg, def = r.QualityHighMbps, map[string]float64{"1080p": 40, "4k": 80}
	case QualityMaster:
		cfg, def = r.QualityMasterMbps, map[string]float64{"1080p": 100, "4k": 150}
	default:
		return nil
	}
	if cfg["1080p"] > 0 && cfg["4k"] > 0 {
		return cfg
	}
	return def
}

// QualityMbps is a tier's Mbit/s for an output picture of width×height
// per eye at fps: the 1080p and 4K anchors scaled linearly by pixels
// (never below a tenth of the 1080p value), ×hfr above 30 fps for
// standard and high. For standard it's the cap of a CRF target.
func (r *Rates) QualityMbps(tier string, width, height int, fps float64) float64 {
	a := qualityAnchors(tier, r)
	if a == nil || width <= 0 || height <= 0 {
		return 0
	}
	const px1080, px4k = 1920.0 * 1080, 3840.0 * 2160
	px := float64(width) * float64(height)
	v := a["1080p"] + (px-px1080)*(a["4k"]-a["1080p"])/(px4k-px1080)
	v = max(v, a["1080p"]/10)
	if fps > 30 && tier != QualityMaster {
		f := r.QualityHFRFactor
		if f <= 0 {
			f = 1.4
		}
		v *= f
	}
	return math.Round(v*10) / 10
}

// QualityBitDepth is master's bit depth (10).
func (r *Rates) QualityBitDepth() int {
	if r.QualityMasterBitDepth > 0 {
		return r.QualityMasterBitDepth
	}
	return 10
}

// QualityTypicalShare is a standard file's usual share of its cap (0.5).
func (r *Rates) QualityTypicalShare() float64 {
	if r.QualityStandardTypical > 0 && r.QualityStandardTypical <= 1 {
		return r.QualityStandardTypical
	}
	return 0.5
}
