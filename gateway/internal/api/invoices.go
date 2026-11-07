package api

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Invoices (spec v6 C6, S3D-58): one per PaymentIntent that is final — a
// paid after-done group, a paid-at-start run that succeeded, a paid
// settle. Each is a charge record (charges_{env}/{kind}_{id}) written
// when the money is final; the reconciler's invoice job turns it into a
// Stripe invoice after the fact (items, finalize without collecting,
// attach_payment) and credits refunds made before the invoice existed.
// Keyed, leased and resumable; a voided invoice starts over with n+1.

const (
	invoiceLease      = 2 * time.Minute
	invoiceSweepLimit = 20
	invoiceMaxTries   = 8
)

// --------------------------------------------------------------- records

// recordRunCharge records a web run paid on its own (pre-charge, sheet,
// China, legacy per-run charge, a settle item found paid alone) once it
// has succeeded and the money is final.
func (s *Service) recordRunCharge(ctx context.Context, conv *store.Conversion) {
	if s.Store == nil || conv == nil || conv.ProjectID == "" || conv.Stripe.BatchID != "" ||
		conv.Stripe.PaymentIntentID == "" || conv.Stripe.CapturedCents <= 0 || conv.State != store.StateSucceeded {
		return
	}
	if conv.Stripe.SettleID != "" && conv.Stripe.PIStatus == store.PISucceeded {
		if st, err := s.Store.GetSettle(ctx, conv.Stripe.SettleID); err == nil && st.PaymentIntentID == conv.Stripe.PaymentIntentID {
			return // the settle's invoice lists it
		}
	}
	paidAt := time.Now().UTC()
	if conv.Stripe.CapturedAt != nil {
		paidAt = *conv.Stripe.CapturedAt
	}
	s.writeCharge(ctx, &store.Charge{
		UID: conv.UID, Kind: store.ChargeRun, SourceID: conv.ID, CustomerID: conv.Stripe.CustomerID,
		PaymentIntentID: conv.Stripe.PaymentIntentID, AmountCents: conv.Stripe.CapturedCents,
		Currency: orUSD(conv.Quote.Currency), PaidAt: paidAt,
		Lines: []store.ChargeLine{{ConversionID: conv.ID, ProjectID: conv.ProjectID, AmountCents: conv.Stripe.CapturedCents,
			Description: s.invoiceLineLabel(ctx, conv)}},
	})
}

// recordGroupCharge records a paid after-done group (not one a settle
// paid: the settle's invoice lists its runs).
func (s *Service) recordGroupCharge(ctx context.Context, b *store.Batch) {
	if s.Store == nil || b == nil || b.State != store.BatchPaid || b.PaymentIntentID == "" || b.ChargedCents <= 0 || b.SettleID != "" {
		return
	}
	cust, _ := s.Store.GetCustomer(ctx, b.UID)
	paidAt := time.Now().UTC()
	if b.ChargedAt != nil {
		paidAt = *b.ChargedAt
	}
	ch := &store.Charge{UID: b.UID, Kind: store.ChargeGroup, SourceID: b.ID, PaymentIntentID: b.PaymentIntentID,
		AmountCents: b.ChargedCents, Currency: orUSD(b.Currency), PaidWith: b.PaidWith, PaidAt: paidAt}
	if cust != nil {
		ch.CustomerID = cust.StripeCustomerID
	}
	for _, it := range b.Items {
		ch.Lines = append(ch.Lines, s.lineFor(ctx, it.ConversionID, it.ProjectID, it.AmountCents, it.Description))
	}
	s.writeCharge(ctx, ch)
}

// recordSettleCharge records a paid settle: one line per run (C11 step 6).
func (s *Service) recordSettleCharge(ctx context.Context, st *store.Settle) {
	if s.Store == nil || st == nil || st.State != store.SettlePaid || st.PaymentIntentID == "" || st.PaidCents <= 0 || st.PaidWith == "balance" {
		return // paid from the balance: its top-ups carry the invoices (T19)
	}
	cust, _ := s.Store.GetCustomer(ctx, st.UID)
	paidAt := time.Now().UTC()
	if st.PaidAt != nil {
		paidAt = *st.PaidAt
	}
	ch := &store.Charge{UID: st.UID, Kind: store.ChargeSettle, SourceID: st.ID, PaymentIntentID: st.PaymentIntentID,
		AmountCents: st.PaidCents, Currency: orUSD(st.Currency), PaidWith: st.PaidWith, PaidAt: paidAt}
	if cust != nil {
		ch.CustomerID = cust.StripeCustomerID
	}
	for _, it := range st.Items {
		if it.Kind == "run" {
			ch.Lines = append(ch.Lines, s.lineFor(ctx, it.ID, "", it.AmountCents, ""))
			continue
		}
		amounts := map[string]int64{}
		if b, err := s.Store.GetBatch(ctx, it.ID); err == nil {
			for _, bi := range b.Items {
				amounts[bi.ConversionID] = bi.AmountCents
			}
		}
		for _, cid := range it.ConversionIDs {
			ch.Lines = append(ch.Lines, s.lineFor(ctx, cid, "", amounts[cid], ""))
		}
	}
	s.writeCharge(ctx, ch)
}

func (s *Service) writeCharge(ctx context.Context, ch *store.Charge) {
	if ch.CustomerID == "" {
		if cust, err := s.Store.GetCustomer(ctx, ch.UID); err == nil {
			ch.CustomerID = cust.StripeCustomerID
		}
	}
	if err := s.Store.RecordCharge(ctx, ch); err != nil && !errors.Is(err, store.ErrAlreadyExists) {
		slog.WarnContext(ctx, "charge not recorded; invoice will be missing", "charge", ch.Kind+"_"+ch.SourceID, "err", err)
		s.Slack.Alert(ctx, "charge_not_recorded", fmt.Sprintf("%s_%s (%s): %v", ch.Kind, ch.SourceID, ch.PaymentIntentID, err))
	}
}

// lineFor is one run's invoice line; amount 0 takes the run's quote.
func (s *Service) lineFor(ctx context.Context, convID, projectID string, amount int64, fallback string) store.ChargeLine {
	line := store.ChargeLine{ConversionID: convID, ProjectID: projectID, AmountCents: amount, Description: fallback}
	if c, err := s.Store.GetConversion(ctx, convID); err == nil {
		line.ProjectID = c.ProjectID
		if line.AmountCents == 0 {
			line.AmountCents = runCardCents(c)
		}
		line.Description = s.invoiceLineLabel(ctx, c)
	}
	if line.Description == "" {
		line.Description = "3D video"
	}
	return line
}

// invoiceLineLabel: "Kyoto walk · Lifelike 3D render · 4K · 60 fps · 3
// min" — the billable minutes, never the exact length (owner 2026-11-04).
func (s *Service) invoiceLineLabel(ctx context.Context, c *store.Conversion) string {
	spec := runSpec(c)
	if spec == "" {
		return s.runLabel(ctx, c)
	}
	parts := []string{}
	if c.ProjectID != "" {
		if p, err := s.Store.GetProject(ctx, c.ProjectID); err == nil && strings.TrimSpace(p.Name) != "" {
			parts = append(parts, strings.TrimSpace(p.Name))
		}
	}
	return strings.Join(append(parts, jobDescription(c), spec), " · ")
}

// piDescription is a web run's payment description, which Stripe prints
// on the receipt: "Lifelike 3D render · 4K · 60 fps · 3 min" (the mobile
// one-shot keeps its description).
func piDescription(c *store.Conversion) string {
	if spec := runSpec(c); spec != "" && c.ProjectID != "" {
		return jobDescription(c) + " · " + spec
	}
	return jobDescription(c)
}

func orUSD(cur string) string {
	if cur == "" {
		return "usd"
	}
	return cur
}

// ------------------------------------------------------------------ job

// invoiceSweep (reconciler): pending charges, and invoicing ones whose
// lease lapsed, run the job. Hourly, the void sweep.
func (s *Service) invoiceSweep(ctx context.Context) (done int) {
	var due []*store.Charge
	for _, state := range []string{store.InvoicePending, store.InvoiceInvoicing} {
		cs, err := s.Store.ListChargesByInvoiceState(ctx, state, invoiceSweepLimit)
		if err != nil {
			slog.WarnContext(ctx, "invoice sweep: list failed", "state", state, "err", err)
			continue
		}
		due = append(due, cs...)
	}
	now := time.Now().UTC()
	for _, ch := range due {
		if ch.InvoiceState == store.InvoiceInvoicing && ch.Lease.Held(now) {
			continue
		}
		if s.runInvoiceJob(ctx, ch.ID) {
			done++
		}
	}
	if now.Minute() == 7 { // hourly
		s.voidSweep(ctx)
	}
	return done
}

// runInvoiceJob claims and runs one charge's invoice job (C6 steps 1–6),
// resuming from the first step not done. It reports whether the invoice
// is done.
func (s *Service) runInvoiceJob(ctx context.Context, chargeID string) bool {
	owner := leaseOwner
	ch, err := s.Store.ClaimInvoiceJob(ctx, chargeID, store.Lease{Owner: owner, Until: time.Now().Add(invoiceLease)})
	if err != nil {
		return false
	}
	log := slog.With("charge_id", ch.ID, "payment_intent", ch.PaymentIntentID)
	fail := func(step string, err error) bool {
		msg := step + ": " + stripex.ErrMessage(err)
		log.WarnContext(ctx, "invoice job step failed", "step", step, "err", err)
		s.Store.UpdateCharge(ctx, ch.ID, func(c *store.Charge) error {
			c.InvoiceTries++
			c.InvoiceError, c.Lease = msg, nil
			if c.InvoiceTries >= invoiceMaxTries {
				c.InvoiceState = store.InvoiceFailed
			}
			return nil
		})
		if ch.InvoiceTries+1 >= invoiceMaxTries {
			s.Slack.Alert(ctx, "invoice_failed", fmt.Sprintf("charge `%s` (%s): %s", ch.ID, ch.PaymentIntentID, msg))
		}
		return false
	}
	stop := func(state, why string) bool {
		s.Store.UpdateCharge(ctx, ch.ID, func(c *store.Charge) error {
			c.InvoiceState, c.InvoiceError, c.Lease = state, why, nil
			return nil
		})
		return false
	}
	if ch.CustomerID == "" {
		return stop(store.InvoiceFailed, "no Stripe customer")
	}
	figures, err := s.Stripe.PaymentFigures(ch.PaymentIntentID)
	if err != nil {
		return fail("read payment", err)
	}
	received, refunded := figures.Received, figures.Refunded
	// Adaptive Pricing: the invoice stays USD and says what the customer
	// paid in their currency (owner 2026-11-07: Stripe's own invoice from
	// Checkout shows only USD too). Kept on the charge for admin.
	if p := presentmentOf(figures.Presentment); p != nil {
		if ch.Presentment == nil {
			if _, perr := s.Store.SetPresentment(ctx, store.PresentCharge, ch.ID, ch.PaymentIntentID, *p); perr != nil {
				log.WarnContext(ctx, "charge presentment not recorded", "err", perr)
			}
		}
		ch.Presentment = p
	}
	tax := s.rates(ctx).TaxInclusive()

	var inv *stripex.Invoice
	if ch.InvoiceID != "" {
		if inv, err = s.Stripe.GetInvoice(ch.InvoiceID); err != nil {
			return fail("read invoice", err)
		}
		if inv.Status == "void" { // [N8] start over under a new key
			ch, err = s.Store.UpdateCharge(ctx, ch.ID, func(c *store.Charge) error {
				c.InvoiceAttempt++
				c.InvoiceID, c.InvoiceNumber, c.HostedInvoiceURL, c.InvoicePDF = "", "", "", ""
				return nil
			})
			if err != nil {
				return fail("restart after void", err)
			}
			inv = nil
		}
	}
	if inv == nil {
		// Refunded runs never get an invoice: refunded in full before one
		// existed → nothing to invoice.
		if refunded >= received {
			log.InfoContext(ctx, "invoice skipped: refunded in full")
			return stop(store.InvoiceSkipped, "refunded in full before invoicing")
		}
		key := fmt.Sprintf("inv_%s_%s_%d", s.Cfg.Env, ch.ID, ch.InvoiceAttempt)
		if inv, err = s.Stripe.CreateInvoice(stripex.InvoiceSpec{CustomerID: ch.CustomerID, ChargeID: ch.ID,
			Currency: ch.Currency, EffectiveAt: ch.PaidAt, Tax: tax, Footer: invoiceFooter(ch), Memo: paidMemo(ch.Presentment, received)}, key); err != nil {
			return fail("create", err)
		}
		// Store invoice_id now.
		if ch, err = s.Store.UpdateCharge(ctx, ch.ID, func(c *store.Charge) error { c.InvoiceID = inv.ID; return nil }); err != nil {
			return fail("store invoice id", err)
		}
	}
	if inv.Status == "draft" {
		have, lerr := s.Stripe.InvoiceLineRuns(inv.ID)
		if lerr != nil {
			return fail("read lines", lerr)
		}
		for _, l := range ch.Lines {
			if have[l.ConversionID] {
				continue
			}
			key := fmt.Sprintf("invitem_%s_%s_%d_%s", s.Cfg.Env, ch.ID, ch.InvoiceAttempt, l.ConversionID)
			if err := s.Stripe.AddInvoiceItem(stripex.InvoiceItem{CustomerID: ch.CustomerID, InvoiceID: inv.ID,
				AmountCents: l.AmountCents, Currency: ch.Currency, Description: l.Description, ConversionID: l.ConversionID, Tax: tax}, key); err != nil {
				return fail("add item", err)
			}
		}
		if inv, err = s.Stripe.GetInvoice(inv.ID); err != nil {
			return fail("read invoice", err)
		}
		// Step 3: the invoice must say what was taken.
		if inv.Total != received {
			s.Slack.Alert(ctx, "invoice_total_mismatch", fmt.Sprintf("charge `%s`: invoice %s total %d, payment %d — left as a draft",
				ch.ID, inv.ID, inv.Total, received))
			return stop(store.InvoiceFailed, fmt.Sprintf("total %d != received %d", inv.Total, received))
		}
		fin, ferr := s.Stripe.FinalizeInvoice(inv.ID)
		if ferr != nil && inv.AutomaticTax.Enabled {
			// Tax location failure: finalize without tax, alert, fix by hand.
			s.Slack.Alert(ctx, "invoice_tax_failed", fmt.Sprintf("charge `%s` invoice %s: %s — finalized without tax", ch.ID, inv.ID, stripex.ErrMessage(ferr)))
			if derr := s.Stripe.DisableInvoiceTax(inv.ID); derr != nil {
				return fail("disable tax", derr)
			}
			fin, ferr = s.Stripe.FinalizeInvoice(inv.ID)
		}
		if ferr != nil {
			return fail("finalize", ferr)
		}
		inv = fin
	}
	if inv.Status == "open" {
		if inv, err = s.Stripe.AttachPayment(inv.ID, ch.PaymentIntentID); err != nil {
			return fail("attach payment", err)
		}
	}
	if inv.Status != "paid" {
		if inv, err = s.Stripe.GetInvoice(inv.ID); err != nil || inv.Status != "paid" {
			return fail("paid check", fmt.Errorf("invoice %s is %s", ch.InvoiceID, invStatus(inv)))
		}
	}
	// Step 5: credit refunds made before the invoice existed [N7].
	if refunded > 0 {
		if err := s.creditRefunds(ctx, ch, inv.ID); err != nil {
			return fail("credit refunds", err)
		}
	}
	now := time.Now().UTC()
	s.Store.UpdateCharge(ctx, ch.ID, func(c *store.Charge) error {
		c.InvoiceState, c.InvoiceNumber, c.HostedInvoiceURL, c.InvoicePDF = store.InvoiceDone, inv.Number, inv.HostedInvoiceURL, inv.InvoicePDF
		c.InvoiceError, c.Lease, c.InvoiceDoneAt = "", nil, &now
		return nil
	})
	log.InfoContext(ctx, "invoice done", "invoice", inv.ID, "number", inv.Number)
	return true
}

func invoiceFooter(ch *store.Charge) string {
	if ch.Kind == store.ChargeTopup {
		return stripex.TopupInvoiceFooter
	}
	return ""
}

func invStatus(inv *stripex.Invoice) string {
	if inv == nil {
		return "unreadable"
	}
	return inv.Status
}

// creditRefunds gives every succeeded refund on the charge, and every
// out-of-band ledger row, without a credit-note record its credit note,
// and records it (C8 step 4; the same step the invoice job runs, C6 step
// 5). A refund the ledger knows the runs of credits those runs' invoice
// lines; a Dashboard refund with no runs, or an invoice with automatic
// tax (line amounts there are tax-exclusive), gets an amount-only note
// [V11]. A per-line note Stripe refuses falls back to amount-only.
func (s *Service) creditRefunds(ctx context.Context, ch *store.Charge, invoiceID string) error {
	refunds, err := s.Stripe.ListRefunds(ch.PaymentIntentID)
	if err != nil {
		return err
	}
	done := map[string]bool{}
	for _, cn := range ch.CreditNotes {
		done[cn.RefundID] = true
	}
	var lines map[string]stripex.InvoiceLineRef
	perLine := true
	linesOf := func(items map[string]int64, total int64) map[string]int64 {
		if !perLine || len(items) == 0 {
			return nil
		}
		if lines == nil {
			inv, ierr := s.Stripe.GetInvoice(invoiceID)
			if ierr != nil || inv.AutomaticTax.Enabled {
				perLine = false
				return nil
			}
			if lines, ierr = s.Stripe.InvoiceLineIDs(invoiceID); ierr != nil {
				perLine = false
				return nil
			}
		}
		out := map[string]int64{}
		var sum int64
		for id, cents := range items {
			l, ok := lines[id]
			if !ok || cents <= 0 || cents > l.Amount {
				return nil // a run not on this invoice: amount-only
			}
			out[l.ID] += cents
			sum += cents
		}
		if sum != total {
			return nil
		}
		return out
	}
	credit := func(spec stripex.CreditSpec, key string) (*stripex.CreditNote, error) {
		cn, err := s.Stripe.CreateCreditNote(spec, key)
		if err != nil && len(spec.Lines) > 0 && !stripex.ClassifyChargeError(err).Transient {
			slog.WarnContext(ctx, "per-line credit note refused; amount-only", "invoice", spec.InvoiceID, "err", err)
			spec.Lines = nil
			cn, err = s.Stripe.CreateCreditNote(spec, key+"_amount")
		}
		return cn, err
	}
	record := func(ref store.CreditNoteRef, rowID string) error {
		if _, err := s.Store.UpdateCharge(ctx, ch.ID, func(c *store.Charge) error {
			for _, x := range c.CreditNotes {
				if x.RefundID == ref.RefundID {
					return nil
				}
			}
			c.CreditNotes = append(c.CreditNotes, ref)
			return nil
		}); err != nil {
			return err
		}
		if rowID != "" {
			s.Store.UpdateRefundRow(ctx, rowID, func(r *store.RefundRow) error { r.CreditNoteID = ref.CreditNoteID; return nil })
		}
		return nil
	}
	for _, re := range refunds {
		if re.Status != "succeeded" || done[re.ID] {
			continue
		}
		spec := stripex.CreditSpec{InvoiceID: invoiceID, Amount: re.Amount, RefundID: re.ID}
		if p := presentmentOf(re.Presentment()); p != nil {
			spec.Memo = "Refunded " + localAndUSD(p, re.Amount) // the note stays USD, like its invoice
		}
		rowID := ""
		if row, rerr := s.Store.RefundRowByReID(ctx, re.ID); rerr == nil && row != nil {
			spec.Lines, rowID = linesOf(row.Items, re.Amount), row.ID
		}
		cn, err := credit(spec, fmt.Sprintf("cn_%s_%s", s.Cfg.Env, re.ID))
		if err != nil {
			return err
		}
		if err := record(store.CreditNoteRef{RefundID: re.ID, CreditNoteID: cn.ID, Number: cn.Number, AmountCents: cn.Total, PDF: cn.PDF}, rowID); err != nil {
			return err
		}
	}
	// Money returned outside Stripe (V10): out_of_band_amount.
	if rows, rerr := s.Store.ListRefundRows(ctx, ch.PaymentIntentID); rerr == nil {
		for _, row := range rows {
			if row.Status != store.RefundOutOfBand || row.CreditNoteID != "" || done[row.ID] || row.TotalCents <= 0 {
				continue
			}
			spec := stripex.CreditSpec{InvoiceID: invoiceID, Amount: row.TotalCents, OutOfBand: true,
				Lines: linesOf(row.Items, row.TotalCents), Memo: "Refunded outside Stripe"}
			cn, err := credit(spec, fmt.Sprintf("cn_%s_oob_%s", s.Cfg.Env, row.ID))
			if err != nil {
				return err
			}
			if err := record(store.CreditNoteRef{RefundID: row.ID, CreditNoteID: cn.ID, Number: cn.Number, AmountCents: cn.Total, PDF: cn.PDF}, row.ID); err != nil {
				return err
			}
		}
	}
	return nil
}

// voidSweep voids our open invoices with no payment attached after 1 h,
// unless their charge is invoicing under a live lease [N8]. The job
// restarts a voided one under n+1.
func (s *Service) voidSweep(ctx context.Context) {
	open, err := s.Stripe.ListOpenInvoices(time.Now().Add(-time.Hour), 100)
	if err != nil {
		slog.WarnContext(ctx, "void sweep: list failed", "err", err)
		return
	}
	now := time.Now().UTC()
	for _, inv := range open {
		if inv.Metadata["product"] != "svs-web" || inv.Metadata["env"] != s.Cfg.Env || inv.AmountPaid > 0 {
			continue
		}
		if ch, err := s.Store.GetCharge(ctx, inv.Metadata["charge_id"]); err == nil &&
			ch.InvoiceState == store.InvoiceInvoicing && ch.Lease.Held(now) {
			continue
		}
		if err := s.Stripe.VoidInvoice(inv.ID); err != nil {
			slog.WarnContext(ctx, "void sweep: void failed", "invoice", inv.ID, "err", err)
			continue
		}
		slog.InfoContext(ctx, "void sweep: voided an unpaid invoice", "invoice", inv.ID, "charge_id", inv.Metadata["charge_id"])
		if id := inv.Metadata["charge_id"]; id != "" {
			s.Store.UpdateCharge(ctx, id, func(c *store.Charge) error {
				if c.InvoiceID == inv.ID && c.InvoiceState != store.InvoiceInvoicing {
					c.InvoiceState = store.InvoicePending // the job restarts it as n+1
				}
				return nil
			})
		}
	}
}

// handleInvoiceEvent: invoice.finalization_failed and invoice.overpaid on
// our invoices go to Slack; nothing loops (C6).
func (s *Service) handleInvoiceEvent(ctx context.Context, eventType string, inv *stripex.Invoice) {
	if inv == nil || inv.Metadata["product"] != "svs-web" || inv.Metadata["env"] != s.Cfg.Env {
		return
	}
	switch eventType {
	case "invoice.finalization_failed", "invoice.overpaid":
		s.Slack.Alert(ctx, eventType, fmt.Sprintf("invoice %s (charge `%s`)", inv.ID, inv.Metadata["charge_id"]))
	}
}

// ------------------------------------------------------------------ API

// GET /v1/billing/invoices?limit=25&starting_after={invoice_id} →
// {invoices: [{invoice_id, number, created_at, amount_cents, currency,
// pdf_url, hosted_url, credit_notes: [...]}], has_more}. Our invoices
// only (drafts and voided ones left out).
func (s *Service) HandleListInvoices(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	limit := 25
	if v, err := strconv.Atoi(r.URL.Query().Get("limit")); err == nil && v > 0 {
		limit = min(v, 100)
	}
	cust, err := s.Store.GetCustomer(ctx, user.UID)
	if err != nil || cust.StripeCustomerID == "" {
		httpx.WriteOK(w, map[string]any{"invoices": []any{}, "has_more": false})
		return
	}
	invs, more, err := s.Stripe.ListInvoices(cust.StripeCustomerID, limit, r.URL.Query().Get("starting_after"))
	if err != nil {
		httpx.Log(ctx).Warn("invoices list failed", "err", err)
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "stripe_unavailable", "couldn't load your invoices; try again"))
		return
	}
	notes := map[string][]map[string]any{}
	if cns, cerr := s.Stripe.ListCreditNotes(cust.StripeCustomerID); cerr == nil {
		for _, cn := range cns {
			if cn.Status == "void" {
				continue
			}
			notes[cn.Invoice] = append(notes[cn.Invoice], map[string]any{"id": cn.ID, "number": cn.Number,
				"created_at": time.Unix(cn.Created, 0).UTC().Format(time.RFC3339), "amount_cents": cn.Total, "pdf_url": cn.PDF})
		}
	}
	rows := []map[string]any{}
	for _, inv := range invs {
		if inv.Status == "draft" || inv.Status == "void" || inv.Metadata["product"] != "svs-web" {
			continue
		}
		row := map[string]any{"invoice_id": inv.ID, "number": inv.Number, "created_at": time.Unix(inv.Created, 0).UTC().Format(time.RFC3339),
			"amount_cents": inv.Total, "currency": inv.Currency, "pdf_url": inv.InvoicePDF, "hosted_url": inv.HostedInvoiceURL}
		if cn := notes[inv.ID]; len(cn) > 0 {
			row["credit_notes"] = cn
		}
		rows = append(rows, row)
	}
	resp := map[string]any{"invoices": rows, "has_more": more}
	if more && len(invs) > 0 {
		resp["next_starting_after"] = invs[len(invs)-1].ID // the page may hold fewer rows than Stripe returned
	}
	httpx.WriteOK(w, resp)
}
