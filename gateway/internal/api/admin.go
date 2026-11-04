package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Admin API (spec M1): /v1/admin/*, called only from the admin console's
// origin, by a Firebase account with the svs_admin claim and a second
// factor; money actions need a sign-in within the last 5 minutes. Every
// call is audited (admin_audit_{env}) and every case action is a timeline
// event. Customer-supplied strings are returned as plain text; the console
// renders them as text only.

// AdminUser is a verified admin caller.
type AdminUser struct {
	UID      string
	Email    string
	AuthTime time.Time // the Firebase token's auth_time
	// Method: "passkey" when a valid X-Admin-Session came with the call
	// (ADR 0135), else "totp" (the Identity Platform second factor).
	// AssertedAt: the session's last passkey assertion.
	Method     string
	AssertedAt time.Time
	Session    *AdminSession
}

// adminFresh is how recent the proof must be for money actions.
const adminFresh = 5 * time.Minute

// FreshAuth: money actions need a passkey assertion (or, on the TOTP
// path, a sign-in) within the last 5 minutes.
func (a *AdminUser) FreshAuth() bool {
	if a.Method == "passkey" {
		return time.Since(a.AssertedAt) <= adminFresh
	}
	return time.Since(a.AuthTime) <= adminFresh
}

// reauthErr is 401 reauth_required naming how to prove it again.
func (a *AdminUser) reauthErr() error {
	if a != nil && a.Method == "passkey" {
		e := httpx.Err(http.StatusUnauthorized, "reauth_required", "confirm it's you again with your passkey")
		e.Details = map[string]any{"method": "passkey"}
		return e
	}
	return errReauth()
}

func (a *AdminUser) who() string {
	if a.Email != "" {
		return a.Email
	}
	return a.UID
}

func errReauth() error {
	return httpx.Err(http.StatusUnauthorized, "reauth_required", "confirm it's you again: sign in within the last 5 minutes for money actions")
}

func (s *Service) audit(ctx context.Context, a *AdminUser, action string, data map[string]any) {
	row := map[string]any{"admin": a.who(), "admin_uid": a.UID, "action": action}
	for k, v := range data {
		row[k] = v
	}
	_ = s.Store.Audit(ctx, row)
}

// ------------------------------------------------------------ A1 list

// GET /v1/admin/cases?tab=open|waiting|decided|closed|all&type=&reason=&mode=&cap=over|under&q=
// → {cases: [row], counts {open, overdue, due_today}}. Disputes, efw and
// refund_failed first, then oldest first.
func (s *Service) HandleAdminCases(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	q := r.URL.Query()
	tab := q.Get("tab")
	if tab == "" {
		tab = "open"
	}
	var cases []*store.Case
	var err error
	switch tab {
	case "closed":
		cases, err = s.Store.ListCases(ctx, false, 500)
	case "all":
		open, e1 := s.Store.ListCases(ctx, true, 500)
		closed, e2 := s.Store.ListCases(ctx, false, 500)
		cases, err = append(open, closed...), errors.Join(e1, e2)
	default:
		cases, err = s.Store.ListCases(ctx, true, 500)
	}
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "cases_unavailable", "Couldn't load cases."))
		return
	}
	pol := s.policy(ctx)
	now := time.Now().UTC()
	search := strings.ToLower(strings.TrimSpace(q.Get("q")))
	counts := map[string]int{"open": 0, "overdue": 0, "due_today": 0}
	var rows []map[string]any
	for _, c := range cases {
		if c.Status == store.CaseOpen {
			counts["open"]++
			if c.DeadlineAt != nil && c.DeadlineAt.Before(now) {
				counts["overdue"]++
			} else if c.DeadlineAt != nil && c.DeadlineAt.Sub(now) < 24*time.Hour {
				counts["due_today"]++
			}
		}
		switch tab {
		case "open":
			if c.Status != store.CaseOpen && c.Status != store.CaseRefundPending {
				continue
			}
		case "waiting":
			if c.Status != store.CaseWaitingOnCustomer && c.Status != store.CaseWaitingForRun {
				continue
			}
		case "decided":
			if c.Status != store.CaseDecided {
				continue
			}
		}
		if v := q.Get("type"); v != "" && c.Type != v {
			continue
		}
		if v := q.Get("reason"); v != "" && c.Reason != v {
			continue
		}
		if v := q.Get("mode"); v != "" && c.Mode != v {
			continue
		}
		if v := q.Get("cap"); v != "" && (v == "over") != (c.RequestedCents > pol.ManualAboveCents) {
			continue
		}
		email := s.accountEmail(ctx, c.UID)
		if search != "" && !caseMatches(c, email, search) {
			continue
		}
		row := map[string]any{"id": c.ID, "type": c.Type, "reason": c.Reason, "mode": c.Mode, "status": c.Status, "result": c.Result,
			"opened_at": c.OpenedAt, "age_hours": int(now.Sub(c.OpenedAt).Hours()), "email_masked": maskEmail(email),
			"requested_cents": c.RequestedCents, "deadline_at": c.DeadlineAt, "last_activity_at": c.LastActivityAt}
		if c.DeadlineAt != nil {
			row["deadline_red"] = c.DeadlineAt.Sub(now) < 12*time.Hour
		}
		if c.Dispute != nil && c.Dispute.DueBy != nil {
			row["dispute_due"] = c.Dispute.DueBy
		}
		if max, ok := s.caseMaxRefundable(ctx, c); ok {
			row["max_refundable_cents"] = max
		}
		rows = append(rows, row)
	}
	rank := func(row map[string]any) int {
		switch {
		case row["type"] == store.CaseDispute:
			return 0
		case row["reason"] == ReasonEFW, row["reason"] == ReasonRefundFailed:
			return 1
		}
		return 2
	}
	sort.SliceStable(rows, func(i, j int) bool {
		if ri, rj := rank(rows[i]), rank(rows[j]); ri != rj {
			return ri < rj
		}
		return rows[i]["opened_at"].(time.Time).Before(rows[j]["opened_at"].(time.Time))
	})
	if rows == nil {
		rows = []map[string]any{}
	}
	s.audit(ctx, a, "cases_list", map[string]any{"tab": tab})
	httpx.WriteOK(w, map[string]any{"cases": rows, "counts": counts})
}

func caseMatches(c *store.Case, email, q string) bool {
	if strings.Contains(strings.ToLower(c.ID), q) || strings.Contains(strings.ToLower(email), q) {
		return true
	}
	for _, list := range [][]string{c.Related.ConversionIDs, c.Related.PIIDs, c.RefundIDs} {
		for _, v := range list {
			if strings.Contains(strings.ToLower(v), q) {
				return true
			}
		}
	}
	return strings.Contains(strings.ToLower(c.Related.DisputeID), q)
}

// --------------------------------------------------------- A2 case page

// perRun is the live per-run table (C8): price, refunded so far,
// refundable now, delivered.
func (s *Service) perRun(ctx context.Context, c *store.Case) ([]map[string]any, int64) {
	if c.Reason == ReasonPlanRefund {
		return s.planRefundRows(ctx, c)
	}
	var rows []map[string]any
	var max int64
	var live *store.ChargeRefundable
	if len(c.Related.PIIDs) > 0 && len(c.Related.ChargeIDs) > 0 {
		pi := c.Related.PIIDs[0]
		remainder := int64(-1)
		if f, err := s.Stripe.PaymentFactsOf(pi); err == nil {
			remainder = f.Received - f.Refunded
			if f.ChargeDisputed {
				remainder = 0 // no refund while a dispute is open
			}
		}
		if _, l, err := s.Store.Refundable(ctx, c.Related.ChargeIDs[0], pi, remainder); err == nil {
			live = &l
			max = max0(l.Remainder - l.Unassigned)
		} else if remainder >= 0 {
			max = remainder
		}
	}
	var sum int64
	for _, id := range c.Related.ConversionIDs {
		conv, err := s.Store.GetConversion(ctx, id)
		if err != nil {
			continue
		}
		m := s.moneyOf(ctx, conv)
		row := map[string]any{"conversion_id": id, "label": s.runLabel(ctx, conv), "state": conv.State, "price_cents": m.Price,
			"delivered": deliveredOf(conv), "paid_from": paidFrom(m)}
		refundable := m.Price
		switch {
		case m.Balance:
			back, _ := s.Store.RefundedToBalance(ctx, conv.UID, id)
			row["refunded_cents"], refundable = back, max0(m.Price-back)
		case live != nil:
			row["refunded_cents"] = live.Refunded[id]
			refundable = live.Refundable[id]
		case m.Unpaid:
			refundable = 0
			row["owed_cents"] = conv.Quote.AmountCents
		}
		row["refundable_cents"] = refundable
		sum += refundable
		rows = append(rows, row)
	}
	if live == nil {
		max = sum
	} else {
		max = min(max, sum)
	}
	if len(c.Related.ConversionIDs) == 0 && c.Related.TopupID != "" {
		if b, err := s.Store.GetBalance(ctx, c.UID); err == nil {
			max = min(b.CashCents(), max0(b.Available()))
		}
	}
	if rows == nil {
		rows = []map[string]any{}
	}
	return rows, max
}

func max0(v int64) int64 { return max(v, 0) }

func deliveredOf(c *store.Conversion) string {
	switch {
	case c.State == store.StateSucceeded:
		return "yes"
	case len(c.Outputs) > 0:
		return "partly"
	}
	return "no"
}

func paidFrom(m runMoney) string {
	switch {
	case m.Balance:
		return "balance"
	case m.Unpaid:
		return "owed"
	case m.Kind != "":
		return m.Kind
	}
	return "free"
}

func (s *Service) caseMaxRefundable(ctx context.Context, c *store.Case) (int64, bool) {
	if c.Type == store.CaseDispute || !c.Open {
		return 0, false
	}
	_, m := s.perRun(ctx, c)
	return m, true
}

// GET /v1/admin/cases/{id} → {case, runs, max_refundable_cents, events,
// evidence, related_cases, hints, banners, account, refunds}.
func (s *Service) HandleAdminCase(w http.ResponseWriter, r *http.Request, a *AdminUser, id string) {
	ctx := r.Context()
	c, err := s.Store.GetCase(ctx, id)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrNotFound("case"))
		return
	}
	httpx.WriteOK(w, s.casePage(ctx, c))
	s.audit(ctx, a, "case_view", map[string]any{"case_id": id})
}

func (s *Service) casePage(ctx context.Context, c *store.Case) map[string]any {
	c.FollowUpIDs = []string{}
	if ids, err := s.Store.ListFollowUpIDs(ctx, c.ID); err == nil {
		c.FollowUpIDs = ids
	}
	runs, max := s.perRun(ctx, c)
	events, _ := s.Store.ListCaseEvents(ctx, c.ID, 200)
	evidence, _ := s.Store.LatestEvidence(ctx, c.ID)
	var related []map[string]any
	if c.UID != "" {
		if cases, err := s.Store.ListUserCases(ctx, c.UID, 50); err == nil {
			for _, o := range cases {
				if o.ID != c.ID {
					related = append(related, map[string]any{"id": o.ID, "type": o.Type, "reason": o.Reason, "status": o.Status, "result": o.Result})
				}
			}
		}
	}
	var refunds []*store.RefundRow
	for _, pi := range c.Related.PIIDs {
		if rows, err := s.Store.ListRefundRows(ctx, pi); err == nil {
			refunds = append(refunds, rows...)
		}
	}
	hints := []string{}
	switch {
	case c.Type == store.CaseEFW:
		hints = append(hints, "Stripe suggests refunding warnings when the amount is at or below the dispute fee (£20).")
	case c.Type == store.CaseDispute:
		var back int64
		var when time.Time
		for _, rr := range refunds {
			if rr.Counts() {
				back += rr.TotalCents
				when = rr.CreatedAt
			}
		}
		if back > 0 {
			hints = append(hints, fmt.Sprintf("Already refunded %s on %s: counter with the refund proof.", money(back), when.Format("2 Jan 2006")))
		} else {
			hints = append(hints, "Your policy (BL-11): counter over $50 when downloads are logged.")
		}
	}
	banners := []string{}
	switch {
	case c.Result == store.CaseSuperseded:
		banners = append(banners, fmt.Sprintf("Superseded by dispute %s. Refunds are blocked while the dispute is open.", c.Related.SupersededBy))
	case c.Result == store.CaseDuplicate:
		banners = append(banners, "Closed as a duplicate"+ifThen(c.Related.DuplicateOf != "", " of "+c.Related.DuplicateOf)+".")
	case c.Status == store.CaseWaitingForRun:
		banners = append(banners, "Waiting for the run to finish.")
	case c.Status == store.CaseRefundPending:
		banners = append(banners, "Refund sent to the bank, waiting for confirmation.")
	}
	if c.Reason == ReasonRefundFailed {
		banners = append(banners, "The refund failed; pay it another way and mark it refunded outside Stripe.")
	}
	email := s.accountEmail(ctx, c.UID)
	acct := map[string]any{"uid": c.UID, "email": email}
	if cust, err := s.Store.GetCustomer(ctx, c.UID); err == nil && cust.StripeCustomerID != "" {
		if info, ierr := s.Stripe.DefaultMethod(cust.StripeCustomerID, cust.BackupOrder...); ierr == nil && info != nil {
			acct["payment_method"] = methodLabel(info)
		}
	}
	return map[string]any{"case": c, "runs": runs, "max_refundable_cents": max, "events": events, "evidence": evidence,
		"related_cases": related, "hints": hints, "banners": banners, "account": acct, "refunds": refunds,
		"actions": caseActions(c)}
}

func ifThen(ok bool, s string) string {
	if ok {
		return s
	}
	return ""
}

// caseActions lists what the console offers on a case (A2's table).
func caseActions(c *store.Case) []string {
	if !c.Open { // closed is final unless reopened; a customer's message opens a follow-up case
		return []string{"reopen", "customer_reply"}
	}
	switch {
	case c.Type == store.CaseDispute:
		return []string{"accept_dispute", "counter_dispute", "counter_with_refund_proof", "note", "refresh_evidence", "close"}
	case c.Type == store.CaseWaive:
		return []string{"waive", "deny", "note", "refresh_evidence", "close"}
	case c.Reason == ReasonUnassigned:
		return []string{"assign", "note", "close"}
	case c.Reason == ReasonRefundFailed:
		return []string{"approve", "mark_out_of_band", "note", "refresh_evidence", "close"}
	case c.Status == store.CaseWaitingForRun:
		return []string{"stop_run", "note", "refresh_evidence", "close"}
	case c.Type == store.CaseEFW:
		return []string{"approve", "partial", "no_refund", "note", "refresh_evidence", "close"}
	case c.Type == store.CaseBalanceRefund:
		return []string{"approve", "partial", "deny", "mark_out_of_band", "note", "close"}
	case c.Reason == ReasonPlanRefund:
		return []string{"approve", "partial", "deny", "note", "close"}
	}
	return []string{"approve", "partial", "deny", "ask", "customer_reply", "mark_out_of_band", "note", "refresh_evidence", "close"}
}

// caseActionReq is POST /v1/admin/cases/{id}/actions.
type caseActionReq struct {
	Action string           `json:"action"`
	Items  map[string]int64 `json:"items"` // partial, assign, out of band: cents per run
	// ExpectedMaxCents: the maximum the page showed; a changed maximum
	// is 409 amount_changed (the console asks again).
	ExpectedMaxCents *int64 `json:"expected_max_cents"`
	Template         string `json:"template"` // deny: delivered | outside_terms | other
	Text             string `json:"text"`
	Method           string `json:"method"`    // out of band
	Reference        string `json:"reference"` // out of band
}

var moneyActions = map[string]bool{"approve": true, "partial": true, "waive": true, "deny": true, "mark_out_of_band": true,
	"stop_run": true, "assign": true, "no_refund": true}

// POST /v1/admin/cases/{id}/actions {action, …} → the case page.
func (s *Service) HandleAdminCaseAction(w http.ResponseWriter, r *http.Request, a *AdminUser, id string) {
	ctx := r.Context()
	var req caseActionReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	if moneyActions[req.Action] && !a.FreshAuth() {
		httpx.WriteErr(ctx, w, a.reauthErr())
		return
	}
	c, err := s.Store.GetCase(ctx, id)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrNotFound("case"))
		return
	}
	if !c.Open {
		s.closedCaseAction(w, r, a, c, req)
		return
	}
	if !contains(caseActions(c), req.Action) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "action_unavailable", "that action isn't available on this case now"))
		return
	}
	s.audit(ctx, a, "case_"+req.Action, map[string]any{"case_id": id, "items": req.Items, "template": req.Template})
	if err := s.applyCaseAction(ctx, c, req, a.who()); err != nil {
		var apiErr *httpx.APIError
		if errors.As(err, &apiErr) {
			httpx.WriteErr(ctx, w, apiErr)
			return
		}
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "action_failed", "That didn't work: "+err.Error()+". Nothing was charged or refunded."))
		return
	}
	if c.Reason == ReasonClosure {
		s.finishPendingDeletions(ctx) // N8: the deletion waited for this decision
	}
	fresh, _ := s.Store.GetCase(ctx, id)
	httpx.WriteOK(w, s.casePage(ctx, fresh))
}

func errCaseClosed() error {
	return httpx.Err(http.StatusConflict, "case_closed", "This case is closed. Reopen it first (action reopen, with the reason).")
}

// closedCaseAction: a closed case takes reopen {text: the reason} and a
// customer's message (customer_reply), which never writes to it but opens
// a follow-up case (follow_up_of) and notices the owner as a new case
// does; anything else is 409 case_closed.
func (s *Service) closedCaseAction(w http.ResponseWriter, r *http.Request, a *AdminUser, c *store.Case, req caseActionReq) {
	ctx := r.Context()
	switch req.Action {
	case "reopen":
		reason := strings.TrimSpace(req.Text)
		if reason == "" {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("say why the case reopens (text)"))
			return
		}
		s.audit(ctx, a, "case_reopen", map[string]any{"case_id": c.ID, "reason": reason})
		fresh, err := s.Store.ReopenCase(ctx, c.ID, a.who(), reason)
		if err != nil {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "case_not_closed", "That case isn't closed."))
			return
		}
		httpx.WriteOK(w, s.casePage(ctx, fresh))
	case "customer_reply":
		text := strings.TrimSpace(req.Text)
		if text == "" {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("the customer's message (text)"))
			return
		}
		s.audit(ctx, a, "case_customer_reply_follow_up", map[string]any{"case_id": c.ID})
		nc, err := s.followUpCase(ctx, c, text, a.who())
		if err != nil {
			httpx.WriteErr(ctx, w, httpx.ErrServer())
			return
		}
		httpx.WriteOK(w, s.casePage(ctx, nc)) // case.follow_up_of names the closed one
	default:
		httpx.WriteErr(ctx, w, errCaseClosed())
	}
}

// followUpCase opens (or finds the open) follow-up of a closed case for a
// customer's message and puts the message on it.
func (s *Service) followUpCase(ctx context.Context, old *store.Case, text, who string) (*store.Case, error) {
	nc, err := s.openCase(ctx, &store.Case{UID: old.UID, Type: store.CaseSupport, Reason: ReasonSupport, Mode: "manual", Source: "customer_reply",
		Status: store.CaseOpen, DedupeKey: "follow_up:" + old.ID, CustomerText: text,
		Related: store.CaseRelated{ConversionIDs: old.Related.ConversionIDs, PIIDs: old.Related.PIIDs, ChargeIDs: old.Related.ChargeIDs,
			TopupID: old.Related.TopupID, LinkedCaseIDs: []string{old.ID}}, FollowUpOf: old.ID},
		who, "customer wrote again on closed case "+old.ID)
	if err != nil {
		return nil, err
	}
	if err := s.Store.AddCaseEvent(ctx, nc.ID, store.CaseEvent{Who: "customer", Kind: "customer_message_in", Text: text,
		Data: map[string]any{"follow_up_of": old.ID}}); err != nil {
		return nil, err
	}
	return nc, nil
}

// applyCaseAction runs one A2 action (shared with svs-admin).
func (s *Service) applyCaseAction(ctx context.Context, c *store.Case, req caseActionReq, who string) error {
	now := time.Now().UTC()
	decide := func(kind string, items map[string]int64) {
		s.Store.UpdateCase(ctx, c.ID, who, func(x *store.Case) error {
			x.Decision = &store.CaseDecision{Kind: kind, Items: items, By: who, At: now, CustomerTemplate: req.Template, Text: req.Text}
			x.DecidedAt = &now
			if x.Status == store.CaseOpen || x.Status == store.CaseWaitingOnCustomer {
				x.Status = store.CaseDecided
			}
			return nil
		})
		s.Store.AddCaseEvent(ctx, c.ID, store.CaseEvent{Who: who, Kind: "decision", Text: kind, Data: map[string]any{"items": items}})
	}
	checkMax := func() (int64, error) {
		_, max := s.perRun(ctx, c)
		if req.ExpectedMaxCents != nil && *req.ExpectedMaxCents != max {
			e := httpx.Err(http.StatusConflict, "amount_changed", "The amount changed to "+money(max)+".")
			e.Details = map[string]any{"max_refundable_cents": max}
			return max, e
		}
		return max, nil
	}
	switch req.Action {
	case "note":
		if err := s.Store.AddCaseEvent(ctx, c.ID, store.CaseEvent{Who: who, Kind: "note", Text: req.Text}); errors.Is(err, store.ErrCaseClosed) {
			return errCaseClosed()
		} else {
			return err
		}
	case "customer_reply":
		s.Store.AddCaseEvent(ctx, c.ID, store.CaseEvent{Who: "customer", Kind: "customer_message_in", Text: req.Text})
		_, err := s.Store.UpdateCase(ctx, c.ID, who, func(x *store.Case) error {
			if x.Status == store.CaseWaitingOnCustomer {
				x.Status = store.CaseOpen
			}
			return nil
		})
		return err
	case "refresh_evidence":
		s.buildEvidence(ctx, c)
		return s.Store.AddCaseEvent(ctx, c.ID, store.CaseEvent{Who: who, Kind: "evidence_refreshed"})
	case "ask":
		if strings.TrimSpace(req.Text) == "" {
			return httpx.ErrInvalid("write the question")
		}
		s.mailRefundQuestion(ctx, c, req.Text)
		s.Store.AddCaseEvent(ctx, c.ID, store.CaseEvent{Who: who, Kind: "customer_message_out", Text: req.Text})
		_, err := s.Store.UpdateCase(ctx, c.ID, who, func(x *store.Case) error { x.Status = store.CaseWaitingOnCustomer; return nil })
		return err
	case "approve", "partial":
		max, err := checkMax()
		if err != nil {
			return err
		}
		runs, _ := s.perRun(ctx, c)
		items := map[string]int64{}
		for _, row := range runs {
			id, _ := row["conversion_id"].(string)
			left, _ := row["refundable_cents"].(int64)
			want := left
			if req.Action == "partial" {
				want = min(req.Items[id], left)
			}
			if want > 0 {
				items[id] = want
			}
		}
		if c.Type == store.CaseBalanceRefund {
			cents := max
			if req.Action == "partial" {
				cents = min(req.Items["balance"], max)
			}
			decide(map[bool]string{true: "full", false: "partial"}[req.Action == "approve"], map[string]int64{"balance": cents})
			return s.cashRefundBalance(ctx, c, cents, who)
		}
		if len(items) == 0 {
			return httpx.Err(http.StatusConflict, "nothing_refundable", "There's nothing left to refund on this case.")
		}
		decide(map[bool]string{true: "full", false: "partial"}[req.Action == "approve"], items)
		if c.Reason == ReasonPlanRefund {
			var want int64
			for _, v := range items {
				want += v
			}
			return s.planRefund(ctx, c, want, who)
		}
		_, err = s.refundCase(ctx, c, items, who)
		return err
	case "waive":
		var total int64
		for _, id := range c.Related.ConversionIDs {
			cents, err := s.Store.WaiveRun(ctx, id)
			if err != nil {
				return httpx.Err(http.StatusConflict, "waive_refused", "That run can't be waived now: "+err.Error())
			}
			total += cents
		}
		decide("waive", nil)
		s.Store.UpdateCase(ctx, c.ID, who, func(x *store.Case) error {
			x.DecidedCents, x.Status, x.Result = total, store.CaseClosed, store.CaseWaived
			return nil
		})
		if c.CustomerVisible {
			s.mailRefunded(ctx, c, total, "waive")
		}
		return nil
	case "deny", "no_refund":
		text := denyTemplates[req.Template]
		if req.Template == "other" || text == "" {
			text = strings.TrimSpace(req.Text)
		}
		if req.Action == "deny" && text == "" {
			return httpx.ErrInvalid("pick a template or write the text")
		}
		decide(req.Action, nil)
		s.closeCase(ctx, c.ID, who, store.CaseDenied, "")
		if req.Action == "deny" && c.CustomerVisible {
			s.mailRefundDenied(ctx, c, text)
		}
		return nil
	case "mark_out_of_band":
		return s.markOutOfBand(ctx, c, req, who)
	case "assign":
		return s.assignDashboardRefund(ctx, c, req.Items, who)
	case "stop_run":
		for _, id := range c.Related.ConversionIDs {
			if conv, err := s.Store.GetConversion(ctx, id); err == nil && !store.IsTerminal(conv.State) {
				if _, err := s.cancelRunAsUs(ctx, conv, "us"); err != nil {
					return err
				}
			}
		}
		decide("stop_run", nil)
		s.closeCase(ctx, c.ID, who, "stopped", "run stopped: refunded in full by its own path")
		return nil
	case "accept_dispute":
		// Accepting closes the dispute in Stripe (it reads lost); the
		// charge.dispute.closed webhook closes the case.
		if c.Related.DisputeID == "" {
			return httpx.ErrInvalid("this case has no dispute id")
		}
		if _, err := s.Stripe.CloseDispute(c.Related.DisputeID); err != nil {
			return fmt.Errorf("Stripe didn't accept the dispute: %s", stripex.ErrMessage(err))
		}
		decide(req.Action, nil)
		return nil
	case "counter_dispute", "counter_with_refund_proof":
		decide(req.Action, nil) // evidence goes in from the Stripe Dashboard; recorded here
		return nil
	case "close":
		if c.Status != store.CaseDecided && c.Decision == nil && req.Text == "" {
			return httpx.Err(http.StatusConflict, "not_decided", "Close only when decided, or say why (a duplicate).")
		}
		s.closeCase(ctx, c.ID, who, firstNonEmpty(c.Result, store.CaseDuplicate), req.Text)
		return nil
	}
	return httpx.ErrInvalid("unknown action")
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// markOutOfBand is C8's console action: a ledger row out_of_band per run,
// a credit note if invoiced, E6 "another way".
func (s *Service) markOutOfBand(ctx context.Context, c *store.Case, req caseActionReq, who string) error {
	if len(c.Related.PIIDs) == 0 || len(req.Items) == 0 {
		return httpx.ErrInvalid("give the cents per run")
	}
	pi := c.Related.PIIDs[0]
	row, err := s.Store.ReserveRefund(ctx, store.ReserveSpec{ChargeID: firstOr(c.Related.ChargeIDs, "pi_"+pi), PI: pi, CaseID: c.ID, UID: c.UID,
		Items: req.Items, StripeRemainder: -1, Source: "gateway", Status: store.RefundOutOfBand,
		Note: strings.TrimSpace(req.Method + " " + req.Reference)})
	if err != nil {
		return err
	}
	s.Store.UpdateCase(ctx, c.ID, who, func(x *store.Case) error {
		x.Decision = &store.CaseDecision{Kind: "out_of_band", Items: row.Items, By: who, At: time.Now().UTC(), Text: req.Method + " " + req.Reference}
		x.RefundIDs, x.DecidedCents = append(x.RefundIDs, row.ID), x.DecidedCents+row.TotalCents
		x.Status, x.Result = store.CaseClosed, store.CaseRefunded
		return nil
	})
	s.Store.AddCaseEvent(ctx, c.ID, store.CaseEvent{Who: who, Kind: "refund_executed", Text: money(row.TotalCents) + " outside Stripe"})
	s.creditNoteFor(ctx, row) // out_of_band_amount when invoiced (V10)
	s.mailRefunded(ctx, c, row.TotalCents, "out_of_band")
	return nil
}

// assignDashboardRefund splits an unassigned Dashboard refund over runs
// (the cents must add up to it).
func (s *Service) assignDashboardRefund(ctx context.Context, c *store.Case, items map[string]int64, who string) error {
	var rowID string
	var total int64
	for _, pi := range c.Related.PIIDs {
		rows, _ := s.Store.ListRefundRows(ctx, pi)
		for _, r := range rows {
			if r.CaseID == c.ID {
				rowID, total = r.ID, r.TotalCents
			}
		}
	}
	var sum int64
	for _, v := range items {
		sum += v
	}
	if rowID == "" || sum != total {
		return httpx.Err(http.StatusBadRequest, "assign_mismatch", fmt.Sprintf("the cents must add up to %s", money(total)))
	}
	if _, err := s.Store.UpdateRefundRow(ctx, rowID, func(r *store.RefundRow) error { r.Items = items; return nil }); err != nil {
		return err
	}
	s.Store.UpdateCase(ctx, c.ID, who, func(x *store.Case) error {
		x.Decision = &store.CaseDecision{Kind: "assign", Items: items, By: who, At: time.Now().UTC()}
		x.Status, x.Result = store.CaseClosed, store.CaseRefunded
		return nil
	})
	return nil
}

// POST /v1/admin/cases {uid, conversion_ids?, reason, text, type?} →
// the case page (a support request, a balance refund, …).
func (s *Service) HandleAdminOpenCase(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	var req struct {
		UID           string   `json:"uid"`
		ConversionIDs []string `json:"conversion_ids"`
		Reason        string   `json:"reason"`
		Text          string   `json:"text"`
		TopupID       string   `json:"topup_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.UID == "" {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("uid is required"))
		return
	}
	s.audit(ctx, a, "case_open", map[string]any{"uid": req.UID, "reason": req.Reason, "conversion_ids": req.ConversionIDs})
	var cases []*store.Case
	var err error
	switch req.Reason {
	case ReasonPlanRefund: // the latest plan invoice; proposes paid × unspent ÷ credit
		var c *store.Case
		c, err = s.openPlanRefundCase(ctx, req.UID, a.who(), req.Text)
		if c != nil {
			cases = append(cases, c)
		}
	case ReasonTopupWithdraw, ReasonClosure:
		var c *store.Case
		c, err = s.requestBalanceRefund(ctx, req.UID, req.Reason, req.TopupID, "support", a.who(), req.Text)
		if c != nil {
			cases = append(cases, c)
		}
	default:
		if len(req.ConversionIDs) == 0 {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("name the runs (conversion_ids)"))
			return
		}
		cases, err = s.requestRefund(ctx, RefundRequest{UID: req.UID, ConversionIDs: req.ConversionIDs, Reason: req.Reason,
			Source: "support", Who: a.who(), Text: req.Text})
	}
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "case_refused", err.Error()))
		return
	}
	out := make([]map[string]any, 0, len(cases))
	for _, c := range cases {
		if fresh, gerr := s.Store.GetCase(ctx, c.ID); gerr == nil {
			out = append(out, s.casePage(ctx, fresh))
		}
	}
	httpx.WriteOK(w, map[string]any{"cases": out})
}

// GET /v1/admin/policy → the refund policy in force (read-only here; it
// is edited in Firestore config/refund_policy_{env}).
func (s *Service) HandleAdminPolicy(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	httpx.WriteOK(w, map[string]any{"policy": s.policy(r.Context()), "edit_in": "config/refund_policy_" + s.Cfg.Env})
}
