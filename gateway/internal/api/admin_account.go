package api

import (
	"context"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// --------------------------------------------------------------- A3

// GET /v1/admin/accounts/{uid} → {account, billing_state, balance,
// ledger, methods, history, cases, plan, owed_cents}.
func (s *Service) HandleAdminAccount(w http.ResponseWriter, r *http.Request, a *AdminUser, uid string) {
	ctx := r.Context()
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusNotFound, "no_account", "No account with that ID."))
		return
	}
	s.audit(ctx, a, "account_view", map[string]any{"uid": uid})
	out := map[string]any{
		"account": map[string]any{"uid": uid, "email": cust.Email, "stripe_customer_id": cust.StripeCustomerID,
			"deleted": cust.AccountDeleted, "blocked": cust.Blocked},
		"billing_state": map[string]any{"flow_state": flowState(cust), "sheet_only": cust.SheetOnly, "sheet_only_reason": cust.SheetOnlyReason,
			"all_methods_failed": cust.AllMethodsFailed, "last_good_method": cust.LastGoodMethod, "under_review": cust.UnderReview,
			"lifetime_paid_cents": cust.LifetimePaidCents, "backup_order": cust.BackupOrder},
		"owed_cents": s.owedCents(ctx, uid),
		"balance":    s.balanceSummary(ctx, uid, nil),
		"plan":       s.planJSON(ctx, uid),
	}
	if entries, _, err := s.Store.ListEntries(ctx, uid, 50, ""); err == nil {
		out["ledger"] = entries
	}
	if cust.StripeCustomerID != "" {
		if methods, err := s.Stripe.ListMethods(cust.StripeCustomerID); err == nil {
			var ms []map[string]any
			for _, m := range methods {
				ms = append(ms, map[string]any{"id": m.PaymentMethodID, "label": methodLabel(m), "type": m.Type})
			}
			out["methods"] = ms
		}
	}
	if cases, err := s.Store.ListUserCases(ctx, uid, 100); err == nil {
		out["cases"] = cases
	}
	if charges, err := s.Store.ListUserCharges(ctx, uid, 200); err == nil {
		out["charges"] = charges
	}
	if rows, err := s.Store.ListUserRefundRows(ctx, uid, 200); err == nil {
		out["refunds"] = rows
	}
	httpx.WriteOK(w, out)
}

// POST /v1/admin/accounts/{uid}/actions {action: clear_review |
// clear_sheet_only | write_off_owed | block | unblock | resend_e2 |
// adjust_balance, cents?, case_id?, note?}.
func (s *Service) HandleAdminAccountAction(w http.ResponseWriter, r *http.Request, a *AdminUser, uid string) {
	ctx := r.Context()
	var req struct {
		Action string `json:"action"`
		Cents  int64  `json:"cents"`
		CaseID string `json:"case_id"`
		Note   string `json:"note"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	if (req.Action == "write_off_owed" || req.Action == "adjust_balance") && !a.FreshAuth() {
		httpx.WriteErr(ctx, w, errReauth())
		return
	}
	if _, err := s.Store.GetCustomer(ctx, uid); err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusNotFound, "no_account", "No account with that ID."))
		return
	}
	s.audit(ctx, a, "account_"+req.Action, map[string]any{"uid": uid, "cents": req.Cents, "case_id": req.CaseID, "note": req.Note})
	var err error
	switch req.Action {
	case "clear_review":
		_, err = s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error { c.UnderReview = false; return nil })
	case "clear_sheet_only":
		_, err = s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error { c.SheetOnly, c.SheetOnlyReason = false, ""; return nil })
	case "block", "unblock":
		_, err = s.Store.UpdateCustomer(ctx, uid, func(c *store.Customer) error { c.Blocked = req.Action == "block"; return nil })
		if err == nil && req.Action == "block" {
			s.revokePlanEntitlement(ctx, uid, "account blocked") // fraud: the plan's app entitlement ends now
		}
	case "resend_e2":
		s.mailOwed(ctx, "E2", fmt.Sprintf("E2_resend_%s_%d", uid, time.Now().Unix()), uid, s.owedCents(ctx, uid))
	case "write_off_owed":
		err = s.writeOffOwed(ctx, uid)
	case "adjust_balance":
		if req.CaseID == "" || req.Cents == 0 {
			err = httpx.ErrInvalid("an adjustment needs an amount and a case")
			break
		}
		if _, cerr := s.Store.GetCase(ctx, req.CaseID); cerr != nil {
			err = httpx.ErrInvalid("no case " + req.CaseID)
			break
		}
		var fx store.BalanceEffects
		_, fx, err = s.Store.BalanceTx(ctx, uid, func(b *store.Balance) ([]store.BalanceOp, error) {
			return []store.BalanceOp{{Kind: store.EntryAdjustment, Cents: req.Cents, CaseID: req.CaseID, Note: req.Note,
				EntryID: fmt.Sprintf("adj_%s_%d", req.CaseID, time.Now().UnixNano())}}, nil
		})
		if err == nil {
			s.handleBalanceEffects(ctx, uid, fx)
			s.Store.AddCaseEvent(ctx, req.CaseID, store.CaseEvent{Who: a.who(), Kind: "note", Text: fmt.Sprintf("balance adjusted by %d cents: %s", req.Cents, req.Note)})
		}
	default:
		err = httpx.ErrInvalid("unknown action")
	}
	if err != nil {
		if apiErr, ok := err.(*httpx.APIError); ok {
			httpx.WriteErr(ctx, w, apiErr)
			return
		}
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "action_failed", "That didn't work: "+err.Error()))
		return
	}
	s.HandleAdminAccount(w, r, a, uid)
}

// writeOffOwed waives every owed item of an account (A3).
func (s *Service) writeOffOwed(ctx context.Context, uid string) error {
	var ids []string
	if runs, err := s.Store.ListUserByPIStatus(ctx, uid, store.PIChargeFailed, 500); err == nil {
		for _, c := range runs {
			ids = append(ids, c.ID)
		}
	}
	if groups, err := s.Store.ListUserBatchesByState(ctx, uid, store.BatchFailed, 200); err == nil {
		for _, b := range groups {
			for _, it := range b.Items {
				ids = append(ids, it.ConversionID)
			}
		}
	}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		if _, err := s.Store.WaiveRun(ctx, id); err != nil {
			return err
		}
	}
	return nil
}

// --------------------------------------------------------------- A4

// GET /v1/admin/disputes/summary?months=12[&format=csv] (BL-11): per month
// disputes by activity and by payment date, the activity rate against a
// 0.75% line, outcomes, money, early fraud warnings, open disputes, and
// breakdowns by method, flow and country. Stereo3D web charges only
// (metadata.product=svs-web); networks measure the whole account.
func (s *Service) HandleAdminDisputes(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	months := 12
	if v, err := strconv.Atoi(r.URL.Query().Get("months")); err == nil && v > 0 && v <= 24 {
		months = v
	}
	sum, err := s.disputeSummary(ctx, months)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "stripe_unavailable", "Couldn't load disputes: "+err.Error()))
		return
	}
	s.audit(ctx, a, "disputes_summary", map[string]any{"months": months})
	if r.URL.Query().Get("format") == "csv" {
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="stereo3d-disputes.csv"`)
		cw := csv.NewWriter(w)
		_ = cw.Write([]string{"month", "charges", "disputes_activity", "disputed_cents_activity", "disputes_by_payment", "activity_pct", "won", "lost", "efw", "efw_cents"})
		for _, m := range sum["months"].([]map[string]any) {
			_ = cw.Write([]string{m["month"].(string), fmt.Sprint(m["charges"]), fmt.Sprint(m["disputes_activity"]), fmt.Sprint(m["disputed_cents_activity"]),
				fmt.Sprint(m["disputes_by_payment"]), fmt.Sprintf("%.4f", m["activity_pct"]), fmt.Sprint(m["won"]), fmt.Sprint(m["lost"]),
				fmt.Sprint(m["efw"]), fmt.Sprint(m["efw_cents"])})
		}
		cw.Flush()
		return
	}
	httpx.WriteOK(w, sum)
}

func (s *Service) disputeSummary(ctx context.Context, months int) (map[string]any, error) {
	now := time.Now().UTC()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -(months - 1), 0)
	type month struct {
		charges, disputesAct, disputesPay, won, lost, accepted, countered, efw, efwRefunded, efwDisputed int
		disputedCents, lostCents, feeCents, efwCents                                                     int64
	}
	key := func(t time.Time) string { return t.UTC().Format("2006-01") }
	ms := map[string]*month{}
	var order []string
	for t := start; !t.After(now); t = t.AddDate(0, 1, 0) {
		k := key(t)
		ms[k] = &month{}
		order = append(order, k)
	}
	get := func(t time.Time) *month { return ms[key(t)] }
	if charges, err := s.Store.ListAllCharges(ctx, 20000); err == nil {
		for _, ch := range charges {
			if m := get(ch.PaidAt); m != nil && ch.Kind != "pi" {
				m.charges++
			}
		}
	}
	disputes, err := s.Stripe.ListDisputesSince(start, 2000)
	if err != nil {
		return nil, err
	}
	efws, err := s.Stripe.ListEFWsSince(start, 2000)
	if err != nil {
		return nil, err
	}
	facts := map[string]*stripex.PaymentFacts{}
	ours := func(pi string) *stripex.PaymentFacts {
		if pi == "" {
			return nil
		}
		if f, ok := facts[pi]; ok {
			return f
		}
		f, err := s.Stripe.PaymentFactsOf(pi)
		if err != nil || f.Metadata["product"] != "svs-web" || f.Metadata["env"] != s.Cfg.Env {
			f = nil
		}
		facts[pi] = f
		return f
	}
	byMethod, byFlow, byCountry := map[string]int{}, map[string]int{}, map[string]int{}
	disputedPI := map[string]bool{}
	var open []map[string]any
	for _, d := range disputes {
		pi := d.PaymentIntent
		if pi == "" && d.Charge != "" {
			pi, _ = s.Stripe.ChargePI(d.Charge)
		}
		f := ours(pi)
		if f == nil {
			continue
		}
		disputedPI[pi] = true
		created := time.Unix(d.Created, 0).UTC()
		if m := get(created); m != nil {
			m.disputesAct++
			m.disputedCents += d.Amount
			for _, bt := range d.BalanceTransactions {
				m.feeCents += bt.Fee
			}
			switch d.Status {
			case "won":
				m.won++
			case "lost":
				m.lost++
				m.lostCents += d.Amount
			}
		}
		if m := get(f.Created); m != nil {
			m.disputesPay++
		}
		method := f.MethodType
		if f.Wallet != "" {
			method = f.Wallet
		} else if f.Brand != "" {
			method = f.Brand
		}
		byMethod[method]++
		byFlow[firstNonEmpty(f.Metadata["payment_flow"], "after")]++
		byCountry[firstNonEmpty(f.Country, "unknown")]++
		switch d.Status {
		case "needs_response", "warning_needs_response", "under_review", "warning_under_review":
			row := map[string]any{"dispute_id": d.ID, "amount_cents": d.Amount, "reason": d.Reason, "status": d.Status, "payment_intent": pi}
			if d.EvidenceDetails.DueBy > 0 {
				row["due_by"] = time.Unix(d.EvidenceDetails.DueBy, 0).UTC()
			}
			if cs := s.disputeCase(ctx, pi, d.ID); cs != nil {
				row["case_id"] = cs.ID
				if cs.Decision != nil {
					if cs.Decision.Kind == "accept_dispute" {
						get(created).accepted++
					} else {
						get(created).countered++
					}
				}
			}
			open = append(open, row)
		}
	}
	for _, e := range efws {
		pi := e.PaymentIntent
		if pi == "" && e.Charge != "" {
			pi, _ = s.Stripe.ChargePI(e.Charge)
		}
		f := ours(pi)
		if f == nil {
			continue
		}
		if m := get(time.Unix(e.Created, 0)); m != nil {
			m.efw++
			m.efwCents += f.Received
			if f.Refunded > 0 {
				m.efwRefunded++
			}
			if disputedPI[pi] {
				m.efwDisputed++
			}
		}
	}
	sort.Slice(open, func(i, j int) bool {
		a, _ := open[i]["due_by"].(time.Time)
		b, _ := open[j]["due_by"].(time.Time)
		return a.Before(b)
	})
	var rows []map[string]any
	var tot month
	for _, k := range order {
		m := ms[k]
		pct := 0.0
		if m.charges > 0 {
			pct = float64(m.disputesAct) / float64(m.charges)
		}
		rows = append(rows, map[string]any{"month": k, "charges": m.charges, "disputes_activity": m.disputesAct,
			"disputed_cents_activity": m.disputedCents, "disputes_by_payment": m.disputesPay, "activity_pct": pct,
			"won": m.won, "lost": m.lost, "accepted": m.accepted, "countered": m.countered, "lost_cents": m.lostCents,
			"dispute_fees_cents": m.feeCents, "efw": m.efw, "efw_cents": m.efwCents, "efw_refunded": m.efwRefunded,
			"efw_became_disputes": m.efwDisputed})
		tot.won, tot.lost, tot.countered = tot.won+m.won, tot.lost+m.lost, tot.countered+m.countered
		tot.disputesAct += m.disputesAct
	}
	winRate, counterRate := 0.0, 0.0
	if tot.won+tot.lost > 0 {
		winRate = float64(tot.won) / float64(tot.won+tot.lost)
	}
	if tot.disputesAct > 0 {
		counterRate = float64(tot.countered) / float64(tot.disputesAct)
	}
	if open == nil {
		open = []map[string]any{}
	}
	stripeBase := "https://dashboard.stripe.com"
	if s.Cfg.Env != "prod" {
		stripeBase += "/test"
	}
	return map[string]any{
		"months":        rows,
		"reference_pct": s.policy(ctx).DisputeAlertPct,
		"win_rate":      winRate,
		"counter_rate":  counterRate,
		"open":          open,
		"by_method":     byMethod,
		"by_flow":       byFlow,
		"by_country":    byCountry,
		"scope":         "Stereo3D web charges only (metadata.product=svs-web); card networks measure the whole Stripe account",
		"account_wide":  stripeBase + "/disputes",
		"denominator":   "successful charges from the gateway's charge records (charges_" + s.Cfg.Env + ")",
		"generated_at":  now,
	}, nil
}
