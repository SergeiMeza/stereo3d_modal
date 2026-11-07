package api

import (
	"context"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// GET /v1/admin/revenue/daily?from=YYYY-MM-DD&to=YYYY-MM-DD (owner
// 2026-11-07): the web's money per UTC day for svs-app's KPI ingest, from
// our own records only (charges, refund rows, dispute cases, plan
// payments, the balance ledger), never Stripe. Auth: a Google ID token
// (audience: this gateway's URL, Cfg.InternalOIDCAudiences) from a service
// account in KPI_OIDC_SERVICE_ACCOUNTS; no admin session.
//
// Every amount is USD cents (what we charged and booked); presentment
// adds the customers' own currencies. Booking days, from times written
// once: a payment on its paid_at, a refund on its refunded_at (rows from
// before 2026-11-07: created_at), a lost dispute on its case's closed_at,
// ledger use on the entry's at. A day is closed 48 h after it ends (late
// webhooks land by then) and never changes after. Mobile app charges
// (plain app conversions: no step, not made on the web) are reported as
// app_* products and kept out of the web totals. Test and probe accounts
// are left out on prod and counted under test_accounts on TEST.

const (
	revenueMaxDays   = 400
	revenueScanLimit = 50000
	revenueCloseLag  = 48 * time.Hour
)

// revenueProducts: the web's products, then the app's.
var revenueProducts = []string{"run_lifelike", "run_classic", "run_preview", "topup", "settle_batch",
	"pro_weekly", "pro_monthly", "pro_yearly", "business", "studio", "other", "app_run", "app_settle_batch"}

type revProduct struct {
	Gross        int64 `json:"gross_cents"`
	Refunds      int64 `json:"refunds_cents"`
	DisputesLost int64 `json:"disputes_lost_cents"`
	Net          int64 `json:"net_cents"`
	Count        int   `json:"count"`
}

type revTotals struct {
	Gross        int64 `json:"gross_cents"`
	Refunds      int64 `json:"refunds_cents"`
	DisputesLost int64 `json:"disputes_lost_cents"`
	Net          int64 `json:"net_cents"`
	Payments     int   `json:"payments"`
}

type revPresentment struct {
	Currency    string `json:"currency"`
	AmountMinor int64  `json:"amount_minor"`
	Count       int    `json:"count"`
}

type revDay struct {
	Day          string                 `json:"day"`
	Closed       bool                   `json:"closed"`
	Gross        int64                  `json:"gross_cents"`
	Refunds      int64                  `json:"refunds_cents"`
	DisputesLost int64                  `json:"disputes_lost_cents"`
	Net          int64                  `json:"net_cents"`
	ByProduct    map[string]*revProduct `json:"by_product"`
	ByMethod     map[string]int64       `json:"by_method"` // card_cents | balance_cents | credit_cents
	Presentment  []revPresentment       `json:"presentment"`
	Counts       map[string]int         `json:"counts"` // payments | refunds | disputes | new_paying_accounts
	App          revTotals              `json:"app"`
	TestAccounts *revTotals             `json:"test_accounts,omitempty"` // TEST only: included above, left out on prod

	pres map[string]*revPresentment
}

func newRevDay(day string, closed bool) *revDay {
	d := &revDay{Day: day, Closed: closed, ByProduct: map[string]*revProduct{}, pres: map[string]*revPresentment{},
		ByMethod: map[string]int64{"card_cents": 0, "balance_cents": 0, "credit_cents": 0},
		Counts:   map[string]int{"payments": 0, "refunds": 0, "disputes": 0, "new_paying_accounts": 0}}
	for _, p := range revenueProducts {
		d.ByProduct[p] = &revProduct{}
	}
	return d
}

// testAccountEmail: addresses of our own tests and probes.
var testAccountEmail = regexp.MustCompile(`(?i)(@example\.(com|net|org|test)$|\+location_|probe|^qa-agent\+.*@lpp\.pw$|^svs-ap)`)

// revenueReport is the report's state while it is built.
type revenueReport struct {
	s       *Service
	ctx     context.Context
	from    time.Time // first day 00:00 UTC
	to      time.Time // the day after the last, 00:00 UTC
	days    map[string]*revDay
	prod    bool
	convs   map[string]*store.Conversion
	tests   map[string]bool
	charges map[string]*store.Charge
	planPIs map[string]*store.PlanPayment
}

func (r *revenueReport) day(t time.Time) *revDay {
	if t.Before(r.from) || !t.Before(r.to) {
		return nil
	}
	return r.days[t.UTC().Format(time.DateOnly)]
}

// isTest: one of our test or probe accounts.
func (r *revenueReport) isTest(uid string) bool {
	if v, ok := r.tests[uid]; ok {
		return v
	}
	v := strings.HasPrefix(uid, "itest") || uid == "ap-integration"
	if !v {
		if c, err := r.s.Store.GetCustomer(r.ctx, uid); err == nil {
			v = testAccountEmail.MatchString(strings.TrimSpace(c.Email))
		}
	}
	r.tests[uid] = v
	return v
}

func (r *revenueReport) conv(id string) *store.Conversion {
	if c, ok := r.convs[id]; ok {
		return c
	}
	c, _ := r.s.Store.GetConversion(r.ctx, id)
	r.convs[id] = c
	return c
}

// productOf names a charge's product.
func (r *revenueReport) productOf(ch *store.Charge) string {
	if ch == nil {
		return "other"
	}
	if ch.Kind == store.ChargeTopup {
		return "topup"
	}
	app := len(ch.Lines) > 0
	for _, l := range ch.Lines {
		if c := r.conv(l.ConversionID); c == nil || c.Step != "" || c.Params.Web || c.ProjectID != "" {
			app = false
		}
	}
	switch ch.Kind {
	case store.ChargeGroup, store.ChargeSettle:
		if app {
			return "app_settle_batch"
		}
		return "settle_batch"
	}
	if len(ch.Lines) == 0 {
		return "other"
	}
	if app {
		return "app_run"
	}
	c := r.conv(ch.Lines[0].ConversionID)
	switch {
	case c == nil:
		return "other"
	case c.Step == store.StepLifelikePreview || c.Step == store.StepStereoPreview || c.Step == store.StepDepthPreview:
		return "run_preview"
	case c.Method == store.MethodLifelike:
		return "run_lifelike"
	}
	return "run_classic"
}

func planProduct(id string) string {
	if slices.Contains([]string{"pro_weekly", "pro_monthly", "pro_yearly", "business", "studio"}, id) {
		return id
	}
	return "other"
}

func isAppProduct(p string) bool { return strings.HasPrefix(p, "app_") }

// book adds one money movement: kind payment | refund | dispute_lost.
func (r *revenueReport) book(d *revDay, uid, product, kind string, cents int64, pres *store.Presentment) {
	if d == nil || cents == 0 {
		return
	}
	test := r.isTest(uid)
	if test && r.prod {
		return
	}
	p := d.ByProduct[product]
	switch kind {
	case "payment":
		p.Gross += cents
		p.Count++
	case "refund":
		p.Refunds += cents
	case "dispute_lost":
		p.DisputesLost += cents
	}
	p.Net = p.Gross - p.Refunds - p.DisputesLost
	tot := func(t *revTotals) {
		switch kind {
		case "payment":
			t.Gross += cents
			t.Payments++
		case "refund":
			t.Refunds += cents
		case "dispute_lost":
			t.DisputesLost += cents
		}
		t.Net = t.Gross - t.Refunds - t.DisputesLost
	}
	if test {
		if d.TestAccounts == nil {
			d.TestAccounts = &revTotals{}
		}
		tot(d.TestAccounts)
	}
	if isAppProduct(product) {
		tot(&d.App)
		return
	}
	switch kind {
	case "payment":
		d.Gross += cents
		d.ByMethod["card_cents"] += cents
		d.Counts["payments"]++
		if pres != nil {
			x := d.pres[pres.Currency]
			if x == nil {
				x = &revPresentment{Currency: pres.Currency}
				d.pres[pres.Currency] = x
			}
			x.AmountMinor += pres.AmountMinor
			x.Count++
		}
	case "refund":
		d.Refunds += cents
		d.Counts["refunds"]++
	case "dispute_lost":
		d.DisputesLost += cents
	}
	d.Net = d.Gross - d.Refunds - d.DisputesLost
}

func (s *Service) buildRevenue(ctx context.Context, from, to time.Time, now time.Time) ([]*revDay, error) {
	r := &revenueReport{s: s, ctx: ctx, from: from, to: to, days: map[string]*revDay{}, prod: s.Cfg.Env == "prod",
		convs: map[string]*store.Conversion{}, tests: map[string]bool{}, charges: map[string]*store.Charge{},
		planPIs: map[string]*store.PlanPayment{}}
	var order []string
	for t := from; t.Before(to); t = t.AddDate(0, 0, 1) {
		k := t.Format(time.DateOnly)
		r.days[k] = newRevDay(k, !now.Before(t.AddDate(0, 0, 1).Add(revenueCloseLag)))
		order = append(order, k)
	}
	charges, err := s.Store.ListAllCharges(ctx, revenueScanLimit)
	if err != nil {
		return nil, err
	}
	plans, err := s.Store.ListPlanPayments(ctx, revenueScanLimit)
	if err != nil {
		return nil, err
	}
	// first web card payment per account (new paying accounts)
	first := map[string]time.Time{}
	seen := func(uid string, at time.Time, product string) {
		if isAppProduct(product) || (r.prod && r.isTest(uid)) {
			return
		}
		if f, ok := first[uid]; !ok || at.Before(f) {
			first[uid] = at
		}
	}
	for _, ch := range charges {
		r.charges[ch.ID] = ch
		if ch.PaymentIntentID == "" || !stripex.IsPaymentIntentID(ch.PaymentIntentID) || ch.AmountCents <= 0 {
			continue // balance-paid settles carry "balance:…": no card money
		}
		product := r.productOf(ch)
		seen(ch.UID, ch.PaidAt, product)
		r.book(r.day(ch.PaidAt), ch.UID, product, "payment", ch.AmountCents, ch.Presentment)
	}
	for _, p := range plans {
		if p.PaymentIntentID != "" {
			r.planPIs[p.PaymentIntentID] = p
		}
		seen(p.UID, p.PaidAt, planProduct(p.PlanID))
		r.book(r.day(p.PaidAt), p.UID, planProduct(p.PlanID), "payment", p.AmountCents, p.Presentment)
	}
	for _, at := range first {
		if d := r.day(at); d != nil {
			d.Counts["new_paying_accounts"]++
		}
	}
	// refunds: refund rows, and plan refunds not already among them
	booked := map[string]bool{}
	for _, st := range []string{store.RefundSucceeded, store.RefundOutOfBand} {
		rows, err := s.Store.ListRefundRowsByStatus(ctx, st, revenueScanLimit)
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			at := row.CreatedAt
			if row.RefundedAt != nil {
				at = *row.RefundedAt
			}
			product := "other"
			if p := r.planPIs[row.PI]; p != nil {
				product = planProduct(p.PlanID)
			} else if ch := r.charges[row.ChargeID]; ch != nil {
				product = r.productOf(ch)
			}
			if row.ReID != "" {
				booked[row.ReID] = true
			}
			r.book(r.day(at), row.UID, product, "refund", row.TotalCents, nil)
		}
	}
	for _, p := range plans {
		for _, x := range p.Refunds {
			if !booked[x.ID] {
				r.book(r.day(x.At), p.UID, planProduct(p.PlanID), "refund", x.Cents, nil)
			}
		}
	}
	// disputes: opened (count), lost (amount, on the case's close)
	cases, err := s.Store.ListCasesByType(ctx, store.CaseDispute, revenueScanLimit)
	if err != nil {
		return nil, err
	}
	for _, c := range cases {
		if r.prod && r.isTest(c.UID) {
			continue
		}
		if d := r.day(c.OpenedAt); d != nil {
			d.Counts["disputes"]++
		}
		if c.Dispute == nil || c.Dispute.Outcome != "lost" || c.ClosedAt == nil {
			continue
		}
		product := "other"
		for _, pi := range c.Related.PIIDs {
			if p := r.planPIs[pi]; p != nil {
				product = planProduct(p.PlanID)
			}
		}
		for _, id := range c.Related.ChargeIDs {
			if ch := r.charges[id]; ch != nil {
				product = r.productOf(ch)
			}
		}
		r.book(r.day(*c.ClosedAt), c.UID, product, "dispute_lost", c.Dispute.Amount, nil)
	}
	// balance and credit spent (runs and debts paid from the ledger)
	uids, err := s.Store.ListBalanceUIDs(ctx, revenueScanLimit)
	if err != nil {
		return nil, err
	}
	for _, uid := range uids {
		if r.prod && r.isTest(uid) {
			continue
		}
		entries, err := s.Store.ListEntriesBetween(ctx, uid, from, to)
		if err != nil {
			return nil, err
		}
		for _, e := range entries {
			if e.Kind != store.EntrySettle && e.Kind != store.EntryDebtPayment {
				continue
			}
			d := r.day(e.At)
			if d == nil {
				continue
			}
			for _, u := range e.FifoUsed {
				if u.TopupID == "" {
					d.ByMethod["credit_cents"] += u.Cents // plan, Pro and grant credit carry no top-up
				} else {
					d.ByMethod["balance_cents"] += u.Cents
				}
			}
		}
	}
	out := make([]*revDay, 0, len(order))
	for _, k := range order {
		d := r.days[k]
		d.Presentment = make([]revPresentment, 0, len(d.pres))
		for _, x := range d.pres {
			d.Presentment = append(d.Presentment, *x)
		}
		sort.Slice(d.Presentment, func(i, j int) bool { return d.Presentment[i].Currency < d.Presentment[j].Currency })
		out = append(out, d)
	}
	return out, nil
}

// HandleAdminRevenueDaily is GET /v1/admin/revenue/daily.
func (s *Service) HandleAdminRevenueDaily(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	caller, err := s.internalCallerIn(r, s.Cfg.KPIServiceAccounts)
	if err != nil {
		httpx.Log(ctx).Warn("revenue report refused", "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusUnauthorized, "unauthenticated", "a Google ID token from an accepted service account is required"))
		return
	}
	q := r.URL.Query()
	from, ferr := time.Parse(time.DateOnly, q.Get("from"))
	to, terr := time.Parse(time.DateOnly, q.Get("to"))
	if ferr != nil || terr != nil || to.Before(from) {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("from and to: UTC days YYYY-MM-DD, from ≤ to"))
		return
	}
	if n := int(to.Sub(from).Hours()/24) + 1; n > revenueMaxDays {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("at most 400 days"))
		return
	}
	now := time.Now().UTC()
	days, err := s.buildRevenue(ctx, from.UTC(), to.UTC().AddDate(0, 0, 1), now)
	if err != nil {
		httpx.Log(ctx).Error("revenue report failed", "err", err)
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	httpx.Log(ctx).Info("revenue report", "caller", caller, "from", q.Get("from"), "to", q.Get("to"))
	exclusion := "flagged"
	if s.Cfg.Env == "prod" {
		exclusion = "excluded"
	}
	httpx.WriteOK(w, map[string]any{"env": s.Cfg.Env, "currency": "usd", "from": q.Get("from"), "to": q.Get("to"),
		"generated_at": now.Format(time.RFC3339), "close_lag_hours": int(revenueCloseLag.Hours()),
		"test_accounts": exclusion, "app": "separate", "products": revenueProducts, "days": days})
}

// PlanPaymentsBackfill is BackfillPlanPayments' report (counts only).
type PlanPaymentsBackfill struct {
	Accounts int  `json:"accounts"`
	Invoices int  `json:"paid_invoices"`
	Recorded int  `json:"recorded"`
	Refunds  int  `json:"refunds_recorded"`
	DryRun   bool `json:"dry_run"`
}

// BackfillPlanPayments records the paid web plan invoices from before
// plan_payments existed (2026-11-07), from Stripe: every account with a
// web plan on record, each paid invoice of ours once, its refunds once.
// The backfilled paid_at is the invoice's creation time. apply false
// counts only.
func (s *Service) BackfillPlanPayments(ctx context.Context, apply bool) (*PlanPaymentsBackfill, error) {
	custs, err := s.Store.ListPlanCustomers(ctx, 5000)
	if err != nil {
		return nil, err
	}
	out := &PlanPaymentsBackfill{DryRun: !apply}
	for uid, c := range custs {
		if c.StripeCustomerID == "" {
			continue
		}
		out.Accounts++
		invs, err := s.Stripe.ListPlanInvoices(c.StripeCustomerID)
		if err != nil {
			return out, err
		}
		for _, inv := range invs {
			md := inv.Parent.SubscriptionDetails.Metadata
			if inv.Status != "paid" || inv.AmountPaid <= 0 || md["product"] != "svs-web" || md["env"] != s.Cfg.Env {
				continue
			}
			out.Invoices++
			if !apply {
				continue
			}
			if s.recordPlanPayment(ctx, inv.ID, uid, firstNonEmpty(md["plan_id"], md["plan"]), inv.AmountPaid, inv.Currency, time.Unix(inv.Created, 0).UTC()) {
				out.Recorded++
			}
			pi, err := s.Stripe.InvoicePaymentIntent(inv.ID)
			if err != nil || pi == "" {
				continue
			}
			refunds, err := s.Stripe.ListRefunds(pi)
			if err != nil {
				continue
			}
			for _, re := range refunds {
				if re.Status != "succeeded" {
					continue
				}
				if ok, _ := s.Store.AddPlanRefund(ctx, pi, store.PlanRefund{ID: re.ID, Cents: re.Amount, At: time.Unix(re.Created, 0).UTC()}); ok {
					out.Refunds++
				}
			}
		}
	}
	return out, nil
}
