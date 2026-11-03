package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http/httptest"
	"sort"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v78"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Nightly reconciliation, Stripe ↔ Firestore (spec M3). It proves the E0
// invariants held:
//
//	no_record          a succeeded PaymentIntent with no run, group, settle or top-up (flag 1) → refunded (late_or_duplicate)
//	not_current        a succeeded PaymentIntent that isn't its record's current one, or a record not marked paid → replayed through the webhook path (E0-2: adopt or refund)
//	double_paid        more than one succeeded PaymentIntent per run, group, settle or top-up (flag 2)
//	no_invoice         a final charge with no invoice after 1 h (flag 3)
//	invoice_mismatch   an invoice whose total isn't the amount received (flag 4, E0-5)
//	open_invoice       an open invoice of ours with no payment after 1 h (flag 5)
//	refund_no_record   a Stripe refund with no ledger row (flag 6)
//	invoice_overpaid   any invoice.overpaid (flag 7)
//	run_past_expiry    a run in created or charging past its expiry (flag 8)
//	balance_mismatch   balance ≠ Σ ledger entries, or held ≠ Σ holds (v7)
//	topup_entries      a paid top-up without exactly one topup entry (v7)
//	leaked_hold        an open hold on a terminal run (v7, R3; the sweep fixes it)
//	plan_entitlement_missing  an active web plan whose RevenueCat entitlement isn't active → granted again
//
// Flags 1 and 2 go through E0-2; C8 reads amount_refunded first, so money
// already refunded is never refunded twice [N9]. Everything else goes to
// Slack. The report goes to Slack and to reconcile_reports_{env}/{date},
// which the KPI stack reads. It also deletes download-log rows past 13
// months (M8). It runs once a day from the minute reconciler (after 18:00
// UTC, 03:00 JST), and on demand from svs-admin or the admin API.

// M3Flag is one finding.
type M3Flag struct {
	Flag   string `json:"flag" firestore:"flag"`
	Ref    string `json:"ref" firestore:"ref"`
	UID    string `json:"uid,omitempty" firestore:"uid,omitempty"`
	Cents  int64  `json:"cents,omitempty" firestore:"cents,omitempty"`
	Detail string `json:"detail,omitempty" firestore:"detail,omitempty"`
	Action string `json:"action,omitempty" firestore:"action,omitempty"`
}

// M3Report is one run's result.
type M3Report struct {
	ID         string         `json:"id" firestore:"id"`
	Env        string         `json:"env" firestore:"env"`
	Since      time.Time      `json:"since" firestore:"since"`
	At         time.Time      `json:"at" firestore:"at"`
	DryRun     bool           `json:"dry_run" firestore:"dry_run"`
	Searched   int            `json:"payment_intents_searched" firestore:"payment_intents_searched"`
	Counts     map[string]int `json:"counts" firestore:"counts"`
	Flags      []M3Flag       `json:"flags" firestore:"flags"`
	Errors     []string       `json:"errors,omitempty" firestore:"errors,omitempty"`
	Retention  int            `json:"downloads_deleted" firestore:"downloads_deleted"`
	DurationMS int64          `json:"duration_ms" firestore:"duration_ms"`
}

func (r *M3Report) add(f M3Flag) {
	r.Counts[f.Flag]++
	if len(r.Flags) < 500 {
		r.Flags = append(r.Flags, f)
	}
}

func (r *M3Report) fail(what string, err error) {
	r.Errors = append(r.Errors, what+": "+err.Error())
}

// m3Hour: the daily run starts at or after this UTC hour (03:00 JST).
const m3Hour = 18

// maybeNightly runs M3 once a day from the minute reconciler.
func (s *Service) maybeNightly(ctx context.Context) {
	now := time.Now().UTC()
	if now.Hour() < m3Hour {
		return
	}
	ok, err := s.Store.RunOnce(ctx, "m3_"+now.Format("2006-01-02"))
	if err != nil || !ok {
		return
	}
	s.RunM3(ctx, now.Add(-48*time.Hour), false)
}

// RunM3 reconciles PaymentIntents created since `since` and the account's
// standing invariants. dryRun reports without refunding or replaying.
func (s *Service) RunM3(ctx context.Context, since time.Time, dryRun bool) *M3Report {
	start := time.Now().UTC()
	rep := &M3Report{ID: start.Format("2006-01-02T150405Z"), Env: s.Cfg.Env, Since: since.UTC(), At: start, DryRun: dryRun, Counts: map[string]int{}}
	s.m3Payments(ctx, rep, since, dryRun)
	s.m3Invoices(ctx, rep, since)
	s.m3Runs(ctx, rep)
	s.m3Balances(ctx, rep)
	s.m3Plans(ctx, rep, dryRun)
	if !dryRun {
		rep.Retention = s.downloadRetention(ctx)
	}
	rep.DurationMS = time.Since(start).Milliseconds()
	if err := s.Store.SaveReconcileReport(ctx, rep.ID, rep); err != nil {
		slog.WarnContext(ctx, "m3 report not saved", "err", err)
	}
	s.Slack.Alert(ctx, "reconcile_m3", m3Summary(rep))
	slog.InfoContext(ctx, "m3 done", "counts", rep.Counts, "errors", len(rep.Errors), "ms", rep.DurationMS)
	return rep
}

func m3Summary(r *M3Report) string {
	keys := make([]string, 0, len(r.Counts))
	for k := range r.Counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s %d", k, r.Counts[k]))
	}
	head := fmt.Sprintf("M3 reconciliation (%s, since %s): %d PaymentIntents checked", r.Env, r.Since.Format("2 Jan 15:04"), r.Searched)
	if len(parts) == 0 {
		head += ", no flags"
	} else {
		head += ", flags: " + strings.Join(parts, ", ")
	}
	if r.DryRun {
		head += " (dry run)"
	}
	if len(r.Errors) > 0 {
		head += fmt.Sprintf("; %d checks failed: %s", len(r.Errors), strings.Join(r.Errors, "; "))
	}
	for i, f := range r.Flags {
		if i == 10 {
			head += fmt.Sprintf("\n… and %d more", len(r.Flags)-10)
			break
		}
		head += fmt.Sprintf("\n• %s %s %s %s", f.Flag, f.Ref, f.Detail, f.Action)
	}
	return head
}

// payRecord is the record a PaymentIntent's metadata names.
type payRecord struct {
	key     string // conversion:{id} | batch:{id} | settle:{id} | topup:{id}
	exists  bool
	current string // the record's paying PaymentIntent
	paid    bool   // the record is marked paid
	uid     string
}

func (s *Service) recordOf(ctx context.Context, md map[string]string) payRecord {
	switch {
	case md["topup_id"] != "":
		r := payRecord{key: "topup:" + md["topup_id"]}
		if t, err := s.Store.GetTopup(ctx, md["topup_id"]); err == nil {
			r.exists, r.current, r.paid, r.uid = true, t.PaymentIntentID, t.State == store.TopupPaid, t.UID
		}
		return r
	case md["settle_id"] != "":
		r := payRecord{key: "settle:" + md["settle_id"]}
		if st, err := s.Store.GetSettle(ctx, md["settle_id"]); err == nil {
			r.exists, r.current, r.paid, r.uid = true, st.PaymentIntentID, st.State == store.SettlePaid, st.UID
			if r.current == "" && st.CurrentPayment != nil && st.CurrentPayment.Kind == store.PaymentIntentKind {
				r.current = st.CurrentPayment.ID
			}
		}
		return r
	case md["batch_id"] != "":
		r := payRecord{key: "batch:" + md["batch_id"]}
		if b, err := s.Store.GetBatch(ctx, md["batch_id"]); err == nil {
			r.exists, r.current, r.paid, r.uid = true, b.PaymentIntentID, b.State == store.BatchPaid, b.UID
		}
		return r
	case md["conversion_id"] != "":
		r := payRecord{key: "conversion:" + md["conversion_id"]}
		if c, err := s.Store.GetConversion(ctx, md["conversion_id"]); err == nil {
			r.exists, r.current, r.uid = true, c.Stripe.PaymentIntentID, c.UID
			r.paid = c.Stripe.PIStatus == store.PISucceeded || (c.State != store.StateCreated && c.Stripe.CapturedCents > 0)
		}
		return r
	}
	return payRecord{}
}

// replayPaymentEvent runs a succeeded PaymentIntent through the webhook
// path, which adopts or refunds it (E0-2) with conditional writes.
func (s *Service) replayPaymentEvent(ctx context.Context, p stripex.SearchedPI) string {
	raw, _ := json.Marshal(map[string]any{"id": p.ID, "object": "payment_intent", "status": p.Status, "amount": p.Amount,
		"amount_received": p.AmountReceived, "metadata": p.Metadata})
	rec := httptest.NewRecorder()
	s.handlePaymentIntentEvent(ctx, rec, stripe.Event{Type: "payment_intent.succeeded", Data: &stripe.EventData{Raw: raw}})
	if rec.Code >= 300 {
		return fmt.Sprintf("replay failed (%d)", rec.Code)
	}
	return "replayed (E0-2: adopt or refund)"
}

func (s *Service) m3Payments(ctx context.Context, rep *M3Report, since time.Time, dryRun bool) {
	pis, err := s.Stripe.SearchOurPIs(since, 5000, 200*time.Millisecond)
	if err != nil {
		rep.fail("search payment intents", err)
	}
	rep.Searched = len(pis)
	succeeded := map[string][]stripex.SearchedPI{}
	for _, p := range pis {
		if p.Status != "succeeded" || p.AmountReceived <= 0 {
			continue
		}
		facts, ferr := s.Stripe.PaymentFactsOf(p.ID)
		time.Sleep(50 * time.Millisecond)
		if ferr != nil {
			rep.fail("read "+p.ID, ferr)
			continue
		}
		rec := s.recordOf(ctx, p.Metadata)
		fullyRefunded := facts.Refunded >= facts.Received
		if facts.Refunded > 0 {
			s.m3Refunds(ctx, rep, p.ID, rec.uid)
		}
		if rec.key != "" && !fullyRefunded {
			succeeded[rec.key] = append(succeeded[rec.key], p)
		}
		switch {
		case fullyRefunded:
			continue
		case !rec.exists:
			f := M3Flag{Flag: "no_record", Ref: p.ID, UID: p.Metadata["user_id"], Cents: p.AmountReceived - facts.Refunded,
				Detail: "no run, group, settle or top-up " + rec.key}
			if facts.ChargeDisputed {
				f.Action = "disputed: the dispute case decides (no refund while a dispute is open)"
			} else if !dryRun && f.UID != "" {
				s.refundExtraPayment(ctx, f.UID, p.ID, f.Cents, ReasonLate, "payment with no record (M3 flag 1)", store.CaseRelated{})
				f.Action = "refunded (late_or_duplicate)"
			} else if f.UID == "" {
				f.Action = "no user_id on the payment: refund by hand"
			}
			rep.add(f)
		case rec.current != p.ID || !rec.paid:
			f := M3Flag{Flag: "not_current", Ref: p.ID, UID: rec.uid, Cents: p.AmountReceived,
				Detail: fmt.Sprintf("%s current %q paid %v", rec.key, rec.current, rec.paid)}
			if !dryRun {
				f.Action = s.replayPaymentEvent(ctx, p)
			}
			rep.add(f)
		}
	}
	for key, list := range succeeded {
		if len(list) > 1 {
			ids := make([]string, 0, len(list))
			for _, p := range list {
				ids = append(ids, p.ID)
			}
			rep.add(M3Flag{Flag: "double_paid", Ref: key, Detail: strings.Join(ids, ", "), Action: "extras replayed through E0-2 (not_current)"})
		}
	}
}

// m3Refunds flags Stripe refunds the ledger has no row for (flag 6).
func (s *Service) m3Refunds(ctx context.Context, rep *M3Report, pi, uid string) {
	res, err := s.Stripe.ListRefunds(pi)
	if err != nil {
		rep.fail("refunds of "+pi, err)
		return
	}
	for _, re := range res {
		if re.Status == "failed" || re.Status == "canceled" {
			continue
		}
		if row, rerr := s.Store.RefundRowByReID(ctx, re.ID); rerr == nil && row == nil {
			rep.add(M3Flag{Flag: "refund_no_record", Ref: re.ID, UID: uid, Cents: re.Amount, Detail: "on " + pi})
		}
	}
}

func (s *Service) m3Invoices(ctx context.Context, rep *M3Report, since time.Time) {
	now := time.Now().UTC()
	charges, err := s.Store.ListAllCharges(ctx, 20000)
	if err != nil {
		rep.fail("charges", err)
	}
	for _, ch := range charges {
		switch ch.Kind {
		case store.ChargeRun, store.ChargeGroup, store.ChargeSettle, store.ChargeTopup:
		default:
			continue
		}
		if ch.InvoiceState != store.InvoiceDone && ch.InvoiceState != store.InvoiceSkipped && ch.PaidAt.Before(now.Add(-time.Hour)) {
			rep.add(M3Flag{Flag: "no_invoice", Ref: ch.ID, UID: ch.UID, Cents: ch.AmountCents,
				Detail: fmt.Sprintf("invoice_state %q %s", ch.InvoiceState, ch.InvoiceError)})
			continue
		}
		if ch.InvoiceState == store.InvoiceDone && ch.InvoiceID != "" && ch.InvoiceDoneAt != nil && ch.InvoiceDoneAt.After(since) {
			inv, ierr := s.Stripe.GetInvoice(ch.InvoiceID)
			if ierr != nil {
				rep.fail("invoice "+ch.InvoiceID, ierr)
				continue
			}
			if inv.Total != ch.AmountCents {
				rep.add(M3Flag{Flag: "invoice_mismatch", Ref: ch.InvoiceID, UID: ch.UID, Cents: inv.Total,
					Detail: fmt.Sprintf("total %d, received %d (%s)", inv.Total, ch.AmountCents, ch.ID)})
			}
		}
	}
	open, err := s.Stripe.ListOpenInvoices(now.Add(-time.Hour), 200)
	if err != nil {
		rep.fail("open invoices", err)
	}
	for _, inv := range open {
		if inv.Metadata["product"] == "svs-web" && inv.Metadata["env"] == s.Cfg.Env && inv.AmountPaid == 0 {
			rep.add(M3Flag{Flag: "open_invoice", Ref: inv.ID, Cents: inv.Total, Detail: "charge " + inv.Metadata["charge_id"]})
		}
	}
	events, err := s.Stripe.ListEventsSince("invoice.overpaid", since, 500)
	if err != nil {
		rep.fail("invoice.overpaid events", err)
	}
	for _, e := range events {
		md := e.Data.Object.Metadata
		if md["product"] == "svs-web" && md["env"] == s.Cfg.Env {
			rep.add(M3Flag{Flag: "invoice_overpaid", Ref: e.Data.Object.ID, Cents: e.Data.Object.Paid - e.Data.Object.Total, Detail: e.ID})
		}
	}
}

func (s *Service) m3Runs(ctx context.Context, rep *M3Report) {
	now := time.Now().UTC()
	created, err := s.Store.ListByState(ctx, store.StateCreated, 2000)
	if err != nil {
		rep.fail("created runs", err)
	}
	for _, c := range created {
		deadline := c.CreatedAt.Add(createTTL)
		if c.ExpiresAt != nil {
			deadline = *c.ExpiresAt
		}
		if now.After(deadline.Add(10 * time.Minute)) {
			rep.add(M3Flag{Flag: "run_past_expiry", Ref: c.ID, UID: c.UID, Cents: c.Quote.AmountCents,
				Detail: fmt.Sprintf("state %s pi_status %s, expired %s", c.State, c.Stripe.PIStatus, deadline.Format(time.RFC3339))})
		}
	}
	held, err := s.Store.ListOpenHoldRuns(ctx, 2000)
	if err != nil {
		rep.fail("open holds", err)
	}
	for _, c := range held {
		if store.IsTerminal(c.State) {
			rep.add(M3Flag{Flag: "leaked_hold", Ref: c.ID, UID: c.UID, Cents: c.RunBalance.HoldCents,
				Detail: "state " + c.State, Action: "the hold sweep closes it"})
		}
	}
}

func (s *Service) m3Balances(ctx context.Context, rep *M3Report) {
	balances, err := s.Store.ListAllBalances(ctx, 5000)
	if err != nil {
		rep.fail("balances", err)
		return
	}
	paid, err := s.Store.ListTopupsByState(ctx, store.TopupPaid, 20000)
	if err != nil {
		rep.fail("paid top-ups", err)
	}
	paidBy := map[string][]*store.Topup{}
	for _, t := range paid {
		paidBy[t.UID] = append(paidBy[t.UID], t)
	}
	for _, b := range balances {
		sum, n, topups, lerr := s.Store.LedgerFacts(ctx, b.UID)
		if lerr != nil {
			rep.fail("ledger of "+b.UID, lerr)
			continue
		}
		if sum != b.BalanceCents {
			rep.add(M3Flag{Flag: "balance_mismatch", Ref: b.UID, UID: b.UID, Cents: b.BalanceCents - sum,
				Detail: fmt.Sprintf("balance %d, entries sum %d over %d entries", b.BalanceCents, sum, n)})
		}
		var holds int64
		for _, h := range b.Holds {
			holds += h.Cents
		}
		if holds != b.HeldCents {
			rep.add(M3Flag{Flag: "balance_mismatch", Ref: b.UID, UID: b.UID, Cents: b.HeldCents - holds,
				Detail: fmt.Sprintf("held %d, holds sum %d", b.HeldCents, holds)})
		}
		for _, t := range paidBy[b.UID] {
			if topups[t.ID] != 1 {
				rep.add(M3Flag{Flag: "topup_entries", Ref: t.ID, UID: b.UID, Cents: t.PaidCents,
					Detail: fmt.Sprintf("%d topup entries (want 1) for %s", topups[t.ID], t.PaymentIntentID)})
			}
		}
	}
}
