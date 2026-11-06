package api

import (
	"context"
	"fmt"
	"log/slog"
	"sort"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Cash refunds of the prepaid balance (spec N8, T11), case type
// balance_refund: (a) topup_withdrawal — within 14 days of a top-up, its
// unspent part, auto: what is available now, the rest when holds end;
// (b) closure_balance — on account closure, Σ unspent cash top-ups, manual.
// Plan credit and admin credits are never paid out. Money goes back from
// the newest top-up PaymentIntents first, through the ledger (per-charge
// serialization); a cash_refund entry leaves the balance first and a
// failed refund puts it back.

const withdrawalWindow = 14 * 24 * time.Hour

// requestBalanceRefund opens a balance_refund case; topup_withdrawal pays
// at once (auto).
func (s *Service) requestBalanceRefund(ctx context.Context, uid, reason, topupID, source, who, text string) (*store.Case, error) {
	b, err := s.Store.GetBalance(ctx, uid)
	if err != nil {
		return nil, err
	}
	cs := &store.Case{UID: uid, Type: store.CaseBalanceRefund, Reason: reason, Source: source, Status: store.CaseOpen,
		CustomerVisible: true, CustomerText: text}
	switch reason {
	case ReasonTopupWithdraw:
		t, err := s.Store.GetTopup(ctx, topupID)
		if err != nil || t.UID != uid || t.State != store.TopupPaid {
			return nil, fmt.Errorf("top-up %s isn't a paid top-up of this account", topupID)
		}
		if t.PaidAt == nil || time.Since(*t.PaidAt) > withdrawalWindow {
			return nil, fmt.Errorf("the 14 days to withdraw from this top-up have passed")
		}
		cs.RequestedCents = fifoRemaining(b, topupID)
		cs.Related = store.CaseRelated{TopupID: topupID, PIIDs: []string{t.PaymentIntentID}, ChargeIDs: []string{store.ChargeID(store.ChargeTopup, topupID)}}
	case ReasonClosure:
		cs.RequestedCents = b.CashCents()
	default:
		return nil, fmt.Errorf("unknown balance refund reason %q", reason)
	}
	if cs.RequestedCents <= 0 {
		return nil, fmt.Errorf("nothing unspent to refund")
	}
	// RF-02 (owner 2026-11-06, "no automatic refunds unless customers ask
	// for one, in that case a manual review is needed"): a balance or
	// top-up withdrawal always waits for a person's decision in the
	// console; nothing is paid out here.
	cs.Mode = "manual"
	return s.openCase(ctx, cs, who, text)
}

func fifoRemaining(b *store.Balance, topupID string) int64 {
	var n int64
	for _, it := range b.Fifo {
		if it.TopupID == topupID && !it.PlanCredit {
			n += it.RemainingCents
		}
	}
	return n
}

// cashRefundBalance pays cents of a balance_refund case back to the cards
// that paid the top-ups, newest first. What holds keep reserved waits
// (waiting_for_run) and is paid by the cases sweep when they end.
func (s *Service) cashRefundBalance(ctx context.Context, cs *store.Case, cents int64, who string) error {
	b, err := s.Store.GetBalance(ctx, cs.UID)
	if err != nil {
		return err
	}
	type part struct {
		topupID string
		cents   int64
	}
	var plan []part
	left := min(cents, max0(b.Available()))
	if cs.Related.TopupID != "" {
		plan = append(plan, part{cs.Related.TopupID, min(left, fifoRemaining(b, cs.Related.TopupID))})
	} else {
		items := append([]store.FifoItem(nil), b.Fifo...)
		sort.SliceStable(items, func(i, j int) bool { return items[i].At.After(items[j].At) }) // newest first
		for _, it := range items {
			if left <= 0 {
				break
			}
			if it.PlanCredit || it.TopupID == "" || it.RemainingCents <= 0 {
				continue // never paid out
			}
			c := min(left, it.RemainingCents)
			plan = append(plan, part{it.TopupID, c})
			left -= c
		}
	}
	var paid int64
	for i, p := range plan {
		if p.cents <= 0 {
			continue
		}
		t, err := s.Store.GetTopup(ctx, p.topupID)
		if err != nil || t.PaymentIntentID == "" {
			continue
		}
		entryID := fmt.Sprintf("cash_%s_%s_%d_%d", cs.ID, p.topupID, i, time.Now().UnixNano())
		if _, _, err := s.Store.BalanceTx(ctx, cs.UID, func(x *store.Balance) ([]store.BalanceOp, error) {
			return []store.BalanceOp{{Kind: store.EntryCashRefund, Cents: p.cents, TopupID: p.topupID, Ref: t.PaymentIntentID, CaseID: cs.ID, EntryID: entryID}}, nil
		}); err != nil {
			return err
		}
		chargeID := store.ChargeID(store.ChargeTopup, p.topupID)
		line := "topup_" + p.topupID
		row, err := s.Store.ReserveRefund(ctx, store.ReserveSpec{ChargeID: chargeID, PI: t.PaymentIntentID, CaseID: cs.ID, UID: cs.UID,
			Items: map[string]int64{line: p.cents}, StripeRemainder: -1, Source: "gateway",
			Fallback: fallbackCharge(cs.UID, store.ChargeTopup, p.topupID, t.PaymentIntentID, t.PaidCents, []store.ChargeLine{{ConversionID: line, AmountCents: t.PaidCents}})})
		if err != nil {
			s.restoreCash(ctx, cs, p.topupID, p.cents, "not refundable: "+err.Error())
			continue
		}
		re, rerr := s.Stripe.RefundAmount(t.PaymentIntentID, row.TotalCents, fmt.Sprintf("refund_%s_%s_%s_%d", s.Cfg.Env, t.PaymentIntentID, cs.ID, row.K),
			map[string]string{"source": "gateway", "case_id": cs.ID, "items": itemsMeta(row.Items), "kind": "balance"})
		if rerr != nil {
			if f := stripex.ClassifyChargeError(rerr); f.Transient {
				return rerr // the row stays pending; the sweep replays the key
			}
			s.Store.UpdateRefundRow(ctx, row.ID, func(r *store.RefundRow) error {
				r.Status, r.FailReason = store.RefundFailed, stripex.ErrMessage(rerr)
				return nil
			})
			s.restoreCash(ctx, cs, p.topupID, p.cents, stripex.ErrMessage(rerr))
			s.refundFailed(ctx, cs.ID, row, stripex.ErrMessage(rerr))
			continue
		}
		s.Store.UpdateRefundRow(ctx, row.ID, func(r *store.RefundRow) error {
			r.ReID = re.ID
			if re.Status == "succeeded" {
				r.Status = store.RefundSucceeded
			}
			return nil
		})
		s.Store.UpdateCase(ctx, cs.ID, who, func(c *store.Case) error {
			c.RefundIDs, c.DecidedCents = append(c.RefundIDs, row.ID), c.DecidedCents+row.TotalCents
			return nil
		})
		s.creditNoteFor(ctx, row)
		paid += row.TotalCents
	}
	fresh, err := s.Store.GetCase(ctx, cs.ID)
	if err != nil {
		return err
	}
	if paid > 0 {
		s.Store.AddCaseEvent(ctx, cs.ID, store.CaseEvent{Who: who, Kind: "refund_executed", Text: money(paid) + " back to the card"})
		s.mailRefunded(ctx, fresh, paid, "card")
	}
	if fresh.Status == store.CaseClosed {
		return nil
	}
	if cs.Reason == ReasonTopupWithdraw && fresh.DecidedCents < fresh.RequestedCents {
		// Held funds (R7): wait while a hold still reserves this top-up's
		// money; once holds end, what was spent stays spent.
		if nb, berr := s.Store.GetBalance(ctx, cs.UID); berr == nil && nb.HeldCents > 0 && fifoRemaining(nb, cs.Related.TopupID) > 0 {
			if fresh.Status != store.CaseWaitingForRun {
				s.Store.UpdateCase(ctx, cs.ID, who, func(c *store.Case) error { c.Status = store.CaseWaitingForRun; return nil })
			}
			return nil
		}
	}
	result := store.CaseRefunded
	if fresh.DecidedCents == 0 {
		result = "nothing_left" // the money was spent by the runs it was held for
	}
	s.Store.UpdateCase(ctx, cs.ID, who, func(c *store.Case) error {
		c.Status, c.Result = store.CaseClosed, result
		return nil
	})
	return nil
}

// restoreCash puts a cash refund that didn't go through back in the
// balance (as the same top-up's money).
func (s *Service) restoreCash(ctx context.Context, cs *store.Case, topupID string, cents int64, why string) {
	_, _, err := s.Store.BalanceTx(ctx, cs.UID, func(b *store.Balance) ([]store.BalanceOp, error) {
		return []store.BalanceOp{{Kind: store.EntryRefundToBalance, Cents: cents, CaseID: cs.ID,
			Restore: []store.FifoUse{{TopupID: topupID, Cents: cents}}, EntryID: fmt.Sprintf("restore_%s_%s_%d", cs.ID, topupID, time.Now().UnixNano())}}, nil
	})
	if err != nil {
		s.Slack.Alert(ctx, "balance_restore_failed", fmt.Sprintf("%s: %s not put back (%s): %v", cs.ID, money(cents), why, err))
	}
}

// casesSweep (reconciler): refunds whose Stripe call didn't land are
// replayed under their key; waiting_for_run cases move on once their runs
// end (or their holds do); reminders go out.
func (s *Service) casesSweep(ctx context.Context) map[string]int {
	stats := map[string]int{}
	if rows, err := s.Store.ListRefundRowsByStatus(ctx, store.RefundPending, 100); err == nil {
		for _, r := range rows {
			if r.Source != "gateway" || time.Since(r.UpdatedAt) < 2*time.Minute {
				continue
			}
			re, err := s.Stripe.RefundAmount(r.PI, r.TotalCents, fmt.Sprintf("refund_%s_%s_%s_%d", s.Cfg.Env, r.PI, r.CaseID, r.K),
				map[string]string{"source": "gateway", "case_id": r.CaseID, "items": itemsMeta(r.Items)})
			if err != nil {
				if !stripex.ClassifyChargeError(err).Transient {
					s.Store.UpdateRefundRow(ctx, r.ID, func(x *store.RefundRow) error {
						x.Status, x.FailReason = store.RefundFailed, stripex.ErrMessage(err)
						return nil
					})
					s.refundFailed(ctx, r.CaseID, r, stripex.ErrMessage(err))
				}
				continue
			}
			s.applyRefundStatus(ctx, r.ID, re)
			stats["refunds_replayed"]++
		}
	}
	open, err := s.Store.ListCases(ctx, true, 300)
	if err == nil {
		for _, c := range open {
			if c.Status != store.CaseWaitingForRun {
				continue
			}
			if c.Type == store.CaseBalanceRefund {
				if b, berr := s.Store.GetBalance(ctx, c.UID); berr == nil && (b.Available() > 0 || b.HeldCents == 0) {
					left := c.RequestedCents - c.DecidedCents
					if left > 0 && s.cashRefundBalance(ctx, c, left, "system") == nil {
						stats["withdrawals_finished"]++
					}
				}
				continue
			}
			done := true
			for _, id := range c.Related.ConversionIDs {
				if conv, cerr := s.Store.GetConversion(ctx, id); cerr != nil || !store.IsTerminal(conv.State) {
					done = false
				}
			}
			if !done {
				continue
			}
			// The runs ended: classify again (C12 step 3) under a fresh case.
			s.closeCase(ctx, c.ID, "system", "reclassified", "the run ended; classified again")
			if _, rerr := s.requestRefund(ctx, RefundRequest{UID: c.UID, ConversionIDs: c.Related.ConversionIDs, Items: c.Items,
				Reason: c.Reason, Source: c.Source, Who: "system", Text: c.CustomerText}); rerr != nil {
				slog.WarnContext(ctx, "reclassify failed", "case_id", c.ID, "err", rerr)
			}
			stats["cases_reclassified"]++
		}
	}
	if n := s.caseReminderSweep(ctx); n > 0 {
		stats["case_reminders"] = n
	}
	for k, v := range s.deletionScheduleSweep(ctx) { // the 48-hour wait, due ones
		stats[k] += v
	}
	if n := s.finishPendingDeletions(ctx); n > 0 { // N8 step 3
		stats["deletions_finished"] = n
	}
	if found := s.orphanSweepDue(ctx); found > 0 {
		stats["orphan_subscriptions"] = found // report only
	}
	return stats
}
