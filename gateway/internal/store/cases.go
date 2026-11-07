package store

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Cases (spec v6/v7 C13): one per money issue — a refund request, a
// dispute, an early fraud warning, a support request about money, a
// waive, a balance refund. Automatic refunds write one too, for the
// record. cases_{env}/{CASE-0042}, a timeline under events/, evidence
// snapshots under evidence/.

// Case types.
const (
	CaseRefund        = "refund"
	CaseDispute       = "dispute"
	CaseEFW           = "efw"
	CaseSupport       = "support"
	CaseWaive         = "waive"
	CaseBalanceRefund = "balance_refund"
)

// Case statuses.
const (
	CaseWaitingForRun     = "waiting_for_run"
	CaseOpen              = "open"
	CaseWaitingOnCustomer = "waiting_on_customer"
	CaseDecided           = "decided"
	CaseRefundPending     = "refund_pending"
	CaseRefunded          = "refunded"
	CaseDenied            = "denied"
	CaseWaived            = "waived"
	CaseSuperseded        = "superseded"
	CaseDuplicate         = "duplicate"
	CaseClosed            = "closed"
)

// CaseRelated are the objects a case is about.
type CaseRelated struct {
	ConversionIDs []string `firestore:"conversion_ids,omitempty" json:"conversion_ids,omitempty"`
	ProjectIDs    []string `firestore:"project_ids,omitempty" json:"project_ids,omitempty"`
	ChargeIDs     []string `firestore:"charge_ids,omitempty" json:"charge_ids,omitempty"`
	PIIDs         []string `firestore:"pi_ids,omitempty" json:"pi_ids,omitempty"`
	DisputeID     string   `firestore:"dispute_id,omitempty" json:"dispute_id,omitempty"`
	EFWID         string   `firestore:"efw_id,omitempty" json:"efw_id,omitempty"`
	TopupID       string   `firestore:"topup_id,omitempty" json:"topup_id,omitempty"`
	InvoiceIDs    []string `firestore:"invoice_ids,omitempty" json:"invoice_ids,omitempty"`
	LinkedCaseIDs []string `firestore:"linked_case_ids,omitempty" json:"linked_case_ids,omitempty"`
	SupersededBy  string   `firestore:"superseded_by,omitempty" json:"superseded_by,omitempty"`
	DuplicateOf   string   `firestore:"duplicate_of,omitempty" json:"duplicate_of,omitempty"`
}

// CaseDecision is the owner's (or the policy's) decision.
type CaseDecision struct {
	Kind             string           `firestore:"kind" json:"kind"` // full | partial | deny | no_refund | waive | accept_dispute | counter_dispute | counter_with_refund_proof | out_of_band | auto
	Items            map[string]int64 `firestore:"items,omitempty" json:"items,omitempty"`
	By               string           `firestore:"by" json:"by"`
	At               time.Time        `firestore:"at" json:"at"`
	CustomerTemplate string           `firestore:"customer_template,omitempty" json:"customer_template,omitempty"`
	Text             string           `firestore:"text,omitempty" json:"text,omitempty"`
}

// DisputeInfo mirrors a Stripe dispute on a dispute case.
type DisputeInfo struct {
	ID       string     `firestore:"id" json:"id"`
	Amount   int64      `firestore:"amount" json:"amount_cents"`
	Reason   string     `firestore:"reason" json:"reason"`
	Status   string     `firestore:"status" json:"status"`
	DueBy    *time.Time `firestore:"due_by,omitempty" json:"due_by,omitempty"`
	Outcome  string     `firestore:"outcome,omitempty" json:"outcome,omitempty"` // won | lost
	FundsOut bool       `firestore:"funds_withdrawn,omitempty" json:"funds_withdrawn"`
}

// Case is cases_{env}/{id}.
type Case struct {
	ID              string           `firestore:"-" json:"id"`
	DedupeKey       string           `firestore:"dedupe_key,omitempty" json:"-"`
	UID             string           `firestore:"uid" json:"uid"`
	CustomerID      string           `firestore:"customer_id,omitempty" json:"customer_id,omitempty"`
	Type            string           `firestore:"type" json:"type"`
	Reason          string           `firestore:"reason" json:"reason"`
	Mode            string           `firestore:"mode" json:"mode"` // auto | manual
	Source          string           `firestore:"source" json:"source"`
	Status          string           `firestore:"status" json:"status"`
	Result          string           `firestore:"result,omitempty" json:"result,omitempty"` // how a closed case ended
	Open            bool             `firestore:"open" json:"open"`
	CustomerVisible bool             `firestore:"customer_visible" json:"customer_visible"`
	Related         CaseRelated      `firestore:"related" json:"related"`
	RequestedCents  int64            `firestore:"requested_cents" json:"requested_cents"`
	DecidedCents    int64            `firestore:"decided_cents" json:"decided_cents"`
	Items           map[string]int64 `firestore:"items,omitempty" json:"items,omitempty"` // requested per run
	Currency        string           `firestore:"currency" json:"currency"`
	Decision        *CaseDecision    `firestore:"decision,omitempty" json:"decision,omitempty"`
	RefundIDs       []string         `firestore:"refund_ids,omitempty" json:"refund_ids,omitempty"`
	CreditNoteIDs   []string         `firestore:"credit_note_ids,omitempty" json:"credit_note_ids,omitempty"`
	Dispute         *DisputeInfo     `firestore:"dispute,omitempty" json:"dispute,omitempty"`
	// Promo: the account's promotional grants removed when the dispute
	// opened (the promo_regrants record and its snapshot).
	Promo *CasePromo `firestore:"promo,omitempty" json:"promo,omitempty"`
	// FollowUpOf: the closed case a customer wrote to again (this case
	// carries the message; the closed one is never written).
	// FollowUpIDs: on a closed case, its follow-ups (read from their
	// follow_up_of when the case page is built, never stored).
	FollowUpOf   string   `firestore:"follow_up_of,omitempty" json:"follow_up_of,omitempty"`
	FollowUpIDs  []string `firestore:"-" json:"follow_up_ids"`
	CustomerText string   `firestore:"customer_text,omitempty" json:"customer_text,omitempty"`
	// PlanMove: a support move of a plan off this (live) account (RP-05).
	PlanMove       *CasePlanMove `firestore:"plan_move,omitempty" json:"plan_move,omitempty"`
	EvidenceN      int           `firestore:"evidence_n" json:"evidence_n"`
	EvidenceAt     *time.Time    `firestore:"evidence_at,omitempty" json:"evidence_at,omitempty"`
	DeadlineAt     *time.Time    `firestore:"deadline_at,omitempty" json:"deadline_at,omitempty"`
	Reminders      []time.Time   `firestore:"reminders,omitempty" json:"reminders,omitempty"`
	LastActivityAt time.Time     `firestore:"last_activity_at" json:"last_activity_at"`
	OpenedAt       time.Time     `firestore:"opened_at" json:"opened_at"`
	DecidedAt      *time.Time    `firestore:"decided_at,omitempty" json:"decided_at,omitempty"`
	ClosedAt       *time.Time    `firestore:"closed_at,omitempty" json:"closed_at,omitempty"`
	StatusSince    time.Time     `firestore:"status_since" json:"status_since"`
	Lease          *Lease        `firestore:"lease,omitempty" json:"-"`
}

// CasePromo links a dispute case to its promo_regrants record.
type CasePromo struct {
	RecordID string       `firestore:"record_id" json:"record_id"`
	Snapshot []PromoGrant `firestore:"snapshot" json:"snapshot"`
	Status   string       `firestore:"status" json:"status"`
}

// CaseEvent is one timeline line.
type CaseEvent struct {
	ID   string         `firestore:"-" json:"id"`
	At   time.Time      `firestore:"at" json:"at"`
	Who  string         `firestore:"who" json:"who"`
	Kind string         `firestore:"kind" json:"kind"`
	Text string         `firestore:"text,omitempty" json:"text,omitempty"`
	Data map[string]any `firestore:"data,omitempty" json:"data,omitempty"`
}

func casesCol(env string) string { return "cases_" + env }

func (s *Store) caseDoc(id string) *firestore.DocumentRef {
	return s.fs.Collection(casesCol(s.env)).Doc(CaseID(id))
}

// CaseRef is a case id as customers see it: CASE-0042 becomes REF-0042
// (owner 2026-11-08: "case" is never customer-facing).
func CaseRef(id string) string {
	if rest, ok := strings.CutPrefix(id, "CASE-"); ok {
		return "REF-" + rest
	}
	return id
}

// CaseID turns a customer's reference (REF-0042, ref-0042) back into the
// stored id, so support can look up whatever the customer quotes.
func CaseID(ref string) string {
	ref = strings.TrimSpace(ref)
	if len(ref) > 4 && strings.EqualFold(ref[:4], "REF-") {
		return "CASE-" + ref[4:]
	}
	return ref
}

func snapToCase(snap *firestore.DocumentSnapshot) (*Case, error) {
	var c Case
	if err := snap.DataTo(&c); err != nil {
		return nil, err
	}
	c.ID = snap.Ref.ID
	return &c, nil
}

// CreateCase writes a case under the next CASE-NNNN, unless an open case
// has the same dedupe key: then that one is returned (created=false) and
// a request_merged event added.
func (s *Store) CreateCase(ctx context.Context, c *Case, who, text string) (*Case, bool, error) {
	var out *Case
	created := false
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		out, created = nil, false
		if c.DedupeKey != "" {
			snaps, err := tx.Documents(s.fs.Collection(casesCol(s.env)).Where("dedupe_key", "==", c.DedupeKey)).GetAll()
			if err != nil {
				return err
			}
			for _, snap := range snaps {
				ex, err := snapToCase(snap)
				if err != nil {
					return err
				}
				if ex.Open {
					out = ex
					now := time.Now().UTC()
					ex.LastActivityAt = now
					if err := tx.Set(s.caseDoc(ex.ID), ex); err != nil {
						return err
					}
					return tx.Create(s.caseDoc(ex.ID).Collection("events").NewDoc(), CaseEvent{At: now, Who: who, Kind: "request_merged", Text: text})
				}
			}
		}
		ctr := s.fs.Collection("counters_" + s.env).Doc("cases")
		csnap, err := tx.Get(ctr)
		if err != nil && status.Code(err) != codes.NotFound {
			return err
		}
		n := int64(0)
		if csnap != nil && csnap.Exists() {
			if v, ok := csnap.Data()["n"].(int64); ok {
				n = v
			}
		}
		n++
		now := time.Now().UTC()
		cc := *c
		cc.ID = fmt.Sprintf("CASE-%04d", n)
		cc.Open = cc.Status != CaseClosed
		if cc.Currency == "" {
			cc.Currency = "usd"
		}
		cc.OpenedAt, cc.LastActivityAt, cc.StatusSince = now, now, now
		if err := tx.Set(ctr, map[string]any{"n": n}); err != nil {
			return err
		}
		if err := tx.Create(s.caseDoc(cc.ID), &cc); err != nil {
			return err
		}
		out, created = &cc, true
		return tx.Create(s.caseDoc(cc.ID).Collection("events").NewDoc(), CaseEvent{At: now, Who: who, Kind: "opened", Text: text,
			Data: map[string]any{"type": cc.Type, "reason": cc.Reason, "mode": cc.Mode, "status": cc.Status}})
	})
	return out, created, err
}

func (s *Store) GetCase(ctx context.Context, id string) (*Case, error) {
	snap, err := s.caseDoc(id).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return snapToCase(snap)
}

// UpdateCase mutates a case in a transaction; a status change is stamped
// and logged. A closed case can't change (C13: closed is final).
func (s *Store) UpdateCase(ctx context.Context, id, who string, mutate func(c *Case) error) (*Case, error) {
	var out *Case
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.caseDoc(id))
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		c, err := snapToCase(snap)
		if err != nil {
			return err
		}
		if c.Status == CaseClosed {
			return fmt.Errorf("%w: %s is closed", ErrStateConflict, id)
		}
		before := c.Status
		if err := mutate(c); err != nil {
			return err
		}
		now := time.Now().UTC()
		c.LastActivityAt = now
		if c.Status != before {
			c.StatusSince = now
			if c.Status == CaseClosed && c.ClosedAt == nil {
				c.ClosedAt = &now
			}
			if err := tx.Create(s.caseDoc(id).Collection("events").NewDoc(), CaseEvent{At: now, Who: who, Kind: "status_change",
				Text: before + " → " + c.Status}); err != nil {
				return err
			}
		}
		c.Open = c.Status != CaseClosed
		out = c
		return tx.Set(s.caseDoc(id), c)
	})
	return out, err
}

// ErrCaseClosed: the event isn't one a closed case takes.
var ErrCaseClosed = errors.New("case closed")

// closedCaseEvents are the system events a closed case still takes
// through AddCaseEvent (owner 2026-11-04; everything else is refused with
// ErrCaseClosed, and admins reopen a case before writing to it):
//
//   - closed: written right after the status change that closes it
//   - refund_executed: the refund that closed it (card, balance, outside
//     Stripe), recorded after the close
//   - refund_failed: a refund failing after the close (a new linked
//     refund_failed case takes the follow-up)
//   - superseded: a dispute superseding the case, written after it closed
//   - plan_ended: a plan refund's summary, written after the refund
//     closed the case
//   - promo_restored: the owner's restore after a lost dispute (written
//     through AppendClosedCaseEvent, idempotent per restore)
var closedCaseEvents = map[string]bool{
	"closed": true, "refund_executed": true, "refund_failed": true, "superseded": true, "plan_ended": true,
	CaseEventPromoRestored: true,
}

// ClosedCaseTakes: a closed case accepts an event of this kind.
func ClosedCaseTakes(kind string) bool { return closedCaseEvents[kind] }

// AddCaseEvent appends a timeline line; a closed case takes only the
// allow-listed system events (ErrCaseClosed otherwise).
func (s *Store) AddCaseEvent(ctx context.Context, id string, e CaseEvent) error {
	if e.At.IsZero() {
		e.At = time.Now().UTC()
	}
	return s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.caseDoc(id))
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if st, _ := snap.DataAt("status"); st == CaseClosed && !closedCaseEvents[e.Kind] {
			return fmt.Errorf("%w: %w: %s takes no %s event", ErrStateConflict, ErrCaseClosed, id, e.Kind)
		}
		if err := tx.Create(s.caseDoc(id).Collection("events").NewDoc(), e); err != nil {
			return err
		}
		return tx.Update(s.caseDoc(id), []firestore.Update{{Path: "last_activity_at", Value: e.At}})
	})
}

// ListFollowUpIDs: the cases opened as follow-ups of id.
func (s *Store) ListFollowUpIDs(ctx context.Context, id string) ([]string, error) {
	snaps, err := s.fs.Collection(casesCol(s.env)).Where("follow_up_of", "==", id).Limit(50).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(snaps))
	for _, sn := range snaps {
		out = append(out, sn.Ref.ID)
	}
	return out, nil
}

// ReopenCase opens a closed case again (an admin's explicit reopen, with
// the reason on the timeline).
func (s *Store) ReopenCase(ctx context.Context, id, who, reason string) (*Case, error) {
	var out *Case
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.caseDoc(id))
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		c, err := snapToCase(snap)
		if err != nil {
			return err
		}
		if c.Status != CaseClosed {
			return fmt.Errorf("%w: %s isn't closed", ErrStateConflict, id)
		}
		now := time.Now().UTC()
		prevResult := c.Result
		c.Status, c.Open, c.Result, c.ClosedAt, c.StatusSince, c.LastActivityAt = CaseOpen, true, "", nil, now, now
		if err := tx.Create(s.caseDoc(id).Collection("events").NewDoc(), CaseEvent{At: now, Who: who, Kind: "status_change", Text: CaseClosed + " → " + CaseOpen}); err != nil {
			return err
		}
		if err := tx.Create(s.caseDoc(id).Collection("events").NewDoc(), CaseEvent{At: now, Who: who, Kind: "reopened", Text: reason,
			Data: map[string]any{"previous_result": prevResult}}); err != nil {
			return err
		}
		out = c
		return tx.Set(s.caseDoc(id), c)
	})
	return out, err
}

// CaseEventPromoRestored is the one event a closed case still takes
// through AppendClosedCaseEvent: the owner restored the promotional Pro
// a lost dispute removed (owner 2026-11-04).
const CaseEventPromoRestored = "promo_restored"

// AppendClosedCaseEvent appends e to a case whatever its status, without
// touching the case itself (status, result, activity stay): the narrow
// exception to the closed-case guard, for promo_restored alone. eventID
// makes it idempotent (false when it was there).
func (s *Store) AppendClosedCaseEvent(ctx context.Context, caseID, eventID string, e CaseEvent) (bool, error) {
	if e.Kind != CaseEventPromoRestored {
		return false, fmt.Errorf("%w: a closed case takes only %s events", ErrStateConflict, CaseEventPromoRestored)
	}
	if e.At.IsZero() {
		e.At = time.Now().UTC()
	}
	if _, err := s.caseDoc(caseID).Get(ctx); err != nil {
		if status.Code(err) == codes.NotFound {
			return false, ErrNotFound
		}
		return false, err
	}
	_, err := s.caseDoc(caseID).Collection("events").Doc(eventID).Create(ctx, e)
	if status.Code(err) == codes.AlreadyExists {
		return false, nil
	}
	return err == nil, err
}

// ListCaseEvents is a case's timeline, newest first.
func (s *Store) ListCaseEvents(ctx context.Context, id string, limit int) ([]CaseEvent, error) {
	iter := s.caseDoc(id).Collection("events").OrderBy("at", firestore.Desc).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []CaseEvent
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		var e CaseEvent
		if err := snap.DataTo(&e); err != nil {
			return nil, err
		}
		e.ID = snap.Ref.ID
		out = append(out, e)
	}
}

// SaveEvidence stores snapshot n (frozen; a refresh adds the next).
func (s *Store) SaveEvidence(ctx context.Context, id string, n int, snapshot map[string]any) error {
	_, err := s.caseDoc(id).Collection("evidence").Doc(fmt.Sprintf("%04d", n)).Set(ctx, snapshot)
	return err
}

// LatestEvidence reads the newest snapshot.
func (s *Store) LatestEvidence(ctx context.Context, id string) (map[string]any, error) {
	iter := s.caseDoc(id).Collection("evidence").OrderBy(firestore.DocumentID, firestore.Desc).Limit(1).Documents(ctx)
	defer iter.Stop()
	snap, err := iter.Next()
	if isIterDone(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return snap.Data(), nil
}

func (s *Store) collectCases(iter *firestore.DocumentIterator) ([]*Case, error) {
	defer iter.Stop()
	var out []*Case
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		c, err := snapToCase(snap)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
}

// ListCases lists open (or closed) cases.
func (s *Store) ListCases(ctx context.Context, open bool, limit int) ([]*Case, error) {
	return s.collectCases(s.fs.Collection(casesCol(s.env)).Where("open", "==", open).Limit(limit).Documents(ctx))
}

// ListUserCases lists an account's cases.
func (s *Store) ListUserCases(ctx context.Context, uid string, limit int) ([]*Case, error) {
	out, err := s.collectCases(s.fs.Collection(casesCol(s.env)).Where("uid", "==", uid).Limit(limit).Documents(ctx))
	sort.Slice(out, func(i, j int) bool { return out[i].OpenedAt.After(out[j].OpenedAt) })
	return out, err
}

// ListCasesByPI lists cases about a PaymentIntent.
func (s *Store) ListCasesByPI(ctx context.Context, pi string, limit int) ([]*Case, error) {
	return s.collectCases(s.fs.Collection(casesCol(s.env)).Where("related.pi_ids", "array-contains", pi).Limit(limit).Documents(ctx))
}

// ListCasesByConversion lists cases about a run.
func (s *Store) ListCasesByConversion(ctx context.Context, convID string, limit int) ([]*Case, error) {
	return s.collectCases(s.fs.Collection(casesCol(s.env)).Where("related.conversion_ids", "array-contains", convID).Limit(limit).Documents(ctx))
}

// ListCasesByType lists cases of a type (A4).
func (s *Store) ListCasesByType(ctx context.Context, typ string, limit int) ([]*Case, error) {
	return s.collectCases(s.fs.Collection(casesCol(s.env)).Where("type", "==", typ).Limit(limit).Documents(ctx))
}

// Audit writes one admin_audit_{env} row (M1: every admin action).
func (s *Store) Audit(ctx context.Context, row map[string]any) error {
	row["at"] = time.Now().UTC()
	_, err := s.fs.Collection("admin_audit_"+s.env).NewDoc().Create(ctx, row)
	return err
}

// PIWaived: an owed or not-yet-charged run the owner waived (C13 Waive).
const PIWaived = "waived"

// WaiveRun removes an unpaid run from what's owed in one transaction: a
// per-run charge_failed is marked waived; a run in an open or failed
// group leaves it (the group's total drops; an empty group closes as
// waived). A run in a live settle or a group being charged is refused.
func (s *Store) WaiveRun(ctx context.Context, convID string) (int64, error) {
	var cents int64
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		cents = 0
		csnap, err := tx.Get(s.convDoc(convID))
		if err != nil {
			return err
		}
		c, err := snapToConversion(csnap)
		if err != nil {
			return err
		}
		if c.Stripe.PIStatus == PISettling || c.Stripe.PIStatus == PIWaived {
			return fmt.Errorf("%w: run %s is %s", ErrStateConflict, convID, c.Stripe.PIStatus)
		}
		now := time.Now().UTC()
		if c.Stripe.BatchID != "" {
			bsnap, err := tx.Get(s.batchDoc(c.Stripe.BatchID))
			if err != nil {
				return err
			}
			b, err := snapToBatch(bsnap)
			if err != nil {
				return err
			}
			if b.State != BatchOpen && b.State != BatchFailed {
				return fmt.Errorf("%w: its group is %s", ErrStateConflict, b.State)
			}
			keep := b.Items[:0]
			for _, it := range b.Items {
				if it.ConversionID == convID {
					cents += it.AmountCents
					continue
				}
				keep = append(keep, it)
			}
			b.Items, b.TotalCents, b.UpdatedAt = keep, b.TotalCents-cents, now
			if len(b.Items) == 0 {
				b.State, b.CloseReason, b.ClosedAt = BatchWaived, "waived", &now
			}
			if err := tx.Set(s.batchDoc(b.ID), b); err != nil {
				return err
			}
			c.Stripe.BatchID = ""
		} else {
			if c.Stripe.PIStatus != PIChargeFailed && c.Stripe.PIStatus != PIChargePending && c.Stripe.CapturedCents > 0 {
				return fmt.Errorf("%w: run %s is paid", ErrStateConflict, convID)
			}
			cents = c.Quote.AmountCents
		}
		c.Stripe.PIStatus, c.Stripe.SettleError, c.UpdatedAt = PIWaived, "", now
		return tx.Set(s.convDoc(convID), c)
	})
	return cents, err
}
