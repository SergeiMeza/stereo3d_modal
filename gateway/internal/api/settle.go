package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/stripe/stripe-go/v78"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// Collecting what's owed (spec v6 C10/C11): one settle record, one
// function. collectOutstanding(uid, trigger) scopes every owed item into
// a settle under a lease (one transaction), clears old per-run
// PaymentIntents, freezes the amount and charges it — off-session with
// backups (soft_retry, delete), the default only (ios_settle, today's
// shape), or in the sheet (a Checkout Session).

const (
	settleSheet    = "sheet"
	settleIOS      = "ios_settle"
	settleSoftRety = "soft_retry"
	settleDelete   = "delete"
	// settleWebRetry is the 24 h retry of a failed WEB group (charge-after
	// runs of web projects): the web's charge rules (pmc_web, the web
	// backups), where the app's groups keep soft_retry (D1).
	settleWebRetry = "web_retry"
	// settleOneTap: the customer paid what they owe with one tap (BUX-20):
	// on-session, the default, no sheet.
	settleOneTap = "one_tap"

	iosBankCheckLease = 30 * time.Minute
)

// settleResult is what a trigger gets back.
type settleResult struct {
	Settle         *store.Settle
	Paid           bool
	Nothing        bool // nothing owed
	RequiresAction bool
	ClientSecret   string
	Declined       bool
	Live           bool // an existing live settle was returned
	// Failure: why a declined off-session charge failed (informational:
	// the deletion's retry schedule reads it, D2).
	Failure *stripex.ChargeFailure
}

func settleItemRuns(st *store.Settle) []string {
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

// webSettle: a settle trigger charged under the web's rules (D1): the
// deletion's dues and a web group's retry.
func webSettle(trigger string) bool { return trigger == settleDelete || trigger == settleWebRetry }

// collectOutstanding is C11. opts carry the sheet's device and IP.
func (s *Service) collectOutstanding(ctx context.Context, uid, trigger string, pc payContext) (settleResult, error) {
	if settleHeld(ctx) { // Restore Purchases never collects
		return settleResult{}, errSettleHeld
	}
	now := time.Now().UTC()
	lease := store.Lease{Owner: leaseOwner, Until: now.Add(leaseTTL)}
	st, err := s.Store.OpenSettle(ctx, uid, trigger, lease)
	if errors.Is(err, store.ErrNothingOwed) {
		return settleResult{Nothing: true}, nil
	}
	if errors.Is(err, store.ErrSettleLive) {
		return s.liveSettleResult(ctx, st, trigger, pc)
	}
	if err != nil {
		return settleResult{}, err
	}
	slog.InfoContext(ctx, "settle opened", "settle_id", st.ID, "uid", uid, "trigger", trigger,
		"items", len(st.Items), "amount_cents", st.AmountCents)

	// Step 3: per-run items may still hold a PaymentIntent — cancel each;
	// one that turns out paid is paid on its own and leaves the settle.
	var dropped []string
	for _, it := range st.Items {
		if it.PaymentIntentID == "" {
			continue
		}
		out, cerr := s.Stripe.ClosePaymentIntent(it.PaymentIntentID)
		if cerr != nil {
			return settleResult{Settle: st}, cerr // the lease lapses; the sweep releases it
		}
		if out.Paid && it.Kind == "run" {
			dropped = append(dropped, it.ID)
			s.markRunPaidAlone(ctx, it.ID, out)
		}
	}
	amount := st.AmountCents
	for _, id := range dropped {
		for _, it := range st.Items {
			if it.Kind == "run" && it.ID == id {
				amount -= it.AmountCents
			}
		}
	}
	if len(dropped) > 0 {
		st, err = s.Store.UpdateSettle(ctx, st.ID, func(x *store.Settle) error {
			x.AmountCents = amount
			return nil
		})
		if err != nil {
			return settleResult{}, err
		}
	}
	// Step 4: $0 → the account clears, nothing to pay.
	if amount <= 0 {
		done, ferr := s.Store.FinishSettle(ctx, st.ID, store.SettleOutcome{Paid: true}, dropped)
		return settleResult{Settle: done, Paid: true}, ferr
	}
	switch trigger {
	case settleBalance:
		return s.paySettleFromBalance(ctx, st, dropped)
	case settleSheet:
		return s.openSettleSession(ctx, st, pc)
	case settleOneTap:
		return s.oneTapSettle(ctx, st, dropped, pc)
	case settleIOS:
		return s.chargeSettle(ctx, st, dropped, false)
	default:
		return s.chargeSettle(ctx, st, dropped, true)
	}
}

// markRunPaidAlone records a per-run item whose old PaymentIntent turned
// out paid (C11 step 3): it is paid, outside the settle.
func (s *Service) markRunPaidAlone(ctx context.Context, convID string, out stripex.Outcome) {
	now := time.Now().UTC()
	updated, err := s.Store.Transition(ctx, convID, []string{store.StateSucceeded}, func(c *store.Conversion) error {
		c.Stripe.PIStatus = store.PISucceeded
		c.Stripe.PaymentIntentID = out.PaymentIntentID
		c.Stripe.CapturedCents = out.AmountReceived
		c.Stripe.CapturedAt = &now
		c.Stripe.SettleID = "" // paid on its own, invoiced as a run
		return nil
	})
	if err != nil {
		slog.WarnContext(ctx, "paid run not recorded", "conversion_id", convID, "err", err)
		return
	}
	s.recordRunCharge(ctx, updated)
}

// liveSettleResult answers a trigger that found a live settle (C11 step 1).
func (s *Service) liveSettleResult(ctx context.Context, st *store.Settle, trigger string, pc payContext) (settleResult, error) {
	res := settleResult{Settle: st, Live: true}
	switch trigger {
	case settleOneTap:
		return s.oneTapLiveSettle(ctx, st, pc)
	case settleSheet:
		if cp := st.CurrentPayment; cp != nil && cp.Kind == store.PaymentCheckoutSession && cp.UI == "elements" {
			if out, sess, err := s.Stripe.SessionOutcome(cp.ID); err == nil {
				if sess.Status == "open" {
					return res, nil
				}
				if out.Paid {
					return s.applySettlePayment(ctx, st.ID, *cp, out)
				}
			}
		}
		if st.CurrentPayment == nil || st.CurrentPayment.Kind == store.PaymentCheckoutSession {
			return s.openSettleSession(ctx, st, pc) // replace the closed one (E0-1)
		}
		return res, nil // a bank check in flight on the app (ios_settle)
	case settleIOS:
		if cp := st.CurrentPayment; cp != nil && cp.Kind == store.PaymentIntentKind {
			if pi, err := s.Stripe.GetPaymentIntent(cp.ID); err == nil && pi.Status == stripe.PaymentIntentStatusRequiresAction {
				res.RequiresAction, res.ClientSecret = true, pi.ClientSecret
			}
		}
		return res, nil
	}
	return res, nil // soft_retry skips; delete answers 402 balance_due with it
}

// openSettleSession makes the settle's current payment a Checkout Session
// ("Your last runs", key settle_{env}_{id}_{attempt}); the lease follows
// the session (expiry + 5 min).
func (s *Service) openSettleSession(ctx context.Context, st *store.Settle, pc payContext) (settleResult, error) {
	if s.Cfg.StripePMCWeb == "" {
		return settleResult{Settle: st}, errSheetUnavailable()
	}
	if old := st.CurrentPayment; old != nil {
		out, err := s.closePayment(old)
		if err != nil {
			return settleResult{Settle: st}, err
		}
		if out.Paid || out.Processing {
			return s.applySettlePayment(ctx, st.ID, *old, out)
		}
	}
	cust, err := s.Store.GetCustomer(ctx, st.UID)
	if err != nil {
		return settleResult{Settle: st}, err
	}
	attempt := len(st.Payments) + 1
	sess, err := s.Stripe.CreateWebSession(stripex.SessionSpec{
		CustomerID: cust.StripeCustomerID, PMC: s.Cfg.StripePMCWeb, UI: "elements",
		AmountCents: st.AmountCents, Currency: st.Currency, Label: "Your last runs",
		ReturnURL: s.Cfg.SiteURL + "/pay/return?settle=" + st.ID, NoWeChat: pc.Device != "computer",
		NoKlarna: len(s.rates(ctx).KlarnaMarkets) == 0, SaveMethod: true, SavedOnce: s.savedOnceTypes(cust.StripeCustomerID), ReceiptEmail: cust.Email,
		Description:     fmt.Sprintf("Your last runs (%d)", st.Runs()),
		Metadata:        map[string]string{"kind": "settle", "settle_id": st.ID, "user_id": st.UID, "payment_flow": "settle", "attempt": fmt.Sprint(attempt)},
		IdemKey:         fmt.Sprintf("settle_%s_%s_%d", s.Cfg.Env, st.ID, attempt),
		AdaptivePricing: s.rates(ctx).AdaptivePricingEnabled,
	})
	if err != nil {
		return settleResult{Settle: st}, err
	}
	exp := sess.Expires()
	p := store.Payment{Kind: store.PaymentCheckoutSession, ID: sess.ID, ExpiresAt: &exp, Attempt: attempt, UI: "elements",
		ClientSecret: sess.ClientSecret, CreatedAt: time.Now().UTC(), ClientIP: pc.IP}
	oldID := ""
	if st.CurrentPayment != nil {
		oldID = st.CurrentPayment.ID
	}
	updated, err := s.Store.UpdateSettle(ctx, st.ID, func(x *store.Settle) error {
		cur := ""
		if x.CurrentPayment != nil {
			cur = x.CurrentPayment.ID
		}
		if x.State != store.SettleSettling || cur != oldID {
			return store.ErrStateConflict
		}
		x.CurrentPayment = &p
		x.Payments = append(x.Payments, p)
		x.PaymentState = store.SettleOpen
		x.Lease = &store.Lease{Owner: leaseOwner, Until: exp.Add(runPaymentGrace)}
		return nil
	})
	if err != nil {
		_, _ = s.Stripe.CloseCheckoutSession(sess.ID) // lost the swap: close ours
		fresh, gerr := s.Store.GetSettle(ctx, st.ID)
		if gerr == nil {
			return settleResult{Settle: fresh, Live: true}, nil
		}
		return settleResult{Settle: st}, err
	}
	return settleResult{Settle: updated}, nil
}

// chargeSettle charges a settle off-session: one PaymentIntent for the
// total under settle_{env}_{id}, the default first; backups (C5) only
// when backups (soft_retry, delete). A bank check on ios_settle keeps the
// settle live for 30 min with its client secret.
func (s *Service) chargeSettle(ctx context.Context, st *store.Settle, dropped []string, backups bool) (settleResult, error) {
	cust, err := s.Store.GetCustomer(ctx, st.UID)
	if err != nil {
		return settleResult{Settle: st}, err
	}
	if cust.DefaultPaymentMethod == "" {
		cust = s.refreshCardCache(ctx, st.UID, cust.StripeCustomerID)
	}
	if cust.DefaultPaymentMethod == "" {
		closed, ferr := s.Store.FinishSettle(ctx, st.ID, store.SettleOutcome{}, dropped)
		return settleResult{Settle: closed, Declined: true, Failure: &stripex.ChargeFailure{Code: "no_payment_method"}}, ferr
	}
	params := stripex.Job{Web: true, UID: st.UID, Description: fmt.Sprintf("Your last runs (%d)", st.Runs()),
		ReceiptEmail: cust.Email, Metadata: map[string]string{"settle_id": st.ID, "payment_flow": "settle"}}
	if webSettle(st.Trigger) {
		params.PMC = s.Cfg.StripePMCWeb // B1, web only: a saved Link or PayPal can pay
	}
	// B5 (every trigger, D8): the charge is on the record before it goes
	// out, so a lost answer is found again by the sweep, never charged twice.
	startedAt := time.Now().UTC()
	if _, uerr := s.Store.UpdateSettle(ctx, st.ID, func(x *store.Settle) error {
		if x.State != store.SettleSettling {
			return store.ErrStateConflict
		}
		x.ChargeKey, x.ChargePM, x.ChargeCustomerID, x.ChargeStartedAt = s.Stripe.SettleChargeKey(st.ID), cust.DefaultPaymentMethod,
			cust.StripeCustomerID, &startedAt
		return nil
	}); uerr != nil {
		return settleResult{Settle: st}, uerr // nothing sent: the lease lapses and the sweep releases it
	}
	pi, chErr := s.Stripe.ChargeSettle(cust.StripeCustomerID, cust.DefaultPaymentMethod, st.AmountCents, st.Currency, st.ID, params)
	paidWith := cust.DefaultPaymentMethod
	var fail stripex.ChargeFailure
	switch {
	case chErr != nil:
		fail = stripex.ClassifyChargeError(chErr)
	case pi.Status == stripe.PaymentIntentStatusSucceeded || pi.Status == stripe.PaymentIntentStatusProcessing:
	default:
		fail = stripex.ChargeFailure{PaymentIntentID: pi.ID, Code: string(pi.Status), NeedsAction: pi.Status == stripe.PaymentIntentStatusRequiresAction}
	}
	if fail.Transient {
		return settleResult{Settle: st}, chErr // the lease lapses; the sweep finds what the charge made (B5)
	}
	piID := fail.PaymentIntentID
	switch {
	case webSettle(st.Trigger):
		// stripe-go hands back an empty PaymentIntent with an error: the
		// declined one is the error's, so the backups and the cancel below
		// work on it (web; audit 2026-11-07).
		if chErr == nil {
			piID = pi.ID
		}
	case pi != nil:
		// The app's triggers (ios_settle, soft_retry) keep their shipped
		// behaviour unchanged (owner 2026-11-07): an error leaves piID ""
		// (no backups, no bank-check answer, no cancel).
		piID = pi.ID
	}
	if chErr != nil || fail.NeedsAction || fail.Code != "" {
		if !backups && fail.NeedsAction && piID != "" {
			// ios_settle: the app completes the bank's check; the succeeded
			// webhook settles it. Live for 30 min.
			secret := ""
			if got, gerr := s.Stripe.GetPaymentIntent(piID); gerr == nil {
				secret = got.ClientSecret
			}
			until := time.Now().UTC().Add(iosBankCheckLease)
			p := store.Payment{Kind: store.PaymentIntentKind, ID: piID, ExpiresAt: &until, CreatedAt: time.Now().UTC()}
			updated, uerr := s.Store.UpdateSettle(ctx, st.ID, func(x *store.Settle) error {
				x.CurrentPayment, x.Payments = &p, append(x.Payments, p)
				x.PaymentState = store.SettleOpen
				x.Lease = &store.Lease{Owner: leaseOwner, Until: until}
				return nil
			})
			return settleResult{Settle: updated, RequiresAction: true, ClientSecret: secret}, uerr
		}
		paid := false
		if webSettle(st.Trigger) {
			// Web (D1): a bank check goes on to the backups too, and a charge
			// Stripe refused before making a PaymentIntent (B3) still tries
			// them; a configuration error alerts (B2).
			if fail.Config {
				s.alertConfigError(ctx, "settle "+st.Trigger, st.ID, st.UID, fail) // deletion dues or a web group's retry
			}
			fail.PaymentIntentID = piID
			r := s.webBackups(ctx, cust, fail, func(pm string) (*stripe.PaymentIntent, error) {
				return s.Stripe.ChargeSettleWith(cust.StripeCustomerID, pm, st.AmountCents, st.Currency, st.ID, params)
			})
			if r.Transient {
				return settleResult{Settle: st}, errors.New("settle backup charge: transient")
			}
			piID, fail = r.PIID, r.Fail
			if r.Paid {
				pi, paidWith, paid = r.PI, r.PaidWith, true
			}
		} else if backups && !fail.Stop && !fail.NeedsAction && piID != "" {
			methods, _ := s.Stripe.ListMethods(cust.StripeCustomerID)
			for _, m := range orderMethods(s.usableMethods(ctx, methods), cust.DefaultPaymentMethod, cust.BackupOrder) {
				if m.PaymentMethodID == cust.DefaultPaymentMethod {
					continue
				}
				pi2, err2 := s.Stripe.ConfirmWithMethod(piID, m.PaymentMethodID, 1, false)
				if err2 == nil && (pi2.Status == stripe.PaymentIntentStatusSucceeded || pi2.Status == stripe.PaymentIntentStatusProcessing) {
					pi, paidWith, paid = pi2, m.PaymentMethodID, true
					break
				}
				if err2 != nil {
					if f := stripex.ClassifyChargeError(err2); f.Transient {
						return settleResult{Settle: st}, err2
					} else if f.Stop {
						fail = f
						break
					}
				}
			}
		}
		if !paid {
			if piID != "" {
				if out, cerr := s.Stripe.ClosePaymentIntent(piID); cerr == nil && out.Paid {
					return s.applySettlePayment(ctx, st.ID, store.Payment{Kind: store.PaymentIntentKind, ID: piID}, out)
				} else if cerr != nil {
					return settleResult{Settle: st}, cerr
				}
			}
			if fail.Stop {
				s.setSheetOnly(ctx, st.UID, "stop code "+fail.DeclineCode)
			}
			closed, ferr := s.Store.FinishSettle(ctx, st.ID, store.SettleOutcome{}, dropped)
			return settleResult{Settle: closed, Declined: true, Failure: &fail}, ferr
		}
	}
	out := stripex.Outcome{PaymentIntentID: pi.ID, AmountReceived: pi.AmountReceived, PaymentMethod: paidWith,
		Paid: pi.Status == stripe.PaymentIntentStatusSucceeded, Processing: pi.Status == stripe.PaymentIntentStatusProcessing}
	return s.applySettlePayment(ctx, st.ID, store.Payment{Kind: store.PaymentIntentKind, ID: pi.ID}, out)
}

// applySettlePayment applies money found on a settle's payment object
// (its charge, a webhook, a sweep). Paid → the settle and every item paid
// in one transaction; the method used becomes the default when it was
// saved with this payment. Processing → in_progress. Money on a settle
// that already ended is extra and refunded (E0-2).
func (s *Service) applySettlePayment(ctx context.Context, settleID string, p store.Payment, out stripex.Outcome) (settleResult, error) {
	st, err := s.Store.GetSettle(ctx, settleID)
	if err != nil {
		return settleResult{}, err
	}
	if out.Processing && !out.Paid {
		updated, uerr := s.Store.UpdateSettle(ctx, settleID, func(x *store.Settle) error {
			if x.State != store.SettleSettling {
				return store.ErrStateConflict
			}
			x.PaymentState = store.SettleInProgress
			x.PaymentIntentID = out.PaymentIntentID
			return nil
		})
		if uerr != nil {
			return settleResult{Settle: st}, nil
		}
		return settleResult{Settle: updated}, nil
	}
	if !out.Paid {
		return settleResult{Settle: st}, nil
	}
	if st.State != store.SettleSettling {
		if st.PaymentIntentID != out.PaymentIntentID {
			s.refundLateSettle(ctx, st, out)
		} else {
			s.notePresentmentQuiet(ctx, store.PresentSettle, settleID, out) // a retry fills a missed one
		}
		return settleResult{Settle: st, Paid: st.State == store.SettlePaid}, nil
	}
	done, err := s.Store.FinishSettle(ctx, settleID, store.SettleOutcome{
		Paid: true, PaymentIntentID: out.PaymentIntentID, PaidCents: out.AmountReceived, PaidWith: out.PaymentMethod,
	}, nil)
	if errors.Is(err, store.ErrStateConflict) {
		fresh, _ := s.Store.GetSettle(ctx, settleID)
		if fresh != nil && fresh.PaymentIntentID != out.PaymentIntentID {
			s.refundLateSettle(ctx, fresh, out)
		}
		return settleResult{Settle: fresh, Paid: true}, nil
	}
	if err != nil {
		return settleResult{Settle: st}, err
	}
	slog.InfoContext(ctx, "settle paid", "settle_id", settleID, "uid", st.UID, "amount_cents", out.AmountReceived)
	s.notePresentmentQuiet(ctx, store.PresentSettle, settleID, out)
	if p.Kind == store.PaymentCheckoutSession && out.PaymentMethod != "" {
		// D3: a method saved with the settle becomes the default.
		if cust, cerr := s.Store.GetCustomer(ctx, st.UID); cerr == nil {
			if owner, typ, merr := s.Stripe.MethodOwner(out.PaymentMethod); merr == nil && owner == cust.StripeCustomerID && stripex.ReusableTypes[typ] {
				s.saveMethodFacts(ctx, st.UID, cust.StripeCustomerID, out.PaymentMethod, p.ID, p.ClientIP, true, true)
			}
		}
	}
	s.recordSettleCharge(ctx, done)       // C6: one invoice, a line per run
	s.payRequestsAfterSettle(ctx, st.UID) // D7: the dues links close once nothing is owed
	if st.Trigger == settleSoftRety {
		s.mailDownloadsBack(ctx, "E5_"+settleID, st.UID, out.AmountReceived)
	}
	if st.Trigger == settleWebRetry {
		s.mailSettleReceipt(ctx, done) // E20: a web group's debt the retry collected
	}
	return settleResult{Settle: done, Paid: true}, nil
}

func (s *Service) refundLateSettle(ctx context.Context, st *store.Settle, out stripex.Outcome) {
	s.refundLatePayment(ctx, &store.Conversion{ID: "settle:" + st.ID, UID: st.UID}, out.PaymentIntentID, out.AmountReceived,
		"paid after the settle was "+st.State)
}

// settleSweep (reconciler): settles past their lease are resolved from
// their payment object first — paid → paid, in flight → wait — and only
// then released (items back to owed). Then the 24 h soft retry (C5),
// once per failed group, and the E3/E4 reminders.
func (s *Service) settleSweep(ctx context.Context) (released, retried int) {
	now := time.Now().UTC()
	live, err := s.Store.ListSettlesByState(ctx, store.SettleSettling, 100)
	if err == nil {
		for _, st := range live {
			if st.Lease.Held(now) {
				continue
			}
			if st.Trigger == settleBalance {
				// Paid from the balance: the debt_payment entry decides.
				if b, berr := s.Store.GetBalance(ctx, st.UID); berr == nil && b.Exists() {
					if paid, _ := s.Store.EntryExists(ctx, st.UID, "debt_"+st.ID); paid {
						_, _ = s.finishBalanceSettle(ctx, st, nil)
						continue
					}
				}
			}
			if cp := st.CurrentPayment; cp != nil {
				out, cerr := s.closePayment(cp)
				if cerr != nil {
					continue
				}
				if out.Paid || out.Processing {
					_, _ = s.applySettlePayment(ctx, st.ID, *cp, out)
					continue
				}
			} else if st.ChargeStartedAt != nil {
				// B5: a charge went out and its answer was lost. Find what it
				// made; money taken pays this settle, never a second charge.
				if found, ok := s.recoverSettleCharge(ctx, st); !ok || found {
					continue
				}
			}
			if _, ferr := s.Store.FinishSettle(ctx, st.ID, store.SettleOutcome{}, nil); ferr == nil {
				released++
			}
		}
	}
	failed, err := s.Store.ListBatchesByState(ctx, store.BatchFailed, 100)
	if err != nil {
		return released, retried
	}
	seen := map[string]bool{}
	for _, b := range failed {
		if b.FailedAt == nil || seen[b.UID] {
			continue
		}
		age := now.Sub(*b.FailedAt)
		if b.Retry != nil && webBatch(b) {
			// A web group on the D2 schedule (+24 h, +72 h).
			switch {
			case b.Retry.Due(now):
				seen[b.UID] = true
				s.retryWebBatch(ctx, b, now)
				retried++
			case age >= 7*24*time.Hour:
				s.mailOwed(ctx, "E4", "E4_"+b.ID, b.UID, s.owedCents(ctx, b.UID))
			}
			continue
		}
		switch {
		case b.SoftDecline && !b.SoftRetried && age >= 24*time.Hour && webBatch(b):
			// A web group failed before its schedule existed (D1): retried
			// once under the web's rules, and marked retried only once the
			// retry ran (a transient error tries again).
			seen[b.UID] = true
			res, rerr := s.collectOutstanding(ctx, b.UID, settleWebRetry, payContext{})
			if rerr != nil {
				continue
			}
			_, _ = s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchFailed, store.BatchSettling, store.BatchPaid}, func(bb *store.Batch) error {
				bb.SoftRetried = true
				return nil
			}, nil, nil)
			if !res.Paid && !res.Live && !res.Nothing {
				s.mailOwed(ctx, "E3", "E3_"+b.ID, b.UID, s.owedCents(ctx, b.UID))
			}
			retried++
		case b.SoftDecline && !b.SoftRetried && age >= 24*time.Hour:
			seen[b.UID] = true
			_, _ = s.Store.TransitionBatch(ctx, b.ID, []string{store.BatchFailed}, func(bb *store.Batch) error {
				bb.SoftRetried = true
				return nil
			}, nil, nil)
			res, rerr := s.collectOutstanding(ctx, b.UID, settleSoftRety, payContext{})
			if rerr == nil && !res.Paid && !res.Live && !res.Nothing {
				s.mailOwed(ctx, "E3", "E3_"+b.ID, b.UID, s.owedCents(ctx, b.UID))
			}
			retried++
		case age >= 7*24*time.Hour:
			s.mailOwed(ctx, "E4", "E4_"+b.ID, b.UID, s.owedCents(ctx, b.UID))
		}
	}
	return released, retried
}

// recoverSettleCharge resolves a lapsed settle whose off-session charge
// was sent but never answered (B5), from Stripe's own record (a list by
// customer and settle_id, never a create). found: the PaymentIntent paid
// or is paying, and the settle follows it. ok false: Stripe couldn't be
// read or the PaymentIntent couldn't be closed — try again next sweep.
// Otherwise (none, or one that didn't pay, now cancelled) the caller
// releases the settle as before.
func (s *Service) recoverSettleCharge(ctx context.Context, st *store.Settle) (found, ok bool) {
	pi, err := s.Stripe.FindSettleCharge(st.ChargeCustomerID, st.ID, *st.ChargeStartedAt)
	if err != nil {
		slog.WarnContext(ctx, "settle charge lookup failed; retried next sweep", "settle_id", st.ID, "err", err)
		return false, false
	}
	if pi == nil {
		return false, true
	}
	out, cerr := s.Stripe.ClosePaymentIntent(pi.ID)
	if cerr != nil {
		return false, false
	}
	if !out.Paid && !out.Processing {
		return false, true
	}
	if out.PaymentMethod == "" {
		out.PaymentMethod = st.ChargePM
	}
	slog.WarnContext(ctx, "settle charge recovered from Stripe", "settle_id", st.ID, "payment_intent", pi.ID, "paid", out.Paid)
	if _, aerr := s.applySettlePayment(ctx, st.ID, store.Payment{Kind: store.PaymentIntentKind, ID: pi.ID}, out); aerr != nil {
		return false, false
	}
	return true, true
}

// --------------------------------------------------------------- routes

// HandleSettle2 is POST /v1/billing/settle. Empty body: ios_settle with
// today's shape {settled, requires_action, client_secret,
// publishable_key, message}. {ui: "elements"}: the sheet → {checkout
// {client_secret, expires_at}, amount_cents, runs, payment_state}.
func (s *Service) HandleSettle2(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		UI     string `json:"ui"`
		Source string `json:"source"` // "balance": pay from the prepaid balance (v7 N9)
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if req.Source == "balance" {
		owed := s.owedCents(ctx, user.UID)
		if b, berr := s.Store.GetBalance(ctx, user.UID); owed > 0 && (berr != nil || b.Available() < owed) {
			avail := int64(0)
			if b != nil {
				avail = max(b.Available(), 0)
			}
			e := httpx.Err(http.StatusPaymentRequired, "insufficient_balance", "your balance doesn't cover this payment")
			e.Details = map[string]any{"required_cents": owed, "available_cents": avail}
			httpx.WriteErr(ctx, w, e)
			return
		}
		res, err := s.collectOutstanding(ctx, user.UID, settleBalance, payContextOf(r))
		if err != nil {
			httpx.Log(ctx).Error("settle from balance failed", "uid", user.UID, "err", err)
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be made; try again"))
			return
		}
		httpx.WriteOK(w, noOneTapInChina(r, s.settleSheetResponse(ctx, user.UID, res)))
		return
	}
	customerID, err := s.ensureCustomerID(ctx, user)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	s.refreshCardCache(ctx, user.UID, customerID)
	if req.UI == "elements" {
		res, err := s.collectOutstanding(ctx, user.UID, settleSheet, payContextOf(r))
		if err != nil {
			httpx.Log(ctx).Error("settle sheet failed", "uid", user.UID, "err", err)
			httpx.WriteErr(ctx, w, httpx.Err(http.StatusBadGateway, "payment_error", "the payment couldn't be opened; try again"))
			return
		}
		httpx.WriteOK(w, noOneTapInChina(r, s.settleSheetResponse(ctx, user.UID, res)))
		return
	}
	res, err := s.collectOutstanding(ctx, user.UID, settleIOS, payContextOf(r))
	resp := map[string]any{"publishable_key": s.Stripe.PublishableKey}
	switch {
	case err != nil:
		resp["settled"] = false
		resp["message"] = "The payment could not be taken right now; it will be retried automatically."
	case res.Nothing || res.Paid:
		resp["settled"] = true
	case res.RequiresAction:
		resp["settled"], resp["requires_action"], resp["client_secret"] = false, true, res.ClientSecret
	default:
		resp["settled"] = false
		resp["message"] = "The charge was declined. Update your payment method in Billing, then retry."
	}
	httpx.WriteOK(w, resp)
}

// wirePaymentState is a settle's payment state as the web reads it:
// open | processing | paid (stored as in_progress while Stripe reports a
// payment in flight).
func wirePaymentState(state string) string {
	if state == store.SettleInProgress {
		return "processing"
	}
	return state
}

// settleSheetResponse is the P2 shape; after a payment, more owed items
// (failed meanwhile) show as the next amount.
func (s *Service) settleSheetResponse(ctx context.Context, uid string, res settleResult) map[string]any {
	resp := map[string]any{"publishable_key": s.Stripe.PublishableKey}
	switch {
	case res.Nothing:
		resp["payment_state"], resp["amount_cents"], resp["runs"] = "paid", 0, 0
		resp["settled"] = true
	case res.Settle != nil:
		st := res.Settle
		resp["settle_id"], resp["amount_cents"], resp["runs"] = st.ID, st.AmountCents, st.Runs()
		state := st.PaymentState
		if st.State == store.SettlePaid {
			state = "paid"
		}
		if state == "" {
			state = store.SettleOpen
		}
		resp["payment_state"] = wirePaymentState(state)
		resp["settled"] = st.State == store.SettlePaid
		if cp := st.CurrentPayment; cp != nil && cp.Kind == store.PaymentCheckoutSession && cp.ClientSecret != "" && st.State == store.SettleSettling {
			ch := map[string]any{"client_secret": cp.ClientSecret}
			if cp.ExpiresAt != nil {
				ch["expires_at"] = cp.ExpiresAt.Format(time.RFC3339)
			}
			resp["checkout"] = ch
		}
		if st.State == store.SettlePaid {
			if more := s.owedCents(ctx, uid); more > 0 {
				resp["more_owed_cents"] = more // "One more payment is waiting."
			}
		} else if st.State == store.SettleSettling {
			if cust, err := s.Store.GetCustomer(ctx, uid); err == nil {
				resp["one_tap"] = s.oneTapOffer(ctx, uid, cust, st.AmountCents, false) // BUX-20: null when not allowed
			}
		}
	}
	return resp
}

// outstandingLock is C10's server-side lock for web outputs: while the
// account owes anything, signed URLs (downloads, View in 3D, preview
// playback) answer 402 payment_needed with the amount — the live
// settle's frozen amount when one is open. The mobile one-shot keeps
// billing_overdue.
func (s *Service) outstandingLock(ctx context.Context, uid string) error {
	owed := s.owedCents(ctx, uid)
	if owed <= 0 {
		return nil
	}
	amount := owed
	if live, err := s.Store.LiveSettle(ctx, uid); err == nil && live != nil {
		amount = live.AmountCents
	}
	e := httpx.Err(http.StatusPaymentRequired, "payment_needed", "a payment is needed before you can download")
	e.Details = map[string]any{"amount_cents": amount}
	return e
}
