package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Refund requests from Billing (owner 2026-11-06). A customer's request is
// always decided by a person: it opens a manual case (source customer,
// ForceManual) of the kind admins decide in the console today, whatever
// the refund policy says for its reason (RF-01: the automatic refunds for
// undelivered or duplicate money stay automatic on their own paths).
//
//   - GET /v1/support/refund-options → {window_days, plan, runs}: what can
//     be asked for, paid in the last 30 days (RF-03; a cancelled plan too).
//     plan: {invoice_id, plan, name, paid_at, paid_cents, cancelled,
//     open_request_id} or null; runs: [{conversion_id, label, paid_at,
//     amount_cents, open_request_id}] (an unfinished, unpaid or refunded
//     run isn't listed).
//   - POST /v1/support/refund-requests {plan?: bool, conversion_ids?: [],
//     text?} (a sign-in from the last 5 minutes) → 201 {requests: [{id,
//     state, status, merged}]}. Only what the options list; something
//     already asked for joins that open case (merged). 400
//     not_refundable {conversion_ids, plan}; 400 text_too_long (2,000
//     characters); 409 too_many_open (10 open requests); 429 rate_limited
//     {retry_after_s} (3 a day per account, 10 an hour per address); 403
//     account_deleted / deletion_pending.
//   - GET /v1/support/requests → {requests: [{id, about, state, status,
//     opened_at, updated_at, requested_cents, refunded_cents, your_note,
//     question, follow_up_of}]}: the account's cases it may see, newest
//     first; status in plain words.
//   - POST /v1/support/requests/{id}/reply {text} → the request: a message
//     on an open case (a question answered puts it back in review), or a
//     follow-up case for a closed one. 404 request_not_found; 10 an hour.
//
// Balance withdrawals aren't offered here yet: they join once RF-02 makes
// them manual (balance_refunds.go).

const (
	SourceCustomer = "customer"

	refundRequestWindow      = 30 * 24 * time.Hour
	refundRequestsPerDay     = 3
	refundRequestsOpenMax    = 10
	refundRequestsPerIPHour  = 10
	supportTextMax           = 2000
	supportRepliesPerHour    = 10
	refundRunsLookbackFactor = 2 // runs created up to 60 days ago can have been paid in the window
)

// Request states (state) and their words (status).
const (
	requestLooking     = "looking"
	requestAsked       = "asked"
	requestRefunded    = "refunded"
	requestNotRefunded = "not_refunded"
	requestWaived      = "waived"
	requestClosed      = "closed"
)

var requestWords = map[string]string{
	requestLooking:     "We're looking at it",
	requestAsked:       "We asked you a question",
	requestRefunded:    "Refunded",
	requestNotRefunded: "Not refunded",
	requestWaived:      "You don't need to pay it",
	requestClosed:      "Closed",
}

var caseIDPattern = regexp.MustCompile(`^CASE-[0-9]{4,9}$`)

// ValidCaseID: a case id as the store writes it (CASE-0042).
func ValidCaseID(id string) bool { return caseIDPattern.MatchString(id) }

// requestState is a case's state for its customer.
func requestState(c *store.Case) string {
	switch c.Status {
	case store.CaseWaitingOnCustomer:
		return requestAsked
	case store.CaseRefunded:
		return requestRefunded
	case store.CaseDenied:
		return requestNotRefunded
	case store.CaseWaived:
		return requestWaived
	case store.CaseSuperseded, store.CaseDuplicate:
		return requestClosed
	case store.CaseClosed:
		switch c.Result {
		case store.CaseRefunded:
			return requestRefunded
		case store.CaseDenied:
			return requestNotRefunded
		case store.CaseWaived:
			return requestWaived
		}
		return requestClosed
	}
	return requestLooking // open, waiting for the run, decided, refund pending
}

// refundOption is one thing that can be asked for.
type refundOption struct {
	ConversionID string
	Label        string
	PaidAt       time.Time
	Cents        int64
	OpenCase     string
}

type planRefundOption struct {
	InvoiceID string
	Tier      string
	Name      string
	PaidAt    time.Time
	PaidCents int64
	Cancelled bool
	OpenCase  string
}

// runPaidAt is when a run's money was taken: its charge record, the
// capture, the balance settle, else when it was made.
func (s *Service) runPaidAt(ctx context.Context, c *store.Conversion, m runMoney) time.Time {
	if m.ChargeID != "" {
		if ch, err := s.Store.GetCharge(ctx, m.ChargeID); err == nil && !ch.PaidAt.IsZero() {
			return ch.PaidAt
		}
	}
	if c.Stripe.CapturedAt != nil {
		return *c.Stripe.CapturedAt
	}
	if c.RunBalance != nil && c.RunBalance.ClosedAt != nil {
		return *c.RunBalance.ClosedAt
	}
	return c.CreatedAt
}

// caseOpenFor: the open case on these cases' list, and whether one ended
// refunded.
func caseOpenFor(cases []*store.Case) (open string, refunded bool) {
	for _, cs := range cases {
		switch {
		case cs.Open && open == "":
			open = cs.ID
		case !cs.Open && requestState(cs) == requestRefunded:
			refunded = true
		}
	}
	return open, refunded
}

// refundableRuns are the runs uid paid for in the window, newest first.
func (s *Service) refundableRuns(ctx context.Context, uid string, now time.Time) ([]refundOption, error) {
	convs, err := s.Store.ListUserConversionsSince(ctx, uid, now.Add(-refundRunsLookbackFactor*refundRequestWindow), 200)
	if err != nil {
		return nil, err
	}
	out := []refundOption{}
	for _, c := range convs {
		if !store.IsTerminal(c.State) {
			continue // a running job is cancelled, not refunded
		}
		m := s.moneyOf(ctx, c)
		if m.Unpaid || m.Price <= 0 || (m.PI == "" && !m.Balance) {
			continue
		}
		if !m.Balance && m.Kind == store.ChargeRun && c.Stripe.RefundedCents >= m.Price {
			continue
		}
		paid := s.runPaidAt(ctx, c, m)
		if now.Sub(paid) > refundRequestWindow {
			continue
		}
		cases, _ := s.Store.ListCasesByConversion(ctx, c.ID, 20)
		open, refunded := caseOpenFor(cases)
		if refunded && open == "" {
			continue
		}
		out = append(out, refundOption{ConversionID: c.ID, Label: s.runLabel(ctx, c), PaidAt: paid, Cents: m.Price, OpenCase: open})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].PaidAt.After(out[j].PaidAt) })
	return out, nil
}

// refundablePlan is the plan's latest invoice when it was paid in the
// window and money is left on it (a cancelled plan too, RF-03).
func (s *Service) refundablePlan(ctx context.Context, uid string, now time.Time) (*planRefundOption, error) {
	cust, err := s.Store.GetCustomer(ctx, uid)
	if errors.Is(err, store.ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if cust.Plan == nil || cust.Plan.LastInvoiceID == "" {
		return nil, nil
	}
	paid, err := s.Stripe.InvoicePaidAt(cust.Plan.LastInvoiceID)
	if err != nil {
		return nil, err
	}
	if paid.IsZero() || now.Sub(paid) > refundRequestWindow {
		return nil, nil
	}
	q, err := s.planRefundQuote(ctx, uid)
	if err != nil {
		return nil, err
	}
	if q.PaidCents <= 0 {
		return nil, nil // refunded already
	}
	cases, _ := s.Store.ListCasesByPI(ctx, q.PI, 20)
	open, refunded := caseOpenFor(cases)
	if refunded && open == "" {
		return nil, nil
	}
	name := tierLabel(cust.Plan.Tier)
	return &planRefundOption{InvoiceID: q.InvoiceID, Tier: cust.Plan.Key(), Name: name, PaidAt: paid, PaidCents: q.PaidCents,
		Cancelled: cust.Plan.CancelAtPeriodEnd || !cust.Plan.Active(now), OpenCase: open}, nil
}

func nilIfNone(id string) any {
	if id == "" {
		return nil
	}
	return id
}

// refusedForDeletion answers for a deleted account, or one waiting for
// its closure case.
func (s *Service) refusedForDeletion(ctx context.Context, w http.ResponseWriter, uid string) bool {
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil {
		return false
	}
	if cust.AccountDeleted {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusForbidden, "account_deleted", "This account was deleted."))
		return true
	}
	if cust.DeletionPending {
		httpx.WriteErr(ctx, w, errDeletionPending())
		return true
	}
	return false
}

// HandleRefundOptions is GET /v1/support/refund-options.
func (s *Service) HandleRefundOptions(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	if s.refusedForDeletion(ctx, w, user.UID) {
		return
	}
	now := time.Now().UTC()
	runs, err := s.refundableRuns(ctx, user.UID, now)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	plan, err := s.refundablePlan(ctx, user.UID, now)
	if err != nil {
		slog.WarnContext(ctx, "refund options: plan not read", "err", err)
		plan = nil // the runs still show
	}
	rows := make([]map[string]any, 0, len(runs))
	for _, o := range runs {
		rows = append(rows, map[string]any{"conversion_id": o.ConversionID, "label": o.Label, "paid_at": o.PaidAt.Format(time.RFC3339),
			"amount_cents": o.Cents, "open_request_id": nilIfNone(o.OpenCase)})
	}
	var planOut any
	if plan != nil {
		planOut = map[string]any{"invoice_id": plan.InvoiceID, "plan": plan.Tier, "name": plan.Name, "paid_at": plan.PaidAt.Format(time.RFC3339),
			"paid_cents": plan.PaidCents, "cancelled": plan.Cancelled, "open_request_id": nilIfNone(plan.OpenCase)}
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, map[string]any{"window_days": int(refundRequestWindow / (24 * time.Hour)), "plan": planOut, "runs": rows})
}

func writeSupportLimited(ctx context.Context, w http.ResponseWriter, wait time.Duration) {
	e := httpx.Err(http.StatusTooManyRequests, "rate_limited", "Too many requests. Try again later.")
	e.Details = map[string]any{"retry_after_s": max(1, int(wait.Seconds()))}
	httpx.WriteErr(ctx, w, e)
}

// HandleRefundRequest is POST /v1/support/refund-requests.
func (s *Service) HandleRefundRequest(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	now := time.Now().UTC()
	var req struct {
		Plan          bool     `json:"plan"`
		ConversionIDs []string `json:"conversion_ids"`
		Text          string   `json:"text"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("body must be a JSON object"))
		return
	}
	text := strings.TrimSpace(req.Text)
	if utf8.RuneCountInString(text) > supportTextMax {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "text_too_long", fmt.Sprintf("Keep it under %d characters.", supportTextMax)))
		return
	}
	ids := []string{}
	for _, id := range req.ConversionIDs {
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	if !req.Plan && len(ids) == 0 {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("pick the plan or the runs to ask about"))
		return
	}
	if len(ids) > 50 {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("at most 50 runs at a time"))
		return
	}
	if s.refusedForDeletion(ctx, w, user.UID) {
		return
	}
	if ip := clientIP(r); ip != "" && !eventAllowed("refund-ip:"+ip, refundRequestsPerIPHour, now) {
		writeSupportLimited(ctx, w, time.Hour)
		return
	}

	// Only what the options list: paid in the window, not refunded.
	runs, err := s.refundableRuns(ctx, user.UID, now)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	byID := map[string]refundOption{}
	for _, o := range runs {
		byID[o.ConversionID] = o
	}
	var plan *planRefundOption
	if req.Plan {
		if plan, err = s.refundablePlan(ctx, user.UID, now); err != nil {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "plan_unavailable", "We couldn't read your plan's payment. Try again in a while."))
			return
		}
	}
	var bad []string
	for _, id := range ids {
		if _, ok := byID[id]; !ok {
			bad = append(bad, id)
		}
	}
	if len(bad) > 0 || (req.Plan && plan == nil) {
		e := httpx.Err(http.StatusBadRequest, "not_refundable", "That can't be asked for: it wasn't paid in the last 30 days, or it's refunded already.")
		e.Details = map[string]any{"conversion_ids": bad, "plan": req.Plan && plan == nil}
		httpx.WriteErr(ctx, w, e)
		return
	}

	// Already asked for: joins that open case.
	merged := map[string]bool{}
	var fresh []string
	for _, id := range ids {
		if o := byID[id]; o.OpenCase != "" {
			merged[o.OpenCase] = true
		} else {
			fresh = append(fresh, id)
		}
	}
	freshPlan := plan != nil && plan.OpenCase == ""
	if plan != nil && plan.OpenCase != "" {
		merged[plan.OpenCase] = true
	}
	if len(fresh) > 0 || freshPlan {
		open := 0
		if cases, err := s.Store.ListUserCases(ctx, user.UID, 200); err == nil {
			for _, cs := range cases {
				if cs.Open && cs.Source == SourceCustomer {
					open++
				}
			}
		}
		if open >= refundRequestsOpenMax {
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusConflict, "too_many_open",
				"You have 10 requests we're still looking at. We'll answer those first."))
			return
		}
	}
	ok, wait, err := s.Store.AllowSupport(ctx, "refund:"+user.UID, refundRequestsPerDay, 24*time.Hour, now)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	if !ok {
		writeSupportLimited(ctx, w, wait)
		return
	}

	out := []map[string]any{}
	note := text
	if note == "" {
		note = "(no note)"
	}
	for id := range merged {
		if err := s.Store.AddCaseEvent(ctx, id, store.CaseEvent{Who: SourceCustomer, Kind: "request_merged", Text: note}); err != nil {
			slog.WarnContext(ctx, "refund request not merged", "case_id", id, "err", err)
		}
		if cs, err := s.Store.GetCase(ctx, id); err == nil {
			out = append(out, requestHead(cs, true))
		}
	}
	if len(fresh) > 0 {
		cases, err := s.requestRefund(ctx, RefundRequest{UID: user.UID, ConversionIDs: fresh, Reason: ReasonSupport,
			Source: SourceCustomer, Who: SourceCustomer, Text: text, ForceManual: true})
		if err != nil {
			slog.WarnContext(ctx, "refund request: case not opened", "err", err)
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "request_failed", "We couldn't send your request. Try again in a while."))
			return
		}
		for _, cs := range cases {
			out = append(out, requestHead(cs, cs.OpenedAt.Before(now)))
		}
	}
	if freshPlan {
		cs, err := s.openPlanRefundCaseFrom(ctx, user.UID, SourceCustomer, SourceCustomer, text)
		if err != nil {
			slog.WarnContext(ctx, "refund request: plan case not opened", "err", err)
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "request_failed", "We couldn't send your request. Try again in a while."))
			return
		}
		out = append(out, requestHead(cs, cs.OpenedAt.Before(now)))
	}
	slog.InfoContext(ctx, "refund requested", "runs", len(ids), "plan", req.Plan, "merged", len(merged), "cases", len(out))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "requests": out})
}

func requestHead(cs *store.Case, merged bool) map[string]any {
	st := requestState(cs)
	return map[string]any{"id": cs.ID, "state": st, "status": requestWords[st], "merged": merged}
}

// requestAbout: what a case is about, for its customer.
func requestAbout(cs *store.Case) string {
	switch {
	case cs.Reason == ReasonPlanRefund || len(cs.Related.InvoiceIDs) > 0:
		return "plan"
	case cs.Type == store.CaseBalanceRefund || cs.Related.TopupID != "":
		return "balance"
	case len(cs.Related.ConversionIDs) > 0:
		return "runs"
	}
	return "other"
}

// requestJSON is a case as its customer sees it.
func (s *Service) requestJSON(ctx context.Context, cs *store.Case) map[string]any {
	st := requestState(cs)
	out := map[string]any{"id": cs.ID, "about": requestAbout(cs), "state": st, "status": requestWords[st],
		"opened_at": cs.OpenedAt.Format(time.RFC3339), "updated_at": cs.LastActivityAt.Format(time.RFC3339),
		"requested_cents": cs.RequestedCents, "refunded_cents": int64(0), "your_note": nilIfNone(cs.CustomerText),
		"conversion_ids": cs.Related.ConversionIDs, "question": nil, "follow_up_of": nilIfNone(cs.FollowUpOf)}
	if out["conversion_ids"] == nil {
		out["conversion_ids"] = []string{}
	}
	if st == requestRefunded {
		out["refunded_cents"] = cs.DecidedCents
	}
	if st == requestAsked {
		if evs, err := s.Store.ListCaseEvents(ctx, cs.ID, 30); err == nil {
			for _, e := range evs { // newest first
				if e.Kind == "customer_message_out" {
					out["question"] = e.Text
					break
				}
			}
		}
	}
	return out
}

// HandleSupportRequests is GET /v1/support/requests.
func (s *Service) HandleSupportRequests(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	cases, err := s.Store.ListUserCases(ctx, user.UID, 100)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	sort.SliceStable(cases, func(i, j int) bool { return cases[i].OpenedAt.After(cases[j].OpenedAt) })
	out := []map[string]any{}
	for _, cs := range cases {
		if cs.CustomerVisible {
			out = append(out, s.requestJSON(ctx, cs))
		}
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, map[string]any{"requests": out})
}

// HandleSupportReply is POST /v1/support/requests/{id}/reply.
func (s *Service) HandleSupportReply(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	var req struct {
		Text string `json:"text"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 32<<10)).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("body must be a JSON object"))
		return
	}
	text := strings.TrimSpace(req.Text)
	if text == "" {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("write your message (text)"))
		return
	}
	if utf8.RuneCountInString(text) > supportTextMax {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadRequest, "text_too_long", fmt.Sprintf("Keep it under %d characters.", supportTextMax)))
		return
	}
	notFound := httpx.Err(http.StatusNotFound, "request_not_found", "We couldn't find that request.")
	cs, err := s.Store.GetCase(ctx, id)
	if err != nil || cs.UID != user.UID || !cs.CustomerVisible {
		httpx.WriteErr(ctx, w, notFound) // another account's case reads as missing
		return
	}
	if !eventAllowed("support-reply:"+user.UID, supportRepliesPerHour, time.Now()) {
		writeSupportLimited(ctx, w, time.Hour)
		return
	}
	target := cs
	if !cs.Open {
		nc, err := s.followUpCase(ctx, cs, text, SourceCustomer)
		if err != nil {
			httpx.WriteErr(ctx, w, httpx.ErrServer())
			return
		}
		target = nc
	} else {
		if err := s.applyCaseAction(ctx, cs, caseActionReq{Action: "customer_reply", Text: text}, SourceCustomer); err != nil {
			httpx.WriteErr(ctx, w, httpx.ErrServer())
			return
		}
		s.noticeOwner(ctx, "O1", cs, fmt.Sprintf("SVS case %s · the customer replied", cs.ID))
	}
	fresh, err := s.Store.GetCase(ctx, target.ID)
	if err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrServer())
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, s.requestJSON(ctx, fresh))
}
