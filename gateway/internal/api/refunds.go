package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Refunds (spec C8, C12, v6.1, v7 N8). Every refund starts at
// requestRefund: it classifies the reason, reads the policy, writes a case
// and then either calls refund() (auto) or notifies the owner (manual).
// refund() is the only code that asks Stripe for money back: it reserves
// a ledger row in one transaction on the charge document (per-charge
// serialization, pending rows count), then calls the Refunds API with an
// explicit amount under refund_{env}_{pi}_{case}_{k}. Balance runs refund
// to the balance instead.

// Refund reasons (C12).
const (
	ReasonRunFailed     = "run_failed_undelivered"
	ReasonCancel        = "cancel_undelivered"
	ReasonCancelledByUs = "cancelled_by_us"
	ReasonDeletion      = "deletion_undelivered"
	ReasonLate          = "late_or_duplicate"
	ReasonPartial       = "partial_failure"
	ReasonDelivered     = "delivered_run"
	ReasonQuality       = "quality_complaint"
	ReasonSupport       = "support_request"
	ReasonEFW           = "efw"
	ReasonDispute       = "dispute"
	ReasonRefundFailed  = "refund_failed"
	ReasonUnassigned    = "dashboard_unassigned"
	ReasonUnpaid        = "unpaid_run" // waive cases
	ReasonTopupWithdraw = "topup_withdrawal"
	ReasonClosure       = "closure_balance"
)

// refundPolicy is config/refund_policy_{env} (cached 60 s; code
// defaults when absent).
type refundPolicy struct {
	Reasons              map[string]string `firestore:"reasons" json:"reasons"`
	ManualAboveCents     int64             `firestore:"manual_above_cents" json:"manual_above_cents"`
	CapExempt            []string          `firestore:"cap_exempt" json:"cap_exempt"`
	DeadlineBusinessDays int               `firestore:"deadline_business_days" json:"deadline_business_days"`
	ReminderHours        int               `firestore:"reminder_hours" json:"reminder_hours"`
	Timezone             string            `firestore:"timezone" json:"timezone"`
	DisputeAlertPct      float64           `firestore:"dispute_alert_pct" json:"dispute_alert_pct"`
	Notify               struct {
		SlackChannel string   `firestore:"slack_channel" json:"slack_channel"`
		OwnerEmails  []string `firestore:"owner_emails" json:"owner_emails"`
	} `firestore:"notify" json:"notify"`
}

func defaultRefundPolicy() refundPolicy {
	return refundPolicy{
		Reasons: map[string]string{
			ReasonRunFailed: "auto", ReasonCancel: "auto", ReasonCancelledByUs: "auto", ReasonDeletion: "auto", ReasonLate: "auto",
			ReasonPartial: "manual", ReasonDelivered: "manual", ReasonQuality: "manual", ReasonSupport: "manual",
			ReasonEFW: "manual", ReasonDispute: "manual", ReasonRefundFailed: "manual", ReasonUnassigned: "manual",
			ReasonUnpaid: "manual", ReasonTopupWithdraw: "auto", ReasonClosure: "manual", ReasonPlanRefund: "manual",
		},
		ManualAboveCents:     5000,
		CapExempt:            []string{ReasonRunFailed, ReasonCancel, ReasonCancelledByUs, ReasonDeletion, ReasonLate, ReasonTopupWithdraw},
		DeadlineBusinessDays: 2,
		ReminderHours:        48,
		Timezone:             "Asia/Tokyo",
		DisputeAlertPct:      0.0075,
	}
}

var policyCache struct {
	sync.Mutex
	p  refundPolicy
	at time.Time
}

// policy reads the refund policy (defaults filled in for missing keys).
func (s *Service) policy(ctx context.Context) refundPolicy {
	policyCache.Lock()
	defer policyCache.Unlock()
	if time.Since(policyCache.at) < time.Minute && policyCache.p.Reasons != nil {
		return policyCache.p
	}
	p := defaultRefundPolicy()
	if s.Store != nil {
		var loaded refundPolicy
		if err := s.Store.ReadConfig(ctx, "refund_policy_"+s.Cfg.Env, &loaded); err == nil {
			for k, v := range loaded.Reasons {
				if v == "auto" || v == "manual" {
					p.Reasons[k] = v
				}
			}
			if loaded.ManualAboveCents > 0 {
				p.ManualAboveCents = loaded.ManualAboveCents
			}
			if loaded.CapExempt != nil {
				p.CapExempt = loaded.CapExempt
			}
			if loaded.DeadlineBusinessDays > 0 {
				p.DeadlineBusinessDays = loaded.DeadlineBusinessDays
			}
			if loaded.ReminderHours > 0 {
				p.ReminderHours = loaded.ReminderHours
			}
			if loaded.Timezone != "" {
				p.Timezone = loaded.Timezone
			}
			if loaded.DisputeAlertPct > 0 {
				p.DisputeAlertPct = loaded.DisputeAlertPct
			}
			p.Notify = loaded.Notify
		}
	}
	policyCache.p, policyCache.at = p, time.Now()
	return p
}

// modeFor is C12 step 5: the reason's mode; auto over the cap turns
// manual unless the reason is cap-exempt.
func (p refundPolicy) modeFor(reason string, cents int64) string {
	m := p.Reasons[reason]
	if m == "" {
		m = "manual"
	}
	if m == "auto" && cents > p.ManualAboveCents && !contains(p.CapExempt, reason) {
		m = "manual"
	}
	return m
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// customerVisible is C12's column.
func customerVisible(reason string) bool {
	switch reason {
	case ReasonRunFailed, ReasonCancel, ReasonCancelledByUs, ReasonDeletion, ReasonLate, ReasonEFW, ReasonDispute, ReasonUnassigned:
		return false
	}
	return true
}

// deadline adds business days in the policy's time zone (1 for efw and
// refund_failed).
func (p refundPolicy) deadline(reason string, from time.Time) time.Time {
	days := p.DeadlineBusinessDays
	if reason == ReasonEFW || reason == ReasonRefundFailed || p.Reasons[reason] == "auto" {
		days = 1
	}
	loc, err := time.LoadLocation(p.Timezone)
	if err != nil {
		loc = time.UTC
	}
	t := from.In(loc)
	for days > 0 {
		t = t.AddDate(0, 0, 1)
		if t.Weekday() != time.Saturday && t.Weekday() != time.Sunday {
			days--
		}
	}
	return time.Date(t.Year(), t.Month(), t.Day(), 18, 0, 0, 0, loc).UTC()
}

// ------------------------------------------------------- where money is

// runMoney is where a run's money sits: the PaymentIntent and charge
// record that paid it, its price on that charge, or the balance.
type runMoney struct {
	Conv     *store.Conversion
	PI       string
	ChargeID string
	Price    int64
	Balance  bool // paid from the prepaid balance
	Unpaid   bool // owed or not charged yet (waive, C13)
	Kind     string
}

func (s *Service) moneyOf(ctx context.Context, c *store.Conversion) runMoney {
	m := runMoney{Conv: c, Price: c.Quote.AmountCents}
	if rb := c.RunBalance; rb != nil && rb.State == store.HoldSettled {
		m.Balance, m.Price = true, rb.SettledCents
		return m
	}
	switch c.Stripe.PIStatus {
	case store.PIChargeFailed, store.PISettling, store.PIChargePending:
		m.Unpaid = true
		return m
	}
	if c.Stripe.BatchID != "" {
		b, err := s.Store.GetBatch(ctx, c.Stripe.BatchID)
		if err != nil || b.State != store.BatchPaid {
			m.Unpaid = true
			return m
		}
		for _, it := range b.Items {
			if it.ConversionID == c.ID {
				m.Price = it.AmountCents
			}
		}
		m.PI, m.ChargeID, m.Kind = b.PaymentIntentID, store.ChargeID(store.ChargeGroup, b.ID), store.ChargeGroup
		if b.SettleID != "" {
			if st, serr := s.Store.GetSettle(ctx, b.SettleID); serr == nil && st.PaymentIntentID == b.PaymentIntentID {
				m.ChargeID, m.Kind = store.ChargeID(store.ChargeSettle, st.ID), store.ChargeSettle
			}
		}
		return m
	}
	if c.Stripe.SettleID != "" {
		if st, err := s.Store.GetSettle(ctx, c.Stripe.SettleID); err == nil && st.PaymentIntentID == c.Stripe.PaymentIntentID && st.State == store.SettlePaid {
			m.PI, m.ChargeID, m.Kind = st.PaymentIntentID, store.ChargeID(store.ChargeSettle, st.ID), store.ChargeSettle
			return m
		}
	}
	if c.Stripe.PaymentIntentID == "" || c.Stripe.CapturedCents <= 0 {
		m.Unpaid = c.Quote.AmountCents > 0 && c.Stripe.Mode != store.BillingModeFreePreview
		return m
	}
	m.PI, m.ChargeID, m.Kind, m.Price = c.Stripe.PaymentIntentID, store.ChargeID(store.ChargeRun, c.ID), store.ChargeRun, c.Stripe.CapturedCents
	return m
}

// fallbackCharge is the charge record a refund creates when the charge
// has none (runs charged before records, extra payments).
func fallbackCharge(uid, kind, source, pi string, received int64, lines []store.ChargeLine) *store.Charge {
	return &store.Charge{UID: uid, Kind: kind, SourceID: source, PaymentIntentID: pi, AmountCents: received, Currency: "usd",
		PaidAt: time.Now().UTC(), Lines: lines, CreatedAt: time.Now().UTC()}
}

// ----------------------------------------------------- requestRefund

// RefundRequest is one ask for money back.
type RefundRequest struct {
	UID           string
	ConversionIDs []string
	Items         map[string]int64 // optional cents per run (default: all refundable)
	Reason        string           // a hint (quality_complaint, support_request, …) or a system reason
	Source        string           // system | support | stripe_webhook | dashboard | customer_mail
	Who           string
	Text          string
}

// requestRefund is C12: classification in order, a case per payment,
// then refund() for auto or the owner notified for manual.
func (s *Service) requestRefund(ctx context.Context, req RefundRequest) ([]*store.Case, error) {
	pol := s.policy(ctx)
	groups := map[string][]runMoney{} // by PaymentIntent ("" = balance or unpaid)
	var unpaid []runMoney
	var waiting []runMoney
	for _, id := range req.ConversionIDs {
		c, err := s.Store.GetConversion(ctx, id)
		if err != nil || c.UID != req.UID {
			return nil, fmt.Errorf("run %s: not this account's", id)
		}
		// 3: an unfinished run is cancelled as ours first, or waits.
		if !store.IsTerminal(c.State) {
			if cancelable(c, time.Now()) {
				if _, cerr := s.cancelRunAsUs(ctx, c, "us"); cerr != nil {
					return nil, cerr
				}
				continue // the cancel refunds it (cancelled_by_us)
			}
			waiting = append(waiting, runMoney{Conv: c})
			continue
		}
		m := s.moneyOf(ctx, c)
		switch {
		case m.Unpaid:
			unpaid = append(unpaid, m) // 0: no refund possible; a waive
		case m.Balance:
			groups["balance"] = append(groups["balance"], m)
		case m.PI != "":
			groups[m.PI] = append(groups[m.PI], m)
		}
	}
	var out []*store.Case
	if len(waiting) > 0 {
		c, err := s.openCase(ctx, &store.Case{UID: req.UID, Type: store.CaseRefund, Reason: orReason(req.Reason, ReasonSupport), Mode: "manual",
			Source: req.Source, Status: store.CaseWaitingForRun, CustomerVisible: true, Related: relatedOf(waiting), Items: req.Items,
			CustomerText: req.Text}, req.Who, "waiting for the run to finish")
		if err != nil {
			return out, err
		}
		out = append(out, c)
	}
	if len(unpaid) > 0 {
		var cents int64
		for _, m := range unpaid {
			cents += m.Conv.Quote.AmountCents
		}
		c, err := s.openCase(ctx, &store.Case{UID: req.UID, Type: store.CaseWaive, Reason: ReasonUnpaid, Mode: "manual", Source: req.Source,
			Status: store.CaseOpen, CustomerVisible: true, Related: relatedOf(unpaid), RequestedCents: cents, CustomerText: req.Text}, req.Who, req.Text)
		if err != nil {
			return out, err
		}
		out = append(out, c)
	}
	keys := make([]string, 0, len(groups))
	for k := range groups {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, pi := range keys {
		runs := groups[pi]
		// 1: a dispute open on the charge takes over.
		if pi != "balance" {
			if d := s.openDisputeCase(ctx, pi); d != nil {
				s.Store.AddCaseEvent(ctx, d.ID, store.CaseEvent{Who: req.Who, Kind: "request_merged", Text: "refund asked while disputed: " + req.Text})
				out = append(out, d)
				continue
			}
		}
		reason := classifyDelivered(runs, req.Reason)
		var cents int64
		items := map[string]int64{}
		for _, m := range runs {
			c := m.Price
			if v, ok := req.Items[m.Conv.ID]; ok && v < c {
				c = v
			}
			items[m.Conv.ID] = c
			cents += c
		}
		mode := pol.modeFor(reason, cents)
		cs := &store.Case{UID: req.UID, Type: store.CaseRefund, Reason: reason, Mode: mode, Source: req.Source, Status: store.CaseOpen,
			CustomerVisible: customerVisible(reason), Related: relatedOf(runs), RequestedCents: cents, Items: items, CustomerText: req.Text}
		if pi != "balance" {
			cs.Related.PIIDs = []string{pi}
			cs.Related.ChargeIDs = []string{runs[0].ChargeID}
		}
		c, err := s.openCase(ctx, cs, req.Who, req.Text)
		if err != nil {
			return out, err
		}
		out = append(out, c)
		if mode == "auto" {
			if _, err := s.refundCase(ctx, c, items, "system"); err != nil && !errors.Is(err, store.ErrNothingRefundable) {
				slog.WarnContext(ctx, "auto refund failed", "case_id", c.ID, "err", err)
			}
		}
	}
	return out, nil
}

func orReason(r, fallback string) string {
	if r == "" {
		return fallback
	}
	return r
}

// classifyDelivered is C12 step 4: nothing delivered → the cause;
// delivered → the specific hint, else delivered_run.
func classifyDelivered(runs []runMoney, hint string) string {
	delivered := false
	for _, m := range runs {
		if m.Conv.State == store.StateSucceeded {
			delivered = true
		}
	}
	if !delivered {
		switch hint {
		case ReasonCancel, ReasonCancelledByUs, ReasonDeletion, ReasonRunFailed:
			return hint
		}
		return ReasonRunFailed
	}
	switch hint {
	case ReasonPartial, ReasonEFW, ReasonQuality, ReasonSupport:
		return hint
	}
	return ReasonDelivered
}

func relatedOf(runs []runMoney) store.CaseRelated {
	var r store.CaseRelated
	seen := map[string]bool{}
	for _, m := range runs {
		r.ConversionIDs = append(r.ConversionIDs, m.Conv.ID)
		if p := m.Conv.ProjectID; p != "" && !seen[p] {
			seen[p] = true
			r.ProjectIDs = append(r.ProjectIDs, p)
		}
	}
	return r
}

// openCase writes a case (deduped by payment and runs), its first
// evidence, and the notices: O1 + E9 for manual ones.
func (s *Service) openCase(ctx context.Context, c *store.Case, who, text string) (*store.Case, error) {
	pol := s.policy(ctx)
	if c.DedupeKey == "" {
		ids := append([]string(nil), c.Related.ConversionIDs...)
		sort.Strings(ids)
		pi := ""
		if len(c.Related.PIIDs) > 0 {
			pi = c.Related.PIIDs[0]
		}
		if c.Related.TopupID != "" {
			pi = "topup:" + c.Related.TopupID
		}
		c.DedupeKey = pi + ":" + strings.Join(ids, ",")
		if c.Type == store.CaseBalanceRefund {
			c.DedupeKey = "balance:" + c.UID + ":" + c.Reason + ":" + c.Related.TopupID
		}
	}
	if c.CustomerID == "" {
		if cust, err := s.Store.GetCustomer(ctx, c.UID); err == nil {
			c.CustomerID = cust.StripeCustomerID
		}
	}
	if c.Mode == "manual" && c.DeadlineAt == nil && c.Type != store.CaseDispute {
		d := pol.deadline(c.Reason, time.Now())
		c.DeadlineAt = &d
	}
	cs, created, err := s.Store.CreateCase(ctx, c, who, text)
	if err != nil || !created {
		return cs, err
	}
	s.buildEvidence(ctx, cs)
	if cs.Mode == "manual" && cs.Status != store.CaseClosed {
		s.noticeOwner(ctx, "O1", cs, fmt.Sprintf("SVS case %s · %s · %s%s", cs.ID, money(cs.RequestedCents),
			strings.ReplaceAll(cs.Reason, "_", " "), dueText(cs.DeadlineAt)))
		if cs.CustomerVisible && cs.Type != store.CaseWaive {
			s.mailRefundUnderReview(ctx, cs)
		}
	}
	return cs, nil
}

func dueText(t *time.Time) string {
	if t == nil {
		return ""
	}
	return " · due " + t.In(time.FixedZone("JST", 9*3600)).Format("Mon 15:04")
}

// --------------------------------------------------------------- refund

// refundCase pays a case's refund: per run, to the card (C8) or to the
// balance (N8). It returns the cents that went back.
func (s *Service) refundCase(ctx context.Context, cs *store.Case, items map[string]int64, who string) (int64, error) {
	if len(cs.Related.PIIDs) == 0 {
		return s.refundToBalance(ctx, cs, items, who)
	}
	return s.refund(ctx, cs, cs.Related.PIIDs[0], firstOr(cs.Related.ChargeIDs, ""), items, who)
}

func firstOr(list []string, d string) string {
	if len(list) > 0 {
		return list[0]
	}
	return d
}

// refund is C8 steps 1-5 for one PaymentIntent.
func (s *Service) refund(ctx context.Context, cs *store.Case, pi, chargeID string, items map[string]int64, who string) (int64, error) {
	facts, err := s.Stripe.PaymentFactsOf(pi)
	if err != nil {
		return 0, err
	}
	if facts.ChargeDisputed {
		return 0, fmt.Errorf("a dispute is open on this charge: no refund is possible")
	}
	if chargeID == "" {
		chargeID = "pi_" + pi
	}
	// A charge without a record gets one now, each run at its price on
	// this payment (not the amount asked).
	var lines []store.ChargeLine
	for id, c := range items {
		price := c
		if conv, cerr := s.Store.GetConversion(ctx, id); cerr == nil {
			if m := s.moneyOf(ctx, conv); m.PI == pi && m.Price > 0 {
				price = m.Price
			}
		} else if id == "payment" {
			price = facts.Received
		}
		lines = append(lines, store.ChargeLine{ConversionID: id, AmountCents: price})
	}
	row, err := s.Store.ReserveRefund(ctx, store.ReserveSpec{ChargeID: chargeID, PI: pi, CaseID: cs.ID, Items: items, UID: cs.UID,
		StripeRemainder: facts.Received - facts.Refunded, Source: "gateway",
		Fallback: fallbackCharge(cs.UID, "pi", pi, pi, facts.Received, lines)})
	if errors.Is(err, store.ErrNothingRefundable) {
		s.closeCase(ctx, cs.ID, who, store.CaseDuplicate, "already covered")
		return 0, err
	}
	if err != nil {
		return 0, err
	}
	s.Store.UpdateCase(ctx, cs.ID, who, func(c *store.Case) error {
		c.Status, c.RefundIDs = store.CaseRefundPending, append(c.RefundIDs, row.ID)
		if c.DecidedAt == nil {
			now := time.Now().UTC()
			c.DecidedAt = &now
		}
		return nil
	})
	re, rerr := s.Stripe.RefundAmount(pi, row.TotalCents, fmt.Sprintf("refund_%s_%s_%s_%d", s.Cfg.Env, pi, cs.ID, row.K),
		map[string]string{"source": "gateway", "case_id": cs.ID, "items": itemsMeta(row.Items)})
	if rerr != nil {
		if f := stripex.ClassifyChargeError(rerr); f.Transient {
			return 0, rerr // the row stays pending; the refund sweep replays the key
		}
		s.Store.UpdateRefundRow(ctx, row.ID, func(r *store.RefundRow) error {
			r.Status, r.FailReason = store.RefundFailed, stripex.ErrMessage(rerr)
			return nil
		})
		s.refundFailed(ctx, cs.ID, row, stripex.ErrMessage(rerr))
		return 0, rerr
	}
	return s.applyRefundStatus(ctx, row.ID, re)
}

func itemsMeta(items map[string]int64) string {
	ids := make([]string, 0, len(items))
	for id := range items {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	parts := make([]string, 0, len(ids))
	for _, id := range ids {
		parts = append(parts, fmt.Sprintf("%s:%d", id, items[id]))
	}
	out := strings.Join(parts, ",")
	if len(out) > 480 {
		out = out[:480]
	}
	return out
}

// applyRefundStatus folds a Stripe refund's status into its row and case
// (C8 step 5): succeeded → refunded, E6, credit note, closed; failed or
// canceled → the case goes back to decided (O5), or a new linked case
// after closing (V3).
func (s *Service) applyRefundStatus(ctx context.Context, rowID string, re *stripex.RefundResult) (int64, error) {
	var prev string
	row, err := s.Store.UpdateRefundRow(ctx, rowID, func(r *store.RefundRow) error {
		prev = r.Status
		r.ReID = re.ID
		switch re.Status {
		case "succeeded":
			r.Status = store.RefundSucceeded
		case "failed", "canceled":
			r.Status, r.FailReason = re.Status, re.FailureReason
		default:
			r.Status = store.RefundPending
		}
		return nil
	})
	if err != nil {
		return 0, err
	}
	switch row.Status {
	case store.RefundSucceeded:
		if prev == store.RefundSucceeded {
			return row.TotalCents, nil
		}
		s.Slack.Alert(ctx, "refund", fmt.Sprintf("Refund %s · %s", money(row.TotalCents), row.CaseID))
		s.creditNoteFor(ctx, row)
		cs, err := s.Store.GetCase(ctx, row.CaseID)
		if err == nil && cs.Status != store.CaseClosed {
			s.Store.UpdateCase(ctx, cs.ID, "system", func(c *store.Case) error {
				c.DecidedCents += row.TotalCents
				c.Status, c.Result = store.CaseClosed, store.CaseRefunded
				return nil
			})
			s.Store.AddCaseEvent(ctx, cs.ID, store.CaseEvent{Who: "system", Kind: "refund_executed", Text: money(row.TotalCents),
				Data: map[string]any{"re_id": re.ID, "items": row.Items}})
			s.mailRefunded(ctx, cs, row.TotalCents, "card")
		}
		return row.TotalCents, nil
	case store.RefundFailed, store.RefundCanceled:
		if prev != row.Status {
			s.refundFailed(ctx, row.CaseID, row, re.FailureReason)
		}
		return 0, fmt.Errorf("refund %s", row.Status)
	}
	return 0, nil
}

// refundFailed: before closing the case goes back to decided with O5;
// after closing, a new linked refund_failed case opens (O5 + E12).
func (s *Service) refundFailed(ctx context.Context, caseID string, row *store.RefundRow, reason string) {
	cs, err := s.Store.GetCase(ctx, caseID)
	if err != nil {
		return
	}
	s.Store.AddCaseEvent(ctx, caseID, store.CaseEvent{Who: "system", Kind: "refund_failed", Text: reason, Data: map[string]any{"row": row.ID}})
	if cs.Status != store.CaseClosed {
		s.Store.UpdateCase(ctx, caseID, "system", func(c *store.Case) error { c.Status = store.CaseDecided; return nil })
		s.noticeOwner(ctx, "O5", cs, fmt.Sprintf("Refund failed on %s: %s", caseID, reason))
		return
	}
	nc, nerr := s.openCase(ctx, &store.Case{UID: cs.UID, Type: store.CaseRefund, Reason: ReasonRefundFailed, Mode: "manual", Source: "system",
		Status: store.CaseOpen, CustomerVisible: true, RequestedCents: row.TotalCents, Items: row.Items,
		Related: store.CaseRelated{ConversionIDs: cs.Related.ConversionIDs, PIIDs: cs.Related.PIIDs, ChargeIDs: cs.Related.ChargeIDs,
			LinkedCaseIDs: []string{cs.ID}}, DedupeKey: "refund_failed:" + row.ID}, "system", reason)
	if nerr == nil {
		s.noticeOwner(ctx, "O5", nc, fmt.Sprintf("Refund failed on %s: %s, new case %s", cs.ID, reason, nc.ID))
		s.mailRefundFailed(ctx, nc, row.TotalCents)
	}
}

// creditNoteFor credits a refund on an invoiced charge (C8 step 4); an
// uninvoiced charge gets it from the invoice job later (C6 step 5).
func (s *Service) creditNoteFor(ctx context.Context, row *store.RefundRow) {
	ch, err := s.Store.GetCharge(ctx, row.ChargeID)
	if err != nil || ch.InvoiceState != store.InvoiceDone || ch.InvoiceID == "" {
		return
	}
	if err := s.creditRefunds(ctx, ch, ch.InvoiceID); err != nil {
		slog.WarnContext(ctx, "credit note failed", "charge_id", ch.ID, "err", err)
	}
}

// refundToBalance is N8: a balance run's refund is a refund_to_balance
// per run, capped by what it settled minus what went back already, the
// FIFO items it used restored.
func (s *Service) refundToBalance(ctx context.Context, cs *store.Case, items map[string]int64, who string) (int64, error) {
	var total int64
	for _, id := range cs.Related.ConversionIDs {
		want, ok := items[id]
		if !ok || want <= 0 {
			continue
		}
		c, err := s.Store.GetConversion(ctx, id)
		if err != nil || c.RunBalance == nil || c.RunBalance.State != store.HoldSettled {
			continue
		}
		back, _ := s.Store.RefundedToBalance(ctx, c.UID, id)
		amount := min(want, c.RunBalance.SettledCents-back)
		if amount <= 0 {
			continue
		}
		_, fx, err := s.Store.BalanceTx(ctx, c.UID, func(b *store.Balance) ([]store.BalanceOp, error) {
			return []store.BalanceOp{{Kind: store.EntryRefundToBalance, Cents: amount, ConversionID: id, CaseID: cs.ID,
				Restore: c.RunBalance.FifoUsed, EntryID: fmt.Sprintf("rtb_%s_%s", cs.ID, id)}}, nil
		})
		if err != nil {
			return total, err
		}
		s.handleBalanceEffects(ctx, c.UID, fx)
		total += amount
	}
	if total == 0 {
		s.closeCase(ctx, cs.ID, who, store.CaseDuplicate, "already covered")
		return 0, store.ErrNothingRefundable
	}
	s.Store.UpdateCase(ctx, cs.ID, who, func(c *store.Case) error {
		c.DecidedCents += total
		c.Status, c.Result = store.CaseClosed, store.CaseRefunded
		return nil
	})
	s.Store.AddCaseEvent(ctx, cs.ID, store.CaseEvent{Who: who, Kind: "refund_executed", Text: money(total) + " to the balance"})
	s.mailRefunded(ctx, cs, total, "balance")
	return total, nil
}

// closeCase ends a case with a result (refunded, denied, duplicate, …).
func (s *Service) closeCase(ctx context.Context, id, who, result, text string) {
	s.Store.UpdateCase(ctx, id, who, func(c *store.Case) error {
		c.Status, c.Result = store.CaseClosed, result
		return nil
	})
	if text != "" {
		s.Store.AddCaseEvent(ctx, id, store.CaseEvent{Who: who, Kind: "closed", Text: text})
	}
}

// openDisputeCase is the open dispute case on a PaymentIntent, if any.
func (s *Service) openDisputeCase(ctx context.Context, pi string) *store.Case {
	cases, err := s.Store.ListCasesByPI(ctx, pi, 50)
	if err != nil {
		return nil
	}
	for _, c := range cases {
		if c.Type == store.CaseDispute && c.Open {
			return c
		}
	}
	return nil
}

// ------------------------------------------- refunds the system makes

// refundExtraPayment is the late_or_duplicate (or deletion) refund of a
// whole payment that no run needs (E0-2): an auto case, the ledger, the
// Refunds API. A PaymentIntent that never succeeded is cancelled instead.
func (s *Service) refundExtraPayment(ctx context.Context, uid, pi string, amount int64, reason, why string, related store.CaseRelated) {
	facts, err := s.Stripe.PaymentFactsOf(pi)
	if err != nil || facts.Received <= 0 {
		if _, _, cerr := s.Stripe.RefundOrCancel(pi); cerr != nil {
			s.Slack.Alert(ctx, "late_refund_failed", fmt.Sprintf("%s (%s): %v %v", pi, why, err, cerr))
		}
		return
	}
	related.PIIDs = []string{pi}
	related.ChargeIDs = []string{"pi_" + pi}
	key := "late:" + pi
	cs, err := s.openCase(ctx, &store.Case{UID: uid, Type: store.CaseRefund, Reason: reason, Mode: "auto", Source: "system",
		Status: store.CaseOpen, Related: related, RequestedCents: facts.Received, DedupeKey: key,
		Items: map[string]int64{"payment": facts.Received}}, "system", why)
	if err != nil {
		s.Slack.Alert(ctx, "late_refund_failed", fmt.Sprintf("%s (%s): case: %v", pi, why, err))
		return
	}
	got, err := s.refund(ctx, cs, pi, "pi_"+pi, map[string]int64{"payment": facts.Received}, "system")
	slog.WarnContext(ctx, "extra payment refunded", "case_id", cs.ID, "uid", uid, "payment_intent", pi, "cents", got, "why", why, "err", err)
}

// recordAutoRefund records an E0-6 refund the run's own path made (a
// failed or cancelled pre-charged run): a closed auto case and a
// succeeded ledger row, so later cases see it.
func (s *Service) recordAutoRefund(ctx context.Context, c *store.Conversion, cents int64) {
	if cents <= 0 || c.Stripe.PaymentIntentID == "" || s.Store == nil {
		return
	}
	reason := ReasonRunFailed
	switch {
	case c.State == store.StateCanceled && c.CanceledBy == "us":
		reason = ReasonCancelledByUs
	case c.State == store.StateCanceled && c.CanceledBy == "deletion":
		reason = ReasonDeletion
	case c.State == store.StateCanceled:
		reason = ReasonCancel
	}
	pi := c.Stripe.PaymentIntentID
	chargeID := store.ChargeID(store.ChargeRun, c.ID)
	cs, err := s.openCase(ctx, &store.Case{UID: c.UID, Type: store.CaseRefund, Reason: reason, Mode: "auto", Source: "system",
		Status: store.CaseOpen, RequestedCents: cents, Items: map[string]int64{c.ID: cents},
		Related: store.CaseRelated{ConversionIDs: []string{c.ID}, ProjectIDs: nonEmpty(c.ProjectID), PIIDs: []string{pi}, ChargeIDs: []string{chargeID}}},
		"system", "refunded in full: the run delivered nothing")
	if err != nil {
		return
	}
	row, err := s.Store.ReserveRefund(ctx, store.ReserveSpec{ChargeID: chargeID, PI: pi, CaseID: cs.ID, UID: c.UID,
		Items: map[string]int64{c.ID: cents}, StripeRemainder: -1, Source: "gateway", Status: store.RefundSucceeded,
		Fallback: fallbackCharge(c.UID, store.ChargeRun, c.ID, pi, cents, []store.ChargeLine{{ConversionID: c.ID, ProjectID: c.ProjectID, AmountCents: cents}})})
	if err == nil {
		s.Store.UpdateCase(ctx, cs.ID, "system", func(x *store.Case) error {
			x.RefundIDs, x.DecidedCents, x.Status, x.Result = append(x.RefundIDs, row.ID), cents, store.CaseClosed, store.CaseRefunded
			x.Decision = &store.CaseDecision{Kind: "auto", By: "system", At: time.Now().UTC(), Items: row.Items}
			return nil
		})
	}
	s.Slack.Alert(ctx, "auto_refund", fmt.Sprintf("Auto refund %s · %s · %s", money(cents), cs.ID, strings.ReplaceAll(reason, "_", " ")))
	s.mailRefunded(ctx, cs, cents, "card")
}

func nonEmpty(v string) []string {
	if v == "" {
		return nil
	}
	return []string{v}
}

// cancelRunAsUs stops a run as our cancel (an admin's Stop run, an early
// fraud warning, a refund asked in line): it is refunded in full by the
// run's own path (cancelled_by_us).
func (s *Service) cancelRunAsUs(ctx context.Context, c *store.Conversion, by string) (*store.Conversion, error) {
	updated, err := s.Store.Transition(ctx, c.ID, store.ActiveStates, func(x *store.Conversion) error {
		x.State, x.CanceledBy = store.StateCanceled, by
		x.Stripe.PIStatus = store.PICancelPending
		return nil
	})
	if errors.Is(err, store.ErrStateConflict) {
		return s.Store.GetConversion(ctx, c.ID)
	}
	if err != nil {
		return nil, err
	}
	if client := s.modalFor(updated); updated.Modal.JobID != "" && client != nil {
		_ = client.CancelJob(ctx, updated.Modal.JobID)
	}
	return s.releaseHold(ctx, updated)
}
