package api

import (
	"cmp"
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Plans in the billing history (owner bug 2026-11-05: a Business purchase
// left no row, so no receipt or invoice to open):
//   - kind "plan": every paid (or failed, waiting) subscription invoice of
//     Business, Studio or web Pro, first charges, renewals, step-ups with
//     their credit line, Studio's yearly charge; read from Stripe's
//     invoices on the customer, so earlier ones are there too;
//   - kind "plan_change": a step-up, an applied step-down, and one waiting
//     for the period's end (status scheduled); no money;
//   - kind "credit": the plans' usage-credit grants, expiries, removals,
//     freezes, from the balance ledger; no money (credit.cents says how
//     much).

type planRowInfo struct {
	Tier          string `json:"tier"`              // pro | business | studio
	PlanID        string `json:"plan_id,omitempty"` // pro_weekly | pro_monthly | pro_yearly
	Interval      string `json:"interval"`          // weekly | monthly | yearly
	Reason        string `json:"reason"`            // first | renewal | change | other
	InvoiceID     string `json:"invoice_id"`
	InvoiceNumber string `json:"invoice_number,omitempty"`
}

type planLine struct {
	Description string `json:"description"`
	AmountCents int64  `json:"amount_cents"` // negative for a credit line
}

type planChangeInfo struct {
	From        string     `json:"from"` // the plan key: business | studio | pro_monthly | pay_per_video
	To          string     `json:"to"`
	Kind        string     `json:"kind"` // step_up | step_down | cancel
	EffectiveAt *time.Time `json:"effective_at,omitempty"`
}

type creditInfo struct {
	Cents int64  `json:"cents"` // + granted, − expired/removed/frozen
	Kind  string `json:"kind"`  // granted | expired | removed | frozen | unfrozen
}

// intervalWord: weekly | monthly | yearly for a Stripe recurring
// interval ("" when it isn't one of those).
func intervalWord(stripeInterval string) string {
	return map[string]string{"week": "weekly", "month": "monthly", "year": "yearly"}[stripeInterval]
}

// planIntervalWord: weekly | monthly | yearly for a plan key or tier, when
// the price's own interval isn't known. A plan_id that is a tier
// ("studio" on a step-up's metadata) reads the tier's interval.
func planIntervalWord(r *pricing.Rates, tier, planID string) string {
	if _, ok := r.Plan(planID); ok {
		tier, planID = planID, ""
	}
	switch {
	case strings.Contains(planID, "week"):
		return "weekly"
	case strings.Contains(planID, "year"):
		return "yearly"
	case planID != "":
		return "monthly"
	}
	if def, ok := r.Plan(tier); ok && def.Yearly() {
		return "yearly"
	}
	return "monthly"
}

// planRowLabel: "Business plan · monthly", "Pro · weekly".
func planRowLabel(tier, interval string) string {
	if tier == pricing.TierPro {
		return "Pro · " + interval
	}
	return cmp.Or(tierLabel(tier), tier) + " plan · " + interval
}

func planInvoiceStatus(inv stripex.PlanInvoice) string {
	switch inv.Status {
	case "paid":
		switch {
		case inv.PostPaymentCredits > 0 && inv.PostPaymentCredits >= inv.AmountPaid:
			return "refunded"
		case inv.PostPaymentCredits > 0:
			return "partially_refunded"
		}
		return "paid"
	case "open":
		return "payment_needed"
	case "uncollectible":
		return "failed"
	}
	return ""
}

// planInvoiceRows turns the customer's plan invoices into history rows
// (pure; the receipt and card come from the paying PaymentIntent, the
// interval from the plan line's price: intervals is price id → Stripe's
// recurring interval).
func planInvoiceRows(r *pricing.Rates, env string, invs []stripex.PlanInvoice, pis, intervals map[string]string) []historyRow {
	var out []historyRow
	for _, inv := range invs {
		md := inv.Parent.SubscriptionDetails.Metadata
		status := planInvoiceStatus(inv)
		if md["product"] != "svs-web" || md["env"] != env || status == "" {
			continue
		}
		tier, planID := md["plan"], md["plan_id"]
		interval := cmp.Or(intervalWord(intervals[inv.PlanPriceID()]), planIntervalWord(r, tier, planID))
		reason := map[string]string{"subscription_create": "first", "subscription_cycle": "renewal", "subscription_update": "change"}[inv.BillingReason]
		if reason == "" {
			reason = "other"
		}
		at := time.Unix(inv.Created, 0).UTC()
		amount := inv.AmountPaid
		if inv.Status != "paid" {
			amount = inv.Total
		}
		row := historyRow{RowID: "plan_" + inv.ID, Kind: "plan", CreatedAt: at, AmountCents: amount, Currency: inv.Currency,
			Status: status, Label: planRowLabel(tier, interval), pi: pis[inv.ID], amounts: map[string]int64{},
			Plan: &planRowInfo{Tier: tier, PlanID: planID, Interval: interval, Reason: reason, InvoiceID: inv.ID, InvoiceNumber: inv.Number}}
		if inv.HostedInvoiceURL != "" || inv.InvoicePDF != "" {
			row.Invoice = map[string]string{"hosted_invoice_url": inv.HostedInvoiceURL, "invoice_pdf": inv.InvoicePDF}
		}
		for _, l := range inv.Lines.Data {
			row.Lines = append(row.Lines, planLine{Description: l.Description, AmountCents: l.Amount})
		}
		out = append(out, row)
		// a plan change rides on its invoice: a step-up's charge, the
		// first invoice of a stepped-down plan
		if from := md["changed_from"]; from != "" && (md["change_kind"] == changeStepUp && reason == "change" ||
			md["change_kind"] == changeStepDown && reason == "first") {
			to := cmp.Or(planID, tier)
			out = append(out, historyRow{RowID: "plan_change_" + inv.ID, Kind: "plan_change", CreatedAt: at.Add(-time.Second),
				Currency: inv.Currency, Status: "applied", Label: planChangeLabel(from, to), amounts: map[string]int64{},
				Change: &planChangeInfo{From: publicPlanID(from), To: publicPlanID(to), Kind: md["change_kind"], EffectiveAt: &at}})
		}
	}
	return out
}

func planKeyLabel(key string) string {
	switch {
	case key == planNone || key == "":
		return "Pay per video"
	case strings.HasPrefix(key, "pro"):
		return "Pro"
	}
	return cmp.Or(tierLabel(key), key)
}

// planChangeLabel: "Business → Studio".
func planChangeLabel(from, to string) string { return planKeyLabel(from) + " → " + planKeyLabel(to) }

// scheduledChangeRow is a step-down or cancel waiting for the period's end.
func scheduledChangeRow(p *store.Plan) *historyRow {
	if p == nil {
		return nil
	}
	to, at, kind := p.ScheduledTo, p.ScheduledAt, changeStepDown
	if to == "" && p.CancelAtPeriodEnd && p.CurrentPeriodEnd != nil {
		to, at, kind = planNone, p.CurrentPeriodEnd, "cancel"
	}
	if to == "" || at == nil {
		return nil
	}
	from := p.Key()
	return &historyRow{RowID: "plan_change_scheduled_" + p.SubscriptionID, Kind: "plan_change", CreatedAt: p.UpdatedAt.UTC(),
		Currency: "usd", Status: "scheduled", Label: planChangeLabel(from, to), amounts: map[string]int64{},
		Change: &planChangeInfo{From: publicPlanID(from), To: publicPlanID(to), Kind: kind, EffectiveAt: at}}
}

// creditRows are the plans' usage-credit movements from the ledger.
func creditRows(entries []store.Entry) []historyRow {
	kinds := map[string]string{store.EntryPlanCredit: "granted", store.EntryPlanCreditExpiry: "expired", store.EntryPlanCreditRemoval: "removed",
		store.EntryPlanCreditFreeze: "frozen", store.EntryPlanCreditUnfreeze: "unfrozen"}
	words := map[string]string{"granted": "Usage credit added", "expired": "Usage credit expired", "removed": "Usage credit ended",
		"frozen": "Usage credit on hold", "unfrozen": "Usage credit released"}
	var out []historyRow
	for _, e := range entries {
		k, ok := kinds[e.Kind]
		if !ok {
			continue
		}
		cents := e.Delta
		if cents == 0 {
			cents = e.Cents
			if k != "granted" && k != "unfrozen" {
				cents = -cents
			}
		}
		out = append(out, historyRow{RowID: "credit_" + e.ID, Kind: "credit", CreatedAt: e.At.UTC(), Currency: "usd", Status: "applied",
			Label: words[k] + " · " + money(abs64(cents)), amounts: map[string]int64{}, Credit: &creditInfo{Cents: cents, Kind: k}})
	}
	return out
}

func abs64(v int64) int64 {
	if v < 0 {
		return -v
	}
	return v
}

// invoicePIs: plan invoice → the PaymentIntent that paid it (cached:
// a paid invoice's payment never changes).
var invoicePIs sync.Map

// planHistoryRows reads the account's plan rows (invoices from Stripe,
// changes from the plan, credit from the ledger); none on failure, logged.
func (s *Service) planHistoryRows(ctx context.Context, uid string, cust *store.Customer) []historyRow {
	var out []historyRow
	if cust != nil && cust.StripeCustomerID != "" && s.Stripe != nil {
		invs, err := s.Stripe.ListPlanInvoices(cust.StripeCustomerID)
		if err != nil {
			slog.WarnContext(ctx, "billing history: plan invoices unread", "err", err)
		}
		pis := map[string]string{}
		for _, inv := range invs {
			if inv.Status != "paid" {
				continue
			}
			if v, ok := invoicePIs.Load(inv.ID); ok {
				pis[inv.ID] = v.(string)
				continue
			}
			if pi, err := s.Stripe.InvoicePaymentIntent(inv.ID); err == nil && pi != "" {
				invoicePIs.Store(inv.ID, pi)
				pis[inv.ID] = pi
			}
		}
		intervals := map[string]string{}
		for _, inv := range invs {
			if id := inv.PlanPriceID(); id != "" {
				if _, done := intervals[id]; !done {
					if iv, err := s.Stripe.PriceInterval(id); err == nil {
						intervals[id] = iv
					} else {
						slog.WarnContext(ctx, "billing history: price interval unread", "err", stripex.ErrMessage(err))
					}
				}
			}
		}
		out = append(out, planInvoiceRows(s.rates(ctx), s.Cfg.Env, invs, pis, intervals)...)
	}
	if cust != nil {
		if r := scheduledChangeRow(cust.Plan); r != nil {
			out = append(out, *r)
		}
	}
	if entries, _, err := s.Store.ListEntries(ctx, uid, historyScanLimit, ""); err == nil {
		out = append(out, creditRows(entries)...)
	}
	return out
}
