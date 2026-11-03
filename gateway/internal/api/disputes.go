package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Disputes, early fraud warnings (B11, C13, N8) and refund webhooks (C8).

// paymentOwner reads whose payment a PaymentIntent is, from its metadata:
// the account, and the run, group, settle or top-up it paid. ok=false for
// another product's or environment's payment.
type paymentOwner struct {
	UID, ConversionID, BatchID, SettleID, TopupID string
	Facts                                         *stripex.PaymentFacts
}

func (s *Service) ownerOfPI(pi string) (paymentOwner, bool) {
	f, err := s.Stripe.PaymentFactsOf(pi)
	if err != nil || f.Metadata["env"] != s.Cfg.Env || f.Metadata["product"] != "svs-web" {
		return paymentOwner{}, false
	}
	return paymentOwner{UID: f.Metadata["user_id"], ConversionID: f.Metadata["conversion_id"], BatchID: f.Metadata["batch_id"],
		SettleID: f.Metadata["settle_id"], TopupID: f.Metadata["topup_id"], Facts: f}, true
}

// runsOf lists the runs a payment paid.
func (s *Service) runsOf(ctx context.Context, o paymentOwner) []string {
	switch {
	case o.ConversionID != "":
		return []string{o.ConversionID}
	case o.BatchID != "":
		if b, err := s.Store.GetBatch(ctx, o.BatchID); err == nil {
			ids := make([]string, 0, len(b.Items))
			for _, it := range b.Items {
				ids = append(ids, it.ConversionID)
			}
			return ids
		}
	case o.SettleID != "":
		if st, err := s.Store.GetSettle(ctx, o.SettleID); err == nil {
			var ids []string
			for _, it := range st.Items {
				if it.Kind == "run" {
					ids = append(ids, it.ID)
				} else {
					ids = append(ids, it.ConversionIDs...)
				}
			}
			return ids
		}
	}
	return nil
}

func chargeIDOf(o paymentOwner) string {
	switch {
	case o.ConversionID != "":
		return store.ChargeID(store.ChargeRun, o.ConversionID)
	case o.BatchID != "":
		return store.ChargeID(store.ChargeGroup, o.BatchID)
	case o.SettleID != "":
		return store.ChargeID(store.ChargeSettle, o.SettleID)
	case o.TopupID != "":
		return store.ChargeID(store.ChargeTopup, o.TopupID)
	}
	return ""
}

// handleDisputeEvent: charge.dispute.created/updated/closed/funds_*.
func (s *Service) handleDisputeEvent(ctx context.Context, eventType string, raw json.RawMessage) error {
	var d stripex.Dispute
	if json.Unmarshal(raw, &d) != nil || d.ID == "" {
		return nil
	}
	pi := d.PaymentIntent
	if pi == "" && d.Charge != "" {
		pi, _ = s.Stripe.ChargePI(d.Charge)
	}
	o, ok := s.ownerOfPI(pi)
	if !ok || o.UID == "" {
		return nil
	}
	var due *time.Time
	if d.EvidenceDetails.DueBy > 0 {
		t := time.Unix(d.EvidenceDetails.DueBy, 0).UTC()
		due = &t
	}
	info := &store.DisputeInfo{ID: d.ID, Amount: d.Amount, Reason: d.Reason, Status: d.Status, DueBy: due}
	runs := s.runsOf(ctx, o)
	switch eventType {
	case "charge.dispute.created":
		cs, err := s.openCase(ctx, &store.Case{UID: o.UID, Type: store.CaseDispute, Reason: ReasonDispute, Mode: "manual", Source: "stripe_webhook",
			Status: store.CaseOpen, DedupeKey: "dispute:" + d.ID, RequestedCents: d.Amount, Dispute: info, DeadlineAt: due,
			Related: store.CaseRelated{ConversionIDs: runs, PIIDs: []string{pi}, ChargeIDs: nonEmpty(chargeIDOf(o)), DisputeID: d.ID, TopupID: o.TopupID}},
			"system", "dispute opened: "+d.Reason)
		if err != nil {
			return err
		}
		// Every other open case on the charge is superseded (V2).
		if others, lerr := s.Store.ListCasesByPI(ctx, pi, 50); lerr == nil {
			for _, oc := range others {
				if oc.ID == cs.ID || !oc.Open || oc.Type == store.CaseDispute {
					continue
				}
				s.Store.UpdateCase(ctx, oc.ID, "system", func(c *store.Case) error {
					c.Status, c.Result, c.Related.SupersededBy = store.CaseClosed, store.CaseSuperseded, cs.ID
					return nil
				})
				s.Store.AddCaseEvent(ctx, oc.ID, store.CaseEvent{Who: "system", Kind: "superseded", Text: "superseded by dispute " + cs.ID})
			}
		}
		s.setSheetOnly(ctx, o.UID, "dispute "+d.ID)
		s.blockPaymentCard(ctx, o.Facts, "dispute", d.ID, o.UID) // B11: the fingerprint joins the block list
		s.pauseAutoReload(ctx, o.UID, "dispute")
		for _, id := range runs { // B11: the disputed charge's files are locked
			s.setRunDispute(ctx, id, d.ID)
		}
		if o.TopupID != "" { // N8: a dispute on a top-up freezes the balance
			s.Store.BalanceTx(ctx, o.UID, func(b *store.Balance) ([]store.BalanceOp, error) {
				return []store.BalanceOp{{Kind: store.EntryDisputeFreeze, Cents: d.Amount, Ref: d.ID, TopupID: o.TopupID, EntryID: "freeze_" + d.ID}}, nil
			})
		}
		s.noticeOwner(ctx, "O1", cs, fmt.Sprintf("SVS dispute %s · %s · %s · evidence due %s", cs.ID, money(d.Amount), d.Reason, dueDate(due)))
	case "charge.dispute.updated", "charge.dispute.funds_withdrawn", "charge.dispute.funds_reinstated":
		if cs := s.disputeCase(ctx, pi, d.ID); cs != nil {
			s.Store.UpdateCase(ctx, cs.ID, "system", func(c *store.Case) error {
				if c.Dispute == nil {
					c.Dispute = info
				}
				c.Dispute.Status, c.Dispute.DueBy = d.Status, due
				if eventType == "charge.dispute.funds_withdrawn" {
					c.Dispute.FundsOut = true
				}
				if eventType == "charge.dispute.funds_reinstated" {
					c.Dispute.FundsOut = false
				}
				return nil
			})
		}
	case "charge.dispute.closed":
		cs := s.disputeCase(ctx, pi, d.ID)
		outcome := "lost"
		if d.Status == "won" {
			outcome = "won"
		}
		if cs != nil {
			s.Store.UpdateCase(ctx, cs.ID, "system", func(c *store.Case) error {
				if c.Dispute == nil {
					c.Dispute = info
				}
				c.Dispute.Status, c.Dispute.Outcome = d.Status, outcome
				c.Status, c.Result = store.CaseClosed, "dispute_"+outcome
				if outcome == "lost" {
					c.DecidedCents = d.Amount
				}
				return nil
			})
			s.Store.AddCaseEvent(ctx, cs.ID, store.CaseEvent{Who: "system", Kind: "closed", Text: "dispute " + outcome})
		}
		if o.TopupID != "" {
			op := store.EntryDisputeUnfreeze
			if outcome == "lost" {
				op = store.EntryDisputeLoss // no debt: disputed money isn't billed again
			}
			s.Store.BalanceTx(ctx, o.UID, func(b *store.Balance) ([]store.BalanceOp, error) {
				ops := []store.BalanceOp{{Kind: op, Cents: d.Amount, Ref: d.ID, TopupID: o.TopupID, EntryID: op + "_" + d.ID}}
				if op == store.EntryDisputeLoss {
					ops = append(ops, store.BalanceOp{Kind: store.EntryDisputeUnfreeze, Cents: b.FrozenCents, Ref: d.ID, EntryID: "unfreeze_rest_" + d.ID})
				}
				return ops, nil
			})
		}
		if outcome == "won" {
			for _, id := range runs {
				s.setRunDispute(ctx, id, "")
			}
			if !s.otherOpenDispute(ctx, o.UID, d.ID) {
				s.Store.UpdateCustomer(ctx, o.UID, func(c *store.Customer) error {
					if c.SheetOnlyReason == "dispute "+d.ID {
						c.SheetOnly, c.SheetOnlyReason = false, ""
					}
					return nil
				})
			}
		}
	}
	return nil
}

func dueDate(t *time.Time) string {
	if t == nil {
		return "unknown"
	}
	return t.Format("2 Jan")
}

func (s *Service) disputeCase(ctx context.Context, pi, disputeID string) *store.Case {
	cases, err := s.Store.ListCasesByPI(ctx, pi, 50)
	if err != nil {
		return nil
	}
	for _, c := range cases {
		if c.Type == store.CaseDispute && c.Related.DisputeID == disputeID {
			return c
		}
	}
	return nil
}

func (s *Service) otherOpenDispute(ctx context.Context, uid, except string) bool {
	cases, err := s.Store.ListUserCases(ctx, uid, 200)
	if err != nil {
		return true
	}
	for _, c := range cases {
		if c.Type == store.CaseDispute && c.Open && c.Related.DisputeID != except {
			return true
		}
	}
	return false
}

func (s *Service) setRunDispute(ctx context.Context, convID, disputeID string) {
	c, err := s.Store.GetConversion(ctx, convID)
	if err != nil {
		return
	}
	_, _ = s.Store.Transition(ctx, convID, []string{c.State}, func(x *store.Conversion) error {
		x.DisputeID = disputeID
		return nil
	})
}

// pauseAutoReload pauses auto-reload for a risk reason (R2).
func (s *Service) pauseAutoReload(ctx context.Context, uid, reason string) {
	b, err := s.Store.GetBalance(ctx, uid)
	if err != nil || !b.Exists() || !b.AutoReload.Enabled {
		return
	}
	s.Store.BalanceTx(ctx, uid, func(b *store.Balance) ([]store.BalanceOp, error) {
		b.AutoReload.PausedReason = reason
		return []store.BalanceOp{{Kind: store.EntryAdjustment, Note: "auto-reload paused: " + reason}}, nil
	})
}

// handleEFW: radar.early_fraud_warning.created (B11): the account goes
// under review, runs not yet delivered are cancelled as ours (refunded in
// full), finished runs or a top-up get a manual efw case.
func (s *Service) handleEFW(ctx context.Context, raw json.RawMessage) error {
	var w stripex.EFW
	if json.Unmarshal(raw, &w) != nil || w.ID == "" {
		return nil
	}
	pi := w.PaymentIntent
	if pi == "" && w.Charge != "" {
		pi, _ = s.Stripe.ChargePI(w.Charge)
	}
	o, ok := s.ownerOfPI(pi)
	if !ok || o.UID == "" {
		return nil
	}
	s.Store.UpdateCustomer(ctx, o.UID, func(c *store.Customer) error {
		c.UnderReview = true
		return nil
	})
	s.pauseAutoReload(ctx, o.UID, "efw")
	s.blockPaymentCard(ctx, o.Facts, "efw", w.ID, o.UID) // H: the fingerprint joins the block list
	var delivered []string
	for _, id := range s.runsOf(ctx, o) {
		c, err := s.Store.GetConversion(ctx, id)
		if err != nil {
			continue
		}
		if !store.IsTerminal(c.State) {
			if _, cerr := s.cancelRunAsUs(ctx, c, "us"); cerr != nil {
				slog.WarnContext(ctx, "efw: run not stopped", "conversion_id", id, "err", cerr)
			}
			continue
		}
		if c.State == store.StateSucceeded {
			delivered = append(delivered, id)
		}
	}
	if len(delivered) == 0 && o.TopupID == "" {
		return nil
	}
	cs, err := s.openCase(ctx, &store.Case{UID: o.UID, Type: store.CaseEFW, Reason: ReasonEFW, Mode: "manual", Source: "stripe_webhook",
		Status: store.CaseOpen, DedupeKey: "efw:" + w.ID, RequestedCents: o.Facts.Received - o.Facts.Refunded,
		Related: store.CaseRelated{ConversionIDs: delivered, PIIDs: []string{pi}, ChargeIDs: nonEmpty(chargeIDOf(o)), EFWID: w.ID, TopupID: o.TopupID}},
		"system", "early fraud warning: "+w.FraudType)
	if err != nil && !errors.Is(err, store.ErrAlreadyExists) {
		return err
	}
	_ = cs
	return nil
}

// handleRefundEvent: refund.created/updated/failed. Ours (metadata
// case_id) update their row and case; a Dashboard refund writes a closed
// case and maps to a run only when exactly one run matches (v6.1 W1),
// else an "Assign refund" case.
func (s *Service) handleRefundEvent(ctx context.Context, eventType string, raw json.RawMessage) error {
	var re stripex.RefundResult
	if json.Unmarshal(raw, &re) != nil || re.ID == "" {
		return nil
	}
	if re.Metadata["source"] == "gateway" && re.Metadata["case_id"] != "" {
		row, err := s.Store.RefundRowByReID(ctx, re.ID)
		if err != nil || row == nil {
			return err
		}
		_, _ = s.applyRefundStatus(ctx, row.ID, &re)
		return nil
	}
	if eventType != "refund.created" && eventType != "refund.updated" {
		return nil
	}
	if row, err := s.Store.RefundRowByReID(ctx, re.ID); err != nil || row != nil {
		if row != nil {
			_, _ = s.applyRefundStatus(ctx, row.ID, &re)
		}
		return err
	}
	if re.PaymentIntent == "" {
		return nil
	}
	o, ok := s.ownerOfPI(re.PaymentIntent)
	if !ok || o.UID == "" {
		return nil
	}
	return s.recordDashboardRefund(ctx, o, re)
}

func (s *Service) recordDashboardRefund(ctx context.Context, o paymentOwner, re stripex.RefundResult) error {
	pi, chargeID := re.PaymentIntent, chargeIDOf(o)
	runs := s.runsOf(ctx, o)
	if chargeID == "" {
		chargeID = "pi_" + pi
	}
	var lines []store.ChargeLine
	for _, id := range runs {
		if c, err := s.Store.GetConversion(ctx, id); err == nil {
			lines = append(lines, store.ChargeLine{ConversionID: id, ProjectID: c.ProjectID, AmountCents: c.Quote.AmountCents})
		}
	}
	// W1: exactly one run matches, or the refund stays unassigned.
	match := ""
	if ch, live, err := s.Store.Refundable(ctx, chargeID, pi, -1); err == nil && ch != nil {
		var hits []string
		for id, left := range live.Refundable {
			if left == re.Amount || len(live.Price) == 1 {
				hits = append(hits, id)
			}
		}
		if len(hits) == 1 && (len(live.Price) == 1 || live.Refundable[hits[0]] == re.Amount) {
			match = hits[0]
		}
	} else if len(runs) == 1 {
		match = runs[0]
	}
	if o.TopupID != "" {
		match = "topup_" + o.TopupID // the top-up's one line
	}
	reason, mode, status := ReasonSupport, "manual", store.CaseClosed
	if match == "" {
		reason, status = ReasonUnassigned, store.CaseOpen
	}
	cs, err := s.openCase(ctx, &store.Case{UID: o.UID, Type: store.CaseRefund, Reason: reason, Mode: mode, Source: "dashboard",
		Status: status, Result: store.CaseRefunded, DedupeKey: "dashboard:" + re.ID, RequestedCents: re.Amount, DecidedCents: re.Amount,
		Related: store.CaseRelated{ConversionIDs: runs, PIIDs: []string{pi}, ChargeIDs: []string{chargeID}, TopupID: o.TopupID}},
		"dashboard", "refund made in the Stripe Dashboard")
	if err != nil {
		return err
	}
	items := map[string]int64{match: re.Amount}
	spec := store.ReserveSpec{ChargeID: chargeID, PI: pi, CaseID: cs.ID, UID: o.UID, Items: items, StripeRemainder: -1,
		Source: "dashboard", Status: store.RefundSucceeded,
		Fallback: fallbackCharge(o.UID, "pi", pi, pi, o.Facts.Received, lines)}
	if match == "" {
		spec.Unassigned, spec.Items = true, map[string]int64{store.UnassignedRefund: re.Amount}
	}
	row, err := s.Store.ReserveRefund(ctx, spec)
	if err != nil && !errors.Is(err, store.ErrNothingRefundable) {
		return err
	}
	if row != nil {
		s.Store.UpdateRefundRow(ctx, row.ID, func(r *store.RefundRow) error { r.ReID = re.ID; return nil })
		s.creditNoteFor(ctx, row)
	}
	if o.TopupID != "" {
		// a Dashboard refund of top-up money leaves the balance too
		s.Store.BalanceTx(ctx, o.UID, func(b *store.Balance) ([]store.BalanceOp, error) {
			return []store.BalanceOp{{Kind: store.EntryCashRefund, Cents: min(re.Amount, max(b.Available(), 0)), TopupID: o.TopupID,
				Ref: re.ID, CaseID: cs.ID, EntryID: "cash_" + re.ID}}, nil
		})
	}
	return nil
}
