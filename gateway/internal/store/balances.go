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

// Prepaid balance (spec v7.1 §N). One summary document per account,
// balances_{env}/{uid}, and an append-only ledger under it
// (balances_{env}/{uid}/entries/{id}). Every change is ONE transaction
// that writes the entries and the summary together and refuses anything
// that would break E0-8: balance + reload_in_flight − held − frozen ≥ 0.
// A run's terminal transition settles or releases its hold in the same
// transaction (Transition → closeRunHold, v7.1 R3).

// FlowBalance / BillingModeBalance: a run paid from the balance (N5).
const (
	FlowBalance        = "balance"
	BillingModeBalance = "balance"
)

// Run hold states (Conversion.RunBalance.State).
const (
	HoldHeld          = "held"
	HoldPendingReload = "pending_reload"
	HoldSettled       = "settled"
	HoldReleased      = "released"
)

// Ledger kinds (N1).
const (
	EntryTopup           = "topup"
	EntryHold            = "hold"
	EntrySettle          = "settle"
	EntryRelease         = "release"
	EntryRefundToBalance = "refund_to_balance"
	EntryDebtPayment     = "debt_payment"
	EntryCashRefund      = "cash_refund"
	EntryDisputeFreeze   = "dispute_freeze"
	EntryDisputeUnfreeze = "dispute_unfreeze"
	EntryDisputeLoss     = "dispute_loss"
	EntryExpiry          = "expiry"
	EntryAdjustment      = "adjustment"
	// Plan credit (pricing 2026-11): a plan's monthly credit, non-cash,
	// spent first, gone at the period's end.
	EntryPlanCredit       = "plan_credit"
	EntryPlanCreditExpiry = "plan_credit_expiry"
	// A plan that ends early (owner rules 2026-11-03): a dispute, a fraud
	// warning or a block freezes the unheld plan credit (Ref names why:
	// dispute:{id} | efw:{id} | block); a won dispute or an unblock
	// unfreezes it (it still expires at the period's end); a lost dispute,
	// a refund we grant, a permanent block or a deletion removes it.
	EntryPlanCreditFreeze   = "plan_credit_freeze"
	EntryPlanCreditUnfreeze = "plan_credit_unfreeze"
	EntryPlanCreditRemoval  = "plan_credit_removal"
)

// Top-up states.
const (
	TopupOpen     = "open"     // a sheet / China payment is open
	TopupCharging = "charging" // an auto-reload being charged off-session
	TopupPaid     = "paid"
	TopupFailed   = "failed"
	TopupCanceled = "canceled"
)

// Defaults (T15, T16).
const (
	DefaultLowBalanceCents = 500
	DefaultReloadBelow     = 1000
	DefaultReloadAdd       = 2500
	MaxReloadsPerDay       = 5
	balanceLifetime        = 365 * 24 * time.Hour
)

// ErrInsufficientBalance: the change would take available below zero.
var ErrInsufficientBalance = errors.New("insufficient balance")

// RunBalance is a balance run's hold (Conversion.RunBalance).
type RunBalance struct {
	HoldCents int64  `firestore:"hold_cents"`
	State     string `firestore:"state"`
	// SettleCents: the delivered price the run settles at (0 = the hold);
	// set by the success path before the terminal transition.
	SettleCents   int64      `firestore:"settle_cents,omitempty"`
	SettledCents  int64      `firestore:"settled_cents,omitempty"`
	ReleasedCents int64      `firestore:"released_cents,omitempty"`
	TopupID       string     `firestore:"topup_id,omitempty"` // the reload a pending hold waits for
	FifoUsed      []FifoUse  `firestore:"fifo_used,omitempty"`
	ClosedAt      *time.Time `firestore:"closed_at,omitempty"`
	// Effects of the transaction that closed the hold (not stored).
	Effects BalanceEffects `firestore:"-"`
}

// FifoItem is an unspent part of a top-up (TopupID "" = a non-cash
// credit, spent first, never paid out).
type FifoItem struct {
	TopupID        string    `firestore:"topup_id"`
	RemainingCents int64     `firestore:"remaining_cents"`
	At             time.Time `firestore:"at"`
	// PlanCredit: a plan's credit for one period (ExpiresAt), spent before
	// anything else and never paid out.
	PlanCredit bool       `firestore:"plan_credit,omitempty"`
	ExpiresAt  *time.Time `firestore:"expires_at,omitempty"`
	Ref        string     `firestore:"ref,omitempty"`
	// FrozenCents of RemainingCents can't be spent (counted in the
	// balance's frozen_cents); FrozenRef says why (plan credit freezes).
	FrozenCents int64  `firestore:"frozen_cents,omitempty"`
	FrozenRef   string `firestore:"frozen_ref,omitempty"`
}

func (it FifoItem) spendable() int64 { return it.RemainingCents - it.FrozenCents }

// FifoUse is what a settle or debt payment took from one item.
type FifoUse struct {
	TopupID string `firestore:"topup_id"`
	Cents   int64  `firestore:"cents"`
}

type AutoReload struct {
	Enabled      bool       `firestore:"enabled" json:"enabled"`
	BelowCents   int64      `firestore:"below_cents" json:"below_cents"`
	AddCents     int64      `firestore:"add_cents" json:"add_cents"`
	PausedReason string     `firestore:"paused_reason,omitempty" json:"paused_reason,omitempty"`
	PausedDay    string     `firestore:"paused_day,omitempty" json:"-"` // limit pauses lift the next day
	ConsentAt    *time.Time `firestore:"consent_at,omitempty" json:"-"`
	TextVersion  string     `firestore:"text_version,omitempty" json:"-"`
}

type ReloadInFlight struct {
	TopupID string `firestore:"topup_id"`
	Cents   int64  `firestore:"cents"`
}

// HoldRef is one open hold on the summary.
type HoldRef struct {
	Cents         int64     `firestore:"cents"`
	PendingReload bool      `firestore:"pending_reload,omitempty"`
	TopupID       string    `firestore:"topup_id,omitempty"`
	At            time.Time `firestore:"at"`
}

// Balance is balances_{env}/{uid}.
type Balance struct {
	UID             string             `firestore:"uid"`
	BalanceCents    int64              `firestore:"balance_cents"`
	HeldCents       int64              `firestore:"held_cents"`
	FrozenCents     int64              `firestore:"frozen_cents"`
	LastTopupAt     *time.Time         `firestore:"last_topup_at,omitempty"`
	ExpiresAt       *time.Time         `firestore:"expires_at,omitempty"`
	Expired         bool               `firestore:"expired"`
	AutoReload      AutoReload         `firestore:"auto_reload"`
	SpendLimitCents *int64             `firestore:"spend_limit_cents"`
	LowBalanceCents int64              `firestore:"low_balance_cents"`
	LowAlertArmed   bool               `firestore:"low_alert_armed"`
	Fifo            []FifoItem         `firestore:"fifo"`
	ReloadInFlight  *ReloadInFlight    `firestore:"reload_in_flight"`
	ReloadArmed     bool               `firestore:"reload_armed"`
	Holds           map[string]HoldRef `firestore:"holds"`
	MonthKey        string             `firestore:"month_key"`
	MonthSettled    int64              `firestore:"month_settled_cents"`
	DayKey          string             `firestore:"day_key"`
	DayTopupCents   int64              `firestore:"day_topup_cents"`
	DayReloads      int                `firestore:"day_reloads"`
	Notices         map[string]bool    `firestore:"notices,omitempty"` // expiry notices sent for this expires_at
	TopupCount      int                `firestore:"topup_count"`
	HasPlanCredit   bool               `firestore:"has_plan_credit"`
	EntrySeq        int64              `firestore:"entry_seq"`
	Extra           map[string]any     `firestore:"extra,omitempty"`
	UpdatedAt       time.Time          `firestore:"updated_at"`
	exists          bool
}

// Exists reports whether the account ever had a balance document.
func (b *Balance) Exists() bool { return b.exists }

// NewBalance is an account's balance before its first change.
func NewBalance(uid string) *Balance {
	return &Balance{UID: uid, LowBalanceCents: DefaultLowBalanceCents, LowAlertArmed: true, ReloadArmed: true,
		AutoReload: AutoReload{BelowCents: DefaultReloadBelow, AddCents: DefaultReloadAdd}, Holds: map[string]HoldRef{}}
}

// Available = balance − held − frozen (N1).
func (b *Balance) Available() int64 { return b.BalanceCents - b.HeldCents - b.FrozenCents }

// reloadTerm is the in-flight reload's cents when a pending_reload hold
// counts on it (E0-8).
func (b *Balance) reloadTerm() int64 {
	if b.ReloadInFlight == nil {
		return 0
	}
	for _, h := range b.Holds {
		if h.PendingReload && h.TopupID == b.ReloadInFlight.TopupID {
			return b.ReloadInFlight.Cents
		}
	}
	return 0
}

// MonthSettledFor is what settled in month (UTC "2006-01").
func (b *Balance) MonthSettledFor(month string) int64 {
	if b.MonthKey == month {
		return b.MonthSettled
	}
	return 0
}

// Entry is one ledger line. Cents is the size; Delta the effect on the
// balance (holds and releases move held, not balance).
type Entry struct {
	ID           string    `firestore:"-" json:"id"`
	Kind         string    `firestore:"kind" json:"kind"`
	Cents        int64     `firestore:"cents" json:"cents"`
	Delta        int64     `firestore:"delta" json:"-"`
	At           time.Time `firestore:"at" json:"at"`
	Ref          string    `firestore:"ref,omitempty" json:"-"`
	TopupID      string    `firestore:"topup_id,omitempty" json:"-"`
	ConversionID string    `firestore:"conversion_id,omitempty" json:"-"`
	CaseID       string    `firestore:"case_id,omitempty" json:"-"`
	Note         string    `firestore:"note,omitempty" json:"-"`
	Auto         bool      `firestore:"auto,omitempty" json:"-"`
	FifoUsed     []FifoUse `firestore:"fifo_used,omitempty" json:"-"`
	BalanceAfter int64     `firestore:"balance_after" json:"-"`
	Seq          int64     `firestore:"seq" json:"-"`
}

// BalanceEffects are what a transaction asks the caller to do after it
// commits: start a reload, mail a low-balance alert.
type BalanceEffects struct {
	ReloadTopupID string
	LowAlert      bool
	Available     int64
}

// Topup is topups_{env}/{id}: one top-up, by the sheet, China or an
// auto-reload.
type Topup struct {
	ID              string     `firestore:"-" json:"topup_id"`
	UID             string     `firestore:"uid" json:"-"`
	Cents           int64      `firestore:"cents" json:"amount_cents"`
	Currency        string     `firestore:"currency" json:"currency"`
	State           string     `firestore:"state" json:"state"`
	Auto            bool       `firestore:"auto" json:"auto"`
	CurrentPayment  *Payment   `firestore:"current_payment,omitempty" json:"-"`
	Payments        []Payment  `firestore:"payments,omitempty" json:"-"`
	PaymentIntentID string     `firestore:"payment_intent_id,omitempty" json:"-"`
	PaidWith        string     `firestore:"paid_with,omitempty" json:"-"`
	PaidCents       int64      `firestore:"paid_cents,omitempty" json:"-"`
	CustomerID      string     `firestore:"customer_id,omitempty" json:"-"`
	Lease           *Lease     `firestore:"lease,omitempty" json:"-"`
	Error           string     `firestore:"error,omitempty" json:"-"`
	ConversionID    string     `firestore:"conversion_id,omitempty" json:"-"` // the run waiting for this reload
	Attempt         int        `firestore:"attempt" json:"-"`
	CreatedAt       time.Time  `firestore:"created_at" json:"created_at"`
	UpdatedAt       time.Time  `firestore:"updated_at" json:"-"`
	PaidAt          *time.Time `firestore:"paid_at,omitempty" json:"paid_at,omitempty"`
}

func balancesCol(env string) string { return "balances_" + env }
func topupsCol(env string) string   { return "topups_" + env }

func (s *Store) balanceDoc(uid string) *firestore.DocumentRef {
	return s.fs.Collection(balancesCol(s.env)).Doc(uid)
}

func (s *Store) entryDoc(uid, id string) *firestore.DocumentRef {
	return s.balanceDoc(uid).Collection("entries").Doc(id)
}

func (s *Store) topupDoc(id string) *firestore.DocumentRef {
	return s.fs.Collection(topupsCol(s.env)).Doc(id)
}

func snapToBalance(uid string, snap *firestore.DocumentSnapshot) (*Balance, error) {
	if snap == nil || !snap.Exists() {
		return NewBalance(uid), nil
	}
	var b Balance
	if err := snap.DataTo(&b); err != nil {
		return nil, err
	}
	b.exists = true
	if b.Holds == nil {
		b.Holds = map[string]HoldRef{}
	}
	return &b, nil
}

func (s *Store) txBalance(tx *firestore.Transaction, uid string) (*Balance, error) {
	snap, err := tx.Get(s.balanceDoc(uid))
	if err != nil && status.Code(err) != codes.NotFound {
		return nil, err
	}
	return snapToBalance(uid, snap)
}

// GetBalance reads an account's balance (the defaults when it has none).
func (s *Store) GetBalance(ctx context.Context, uid string) (*Balance, error) {
	snap, err := s.balanceDoc(uid).Get(ctx)
	if err != nil && status.Code(err) != codes.NotFound {
		return nil, err
	}
	return snapToBalance(uid, snap)
}

// ------------------------------------------------------------ the ledger

// BalanceOp is one change to apply.
type BalanceOp struct {
	Kind          string
	Cents         int64
	ConversionID  string
	TopupID       string
	CaseID        string
	Ref           string
	Note          string
	PendingReload bool       // hold: waits for the in-flight reload
	Auto          bool       // topup: an auto-reload
	ExpiresAt     *time.Time // plan_credit: the period's end
	Restore       []FifoUse  // refund_to_balance: the items the run used
	EntryID       string     // a fixed id (once per PaymentIntent)
}

// ledger applies ops to a balance and records entries; then checks E0-8,
// the low-balance alert and the reload trigger.
type ledger struct {
	b       *Balance
	now     time.Time
	entries []Entry
	effects BalanceEffects
	// reloadIDs mints a top-up id for a reload the trigger starts.
	reloadID func() string
	newTopup *Topup
	// what the last settle op took (closeRunHold)
	lastSettled int64
	lastUsed    []FifoUse
}

func (l *ledger) add(e Entry) {
	e.At = l.now
	l.b.EntrySeq++
	e.Seq = l.b.EntrySeq
	if e.ID == "" {
		e.ID = fmt.Sprintf("%012d", l.b.EntrySeq)
	}
	l.b.BalanceCents += e.Delta
	e.BalanceAfter = l.b.BalanceCents
	l.entries = append(l.entries, e)
}

// consumeFifo takes cents from the non-cash items first, then the oldest
// top-up (N1, T12).
func (l *ledger) consumeFifo(cents int64) []FifoUse {
	sort.SliceStable(l.b.Fifo, func(i, j int) bool {
		a, b := l.b.Fifo[i], l.b.Fifo[j]
		if a.PlanCredit != b.PlanCredit {
			return a.PlanCredit // plan credit first, soonest to expire
		}
		if a.PlanCredit && a.ExpiresAt != nil && b.ExpiresAt != nil && !a.ExpiresAt.Equal(*b.ExpiresAt) {
			return a.ExpiresAt.Before(*b.ExpiresAt)
		}
		if (a.TopupID == "") != (b.TopupID == "") {
			return a.TopupID == ""
		}
		return a.At.Before(b.At)
	})
	var used []FifoUse
	for i := range l.b.Fifo {
		if cents <= 0 {
			break
		}
		take := min(cents, l.b.Fifo[i].spendable())
		if take <= 0 {
			continue
		}
		l.b.Fifo[i].RemainingCents -= take
		cents -= take
		used = append(used, FifoUse{TopupID: l.b.Fifo[i].TopupID, Cents: take})
	}
	keep := l.b.Fifo[:0]
	for _, it := range l.b.Fifo {
		if it.RemainingCents > 0 {
			keep = append(keep, it)
		}
	}
	l.b.Fifo = keep
	return used
}

func (l *ledger) restoreFifo(used []FifoUse, cents int64) {
	for _, u := range used {
		if cents <= 0 {
			break
		}
		give := min(u.Cents, cents)
		cents -= give
		found := false
		for i := range l.b.Fifo {
			if l.b.Fifo[i].TopupID == u.TopupID && u.TopupID != "" {
				l.b.Fifo[i].RemainingCents += give
				found = true
				break
			}
		}
		if !found {
			l.b.Fifo = append(l.b.Fifo, FifoItem{TopupID: u.TopupID, RemainingCents: give, At: l.now})
		}
	}
	if cents > 0 { // no record of what paid: a non-cash item
		l.b.Fifo = append(l.b.Fifo, FifoItem{RemainingCents: cents, At: l.now})
	}
}

func (l *ledger) month() {
	if m := l.now.Format("2006-01"); l.b.MonthKey != m {
		l.b.MonthKey, l.b.MonthSettled = m, 0
	}
}

func (l *ledger) day() {
	if d := l.now.Format("2006-01-02"); l.b.DayKey != d {
		l.b.DayKey, l.b.DayTopupCents, l.b.DayReloads = d, 0, 0
		if l.b.AutoReload.PausedReason == "limit" && l.b.AutoReload.PausedDay != d {
			l.b.AutoReload.PausedReason, l.b.AutoReload.PausedDay = "", ""
		}
	}
}

// expireReturned expires money that lands on an expired balance (R5).
func (l *ledger) expireReturned(cents int64, ref string) {
	if !l.b.Expired || cents <= 0 {
		return
	}
	used := l.consumeFifo(cents)
	l.add(Entry{Kind: EntryExpiry, Cents: cents, Delta: -cents, Ref: ref, FifoUsed: used})
}

func (l *ledger) apply(op BalanceOp) error {
	b := l.b
	switch op.Kind {
	case EntryTopup:
		if op.Cents <= 0 {
			return fmt.Errorf("topup of %d", op.Cents)
		}
		l.day()
		b.Fifo = append(b.Fifo, FifoItem{TopupID: op.TopupID, RemainingCents: op.Cents, At: l.now})
		l.add(Entry{ID: op.EntryID, Kind: EntryTopup, Cents: op.Cents, Delta: op.Cents, Ref: op.Ref, TopupID: op.TopupID, Auto: op.Auto})
		at, exp := l.now, l.now.Add(balanceLifetime)
		b.LastTopupAt, b.ExpiresAt, b.Expired, b.Notices = &at, &exp, false, nil
		b.DayTopupCents += op.Cents
		b.TopupCount++
		if b.ReloadInFlight != nil && b.ReloadInFlight.TopupID == op.TopupID {
			b.ReloadInFlight = nil
		}
		for id, h := range b.Holds { // pending_reload holds become normal
			if h.PendingReload && h.TopupID == op.TopupID {
				h.PendingReload, h.TopupID = false, ""
				b.Holds[id] = h
			}
		}
		if b.AutoReload.PausedReason == "declined" || b.AutoReload.PausedReason == "limit" {
			b.AutoReload.PausedReason = "" // a succeeded top-up clears a decline pause (T17)
		}
	case EntryHold:
		if _, ok := b.Holds[op.ConversionID]; ok {
			return nil // one hold per run
		}
		room := b.Available()
		if op.PendingReload && b.ReloadInFlight != nil && b.ReloadInFlight.TopupID == op.TopupID {
			room += b.ReloadInFlight.Cents // finish() checks the reload counts once
		}
		if op.Cents > room {
			return ErrInsufficientBalance
		}
		b.Holds[op.ConversionID] = HoldRef{Cents: op.Cents, PendingReload: op.PendingReload, TopupID: op.TopupID, At: l.now}
		b.HeldCents += op.Cents
		l.add(Entry{Kind: EntryHold, Cents: op.Cents, ConversionID: op.ConversionID, TopupID: op.TopupID})
	case EntrySettle, EntryRelease:
		h, ok := b.Holds[op.ConversionID]
		if !ok {
			return nil
		}
		settle := int64(0)
		if op.Kind == EntrySettle {
			settle = min(op.Cents, h.Cents)
		}
		delete(b.Holds, op.ConversionID)
		b.HeldCents -= h.Cents
		if settle > 0 {
			l.month()
			used := l.consumeFifo(settle)
			l.add(Entry{Kind: EntrySettle, Cents: settle, Delta: -settle, ConversionID: op.ConversionID, FifoUsed: used})
			b.MonthSettled += settle
			l.lastUsed = used
		}
		if rest := h.Cents - settle; rest > 0 {
			l.add(Entry{Kind: EntryRelease, Cents: rest, ConversionID: op.ConversionID})
			l.expireReturned(rest, "release:"+op.ConversionID)
		}
		l.lastSettled = settle
	case EntryDebtPayment:
		if op.Cents > b.Available() {
			return ErrInsufficientBalance
		}
		used := l.consumeFifo(op.Cents)
		l.month()
		l.add(Entry{ID: op.EntryID, Kind: EntryDebtPayment, Cents: op.Cents, Delta: -op.Cents, Ref: op.Ref, FifoUsed: used})
	case EntryRefundToBalance:
		l.restoreFifo(op.Restore, op.Cents)
		l.add(Entry{ID: op.EntryID, Kind: EntryRefundToBalance, Cents: op.Cents, Delta: op.Cents, ConversionID: op.ConversionID, CaseID: op.CaseID})
		if b.Expired { // R5: a refund reopens the balance for 12 months
			exp := l.now.Add(balanceLifetime)
			b.Expired, b.ExpiresAt, b.Notices = false, &exp, nil
		}
	case EntryExpiry:
		amount := b.Available()
		if amount < 0 {
			amount = 0
		}
		used := l.consumeFifo(amount)
		l.add(Entry{Kind: EntryExpiry, Cents: amount, Delta: -amount, FifoUsed: used})
		b.Expired = true
	case EntryAdjustment:
		if op.Cents >= 0 {
			b.Fifo = append(b.Fifo, FifoItem{RemainingCents: op.Cents, At: l.now}) // non-cash, spent first
		} else {
			if -op.Cents > b.Available() {
				return ErrInsufficientBalance
			}
			l.consumeFifo(-op.Cents)
		}
		l.add(Entry{ID: op.EntryID, Kind: EntryAdjustment, Cents: abs64(op.Cents), Delta: op.Cents, CaseID: op.CaseID, Note: op.Note})
		if op.Cents > 0 && b.Expired {
			exp := l.now.Add(balanceLifetime)
			b.Expired, b.ExpiresAt, b.Notices = false, &exp, nil
		}
	case EntryPlanCredit:
		// The new period's credit replaces what is left of the last one.
		l.expirePlanCredit(op.Ref, true)
		exp := op.ExpiresAt
		b.Fifo = append(b.Fifo, FifoItem{RemainingCents: op.Cents, At: l.now, PlanCredit: true, ExpiresAt: exp, Ref: op.Ref})
		l.add(Entry{ID: op.EntryID, Kind: EntryPlanCredit, Cents: op.Cents, Delta: op.Cents, Ref: op.Ref, Note: op.Note})
		b.Expired = false
	case EntryPlanCreditExpiry:
		l.expirePlanCredit("", false)
	case EntryPlanCreditFreeze:
		// The unheld, unfrozen plan credit (held credit stays for its run).
		room := max(b.Available(), 0)
		var amt int64
		for i := range b.Fifo {
			it := &b.Fifo[i]
			if !it.PlanCredit || room <= 0 {
				continue
			}
			take := min(it.spendable(), room)
			if take <= 0 {
				continue
			}
			it.FrozenCents += take
			if it.FrozenRef == "" {
				it.FrozenRef = op.Ref
			}
			room -= take
			amt += take
		}
		b.FrozenCents += amt
		l.add(Entry{ID: op.EntryID, Kind: EntryPlanCreditFreeze, Cents: amt, Ref: op.Ref, CaseID: op.CaseID, Note: op.Note})
	case EntryPlanCreditUnfreeze:
		// What op.Ref froze (a prefix: "dispute:du_1", "efw:", "block").
		var amt int64
		for i := range b.Fifo {
			it := &b.Fifo[i]
			if it.PlanCredit && it.FrozenCents > 0 && strings.HasPrefix(it.FrozenRef, op.Ref) {
				amt += it.FrozenCents
				it.FrozenCents, it.FrozenRef = 0, ""
			}
		}
		b.FrozenCents -= amt
		l.add(Entry{ID: op.EntryID, Kind: EntryPlanCreditUnfreeze, Cents: amt, Ref: op.Ref, CaseID: op.CaseID, Note: op.Note})
		l.expirePlanCredit("", false) // still gone at its period's end
	case EntryPlanCreditRemoval:
		// Every frozen part, and the unheld rest; never paid out.
		room := max(b.Available(), 0)
		var amt int64
		keep := b.Fifo[:0]
		for _, it := range b.Fifo {
			if it.PlanCredit {
				free := min(it.spendable(), room)
				room -= free
				take := it.FrozenCents + free
				b.FrozenCents -= it.FrozenCents
				it.RemainingCents -= take
				it.FrozenCents, it.FrozenRef = 0, ""
				amt += take
			}
			if it.RemainingCents > 0 {
				keep = append(keep, it)
			}
		}
		b.Fifo = keep
		l.add(Entry{ID: op.EntryID, Kind: EntryPlanCreditRemoval, Cents: amt, Delta: -amt, Ref: op.Ref, CaseID: op.CaseID, Note: op.Note})
	case EntryDisputeFreeze:
		amt := min(op.Cents, max(b.Available(), 0))
		b.FrozenCents += amt
		l.add(Entry{ID: op.EntryID, Kind: EntryDisputeFreeze, Cents: amt, Ref: op.Ref, TopupID: op.TopupID})
	case EntryDisputeUnfreeze:
		amt := min(op.Cents, b.FrozenCents)
		b.FrozenCents -= amt
		l.add(Entry{ID: op.EntryID, Kind: EntryDisputeUnfreeze, Cents: amt, Ref: op.Ref, TopupID: op.TopupID})
		l.expireReturned(amt, "unfreeze:"+op.Ref)
	case EntryDisputeLoss:
		amt := min(op.Cents, b.FrozenCents)
		b.FrozenCents -= amt
		l.consumeFifo(amt)
		l.add(Entry{ID: op.EntryID, Kind: EntryDisputeLoss, Cents: amt, Delta: -amt, Ref: op.Ref, TopupID: op.TopupID})
	case EntryCashRefund:
		if op.Cents > b.Available() {
			return ErrInsufficientBalance
		}
		// From the named top-up's unspent part when given (T11a).
		left := op.Cents
		if op.TopupID != "" {
			for i := range b.Fifo {
				if b.Fifo[i].TopupID == op.TopupID {
					take := min(left, b.Fifo[i].RemainingCents)
					b.Fifo[i].RemainingCents -= take
					left -= take
				}
			}
		}
		if left > 0 {
			l.consumeFifo(left)
		}
		l.add(Entry{ID: op.EntryID, Kind: EntryCashRefund, Cents: op.Cents, Delta: -op.Cents, Ref: op.Ref, TopupID: op.TopupID, CaseID: op.CaseID})
	default:
		return fmt.Errorf("unknown balance op %q", op.Kind)
	}
	return nil
}

func abs64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

// finish checks E0-8 and runs the alert and the reload trigger (R1).
func (l *ledger) finish(levelBefore int64) error {
	b := l.b
	if b.BalanceCents < 0 || b.BalanceCents+b.reloadTerm()-b.HeldCents-b.FrozenCents < 0 {
		return ErrInsufficientBalance
	}
	if b.HeldCents < 0 || b.FrozenCents < 0 {
		return fmt.Errorf("balance invariant: held %d frozen %d", b.HeldCents, b.FrozenCents)
	}
	avail := b.Available()
	l.effects.Available = avail
	// T15: one mail per crossing, re-armed above; quiet while a reload runs.
	switch {
	case avail >= b.LowBalanceCents:
		b.LowAlertArmed = true
	case b.LowAlertArmed && b.LastTopupAt != nil && !(b.AutoReload.Enabled && b.ReloadInFlight != nil):
		b.LowAlertArmed, l.effects.LowAlert = false, true
	}
	// R1: a downward crossing of X by balance − frozen, holds ignored.
	level := b.BalanceCents - b.FrozenCents
	ar := b.AutoReload
	if level >= ar.BelowCents {
		b.ReloadArmed = true
	} else if b.ReloadArmed && levelBefore >= ar.BelowCents && ar.Enabled && ar.PausedReason == "" && b.ReloadInFlight == nil {
		b.ReloadArmed = false
		l.startReload(ar.AddCents, "")
	}
	return nil
}

// startReload records a reload top-up (record before money) in the
// transaction; the caller charges it.
func (l *ledger) startReload(cents int64, convID string) {
	b := l.b
	l.day()
	if b.DayReloads >= MaxReloadsPerDay {
		b.AutoReload.PausedReason, b.AutoReload.PausedDay = "limit", l.now.Format("2006-01-02")
		return
	}
	b.DayReloads++
	id := l.reloadID()
	b.ReloadInFlight = &ReloadInFlight{TopupID: id, Cents: cents}
	l.newTopup = &Topup{ID: id, UID: b.UID, Cents: cents, Currency: "usd", State: TopupCharging, Auto: true,
		ConversionID: convID, CreatedAt: l.now, UpdatedAt: l.now}
	l.effects.ReloadTopupID = id
}

// commit writes the summary, the entries and any new reload record.
func (s *Store) commitLedger(tx *firestore.Transaction, l *ledger) error {
	l.b.UpdatedAt = l.now
	l.b.HasPlanCredit = l.b.PlanCreditCents() > 0
	for _, e := range l.entries {
		if err := tx.Create(s.entryDoc(l.b.UID, e.ID), e); err != nil {
			return err
		}
	}
	if l.newTopup != nil {
		if err := tx.Create(s.topupDoc(l.newTopup.ID), l.newTopup); err != nil {
			return err
		}
	}
	return tx.Set(s.balanceDoc(l.b.UID), l.b)
}

func (s *Store) newLedger(b *Balance) *ledger {
	return &ledger{b: b, now: time.Now().UTC(), reloadID: func() string { return "r" + NewID() }}
}

// BalanceTx applies ops chosen by decide (which may read b) in one
// transaction. decide returns the ops; an error aborts.
func (s *Store) BalanceTx(ctx context.Context, uid string, decide func(b *Balance) ([]BalanceOp, error)) (*Balance, BalanceEffects, error) {
	var out *Balance
	var fx BalanceEffects
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		b, err := s.txBalance(tx, uid)
		if err != nil {
			return err
		}
		ops, err := decide(b)
		if err != nil {
			return err
		}
		if len(ops) == 0 {
			out, fx = b, BalanceEffects{Available: b.Available()}
			return nil
		}
		l := s.newLedger(b)
		before := b.BalanceCents - b.FrozenCents
		for _, op := range ops {
			if op.EntryID != "" {
				if snap, gerr := tx.Get(s.entryDoc(uid, op.EntryID)); gerr == nil && snap.Exists() {
					continue // once per key (a PaymentIntent, a settle)
				}
			}
			if err := l.apply(op); err != nil {
				return err
			}
		}
		if err := l.finish(before); err != nil {
			return err
		}
		out, fx = b, l.effects
		return s.commitLedger(tx, l)
	})
	return out, fx, err
}

// ------------------------------------------------------- runs (N5, R3)

// CreateConversionWithHold writes a balance run and its hold in one
// transaction (N5 submit). reloadCents > 0 also starts a reload the run
// waits for (T8, R4): the hold is pending_reload.
func (s *Store) CreateConversionWithHold(ctx context.Context, c *Conversion, reloadCents int64) (BalanceEffects, error) {
	var fx BalanceEffects
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		if snap, gerr := tx.Get(s.convDoc(c.ID)); gerr == nil && snap.Exists() {
			return ErrAlreadyExists
		}
		b, err := s.txBalance(tx, c.UID)
		if err != nil {
			return err
		}
		l := s.newLedger(b)
		before := b.BalanceCents - b.FrozenCents
		op := BalanceOp{Kind: EntryHold, Cents: c.RunBalance.HoldCents, ConversionID: c.ID}
		if reloadCents > 0 {
			if b.ReloadInFlight != nil {
				op.TopupID, op.PendingReload = b.ReloadInFlight.TopupID, true // ride the reload already running
			} else {
				l.startReload(reloadCents, c.ID)
				if l.newTopup == nil {
					return ErrInsufficientBalance // the daily reload limit
				}
				op.TopupID, op.PendingReload = l.newTopup.ID, true
			}
			c.RunBalance.State, c.RunBalance.TopupID = HoldPendingReload, op.TopupID
		}
		if err := l.apply(op); err != nil {
			return err
		}
		if err := l.finish(before); err != nil {
			return err
		}
		now := time.Now().UTC()
		c.CreatedAt, c.UpdatedAt = now, now
		if err := tx.Create(s.convDoc(c.ID), c); err != nil {
			return err
		}
		fx = l.effects
		return s.commitLedger(tx, l)
	})
	return fx, err
}

// closeRunHold settles or releases a terminal balance run's hold inside
// the run's own transition (R3). Succeeded settles min(max(delivered, $1),
// hold) (R9); every other terminal state releases it all.
func (s *Store) closeRunHold(tx *firestore.Transaction, c *Conversion) (func() error, error) {
	rb := c.RunBalance
	if rb == nil || (rb.State != HoldHeld && rb.State != HoldPendingReload) || !IsTerminal(c.State) {
		return nil, nil
	}
	b, err := s.txBalance(tx, c.UID)
	if err != nil {
		return nil, err
	}
	l := s.newLedger(b)
	before := b.BalanceCents - b.FrozenCents
	op := BalanceOp{Kind: EntryRelease, ConversionID: c.ID}
	if c.State == StateSucceeded && rb.State == HoldHeld {
		amount := rb.SettleCents
		if amount <= 0 {
			amount = rb.HoldCents
		}
		op = BalanceOp{Kind: EntrySettle, Cents: min(max(amount, 100), rb.HoldCents), ConversionID: c.ID}
	}
	if err := l.apply(op); err != nil {
		return nil, err
	}
	if err := l.finish(before); err != nil {
		return nil, err
	}
	now := l.now
	rb.ClosedAt = &now
	if l.lastSettled > 0 {
		rb.State, rb.SettledCents, rb.FifoUsed = HoldSettled, l.lastSettled, l.lastUsed
	} else {
		rb.State = HoldReleased
	}
	rb.ReleasedCents = rb.HoldCents - rb.SettledCents
	rb.Effects = l.effects
	return func() error { return s.commitLedger(tx, l) }, nil
}

// ListOpenHoldRuns lists runs whose hold is still open (the R3 sweep
// keeps the terminal ones).
func (s *Store) ListOpenHoldRuns(ctx context.Context, limit int) ([]*Conversion, error) {
	iter := s.fs.Collection(conversionsCol(s.env)).Where("balance.state", "in", []string{HoldHeld, HoldPendingReload}).Limit(limit).Documents(ctx)
	return s.collect(iter)
}

// ------------------------------------------------------------- top-ups

// CreateTopup records a top-up before its payment.
func (s *Store) CreateTopup(ctx context.Context, t *Topup) error {
	now := time.Now().UTC()
	t.CreatedAt, t.UpdatedAt = now, now
	_, err := s.topupDoc(t.ID).Create(ctx, t)
	if status.Code(err) == codes.AlreadyExists {
		return ErrAlreadyExists
	}
	return err
}

func (s *Store) GetTopup(ctx context.Context, id string) (*Topup, error) {
	snap, err := s.topupDoc(id).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var t Topup
	if err := snap.DataTo(&t); err != nil {
		return nil, err
	}
	t.ID = snap.Ref.ID
	return &t, nil
}

// UpdateTopup mutates a top-up in a transaction.
func (s *Store) UpdateTopup(ctx context.Context, id string, mutate func(t *Topup) error) (*Topup, error) {
	var out *Topup
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.topupDoc(id))
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		var t Topup
		if err := snap.DataTo(&t); err != nil {
			return err
		}
		t.ID = id
		if err := mutate(&t); err != nil {
			return err
		}
		t.UpdatedAt = time.Now().UTC()
		out = &t
		return tx.Set(s.topupDoc(id), &t)
	})
	return out, err
}

// ListTopupsByState lists top-ups (sweeps).
func (s *Store) ListTopupsByState(ctx context.Context, state string, limit int) ([]*Topup, error) {
	iter := s.fs.Collection(topupsCol(s.env)).Where("state", "==", state).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*Topup
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		var t Topup
		if err := snap.DataTo(&t); err != nil {
			return nil, err
		}
		t.ID = snap.Ref.ID
		out = append(out, &t)
	}
}

// ListUserTopups lists an account's paid top-ups (history, daily cap).
func (s *Store) ListUserTopups(ctx context.Context, uid string, limit int) ([]*Topup, error) {
	iter := s.fs.Collection(topupsCol(s.env)).Where("uid", "==", uid).Where("state", "==", TopupPaid).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*Topup
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		var t Topup
		if err := snap.DataTo(&t); err != nil {
			return nil, err
		}
		t.ID = snap.Ref.ID
		out = append(out, &t)
	}
}

// ErrDuplicateTopupPayment: the top-up was already paid by another
// PaymentIntent; this one is extra (refund it, E0-2).
var ErrDuplicateTopupPayment = errors.New("top-up already paid by another payment")

// ApplyTopupPaid credits a paid top-up ONCE per PaymentIntent (E0-8.3):
// the top-up turns paid and the topup entry is written in one
// transaction. It returns the runs whose pending_reload holds became
// normal.
func (s *Store) ApplyTopupPaid(ctx context.Context, topupID, pi string, cents int64, paidWith string) (*Topup, []string, BalanceEffects, error) {
	var out *Topup
	var promoted []string
	var fx BalanceEffects
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		promoted = nil
		snap, err := tx.Get(s.topupDoc(topupID))
		if err != nil {
			return err
		}
		var t Topup
		if err := snap.DataTo(&t); err != nil {
			return err
		}
		t.ID = topupID
		if t.State == TopupPaid {
			out = &t
			if t.PaymentIntentID != pi {
				return ErrDuplicateTopupPayment
			}
			return nil
		}
		b, err := s.txBalance(tx, t.UID)
		if err != nil {
			return err
		}
		entryID := "topup_" + pi
		if es, gerr := tx.Get(s.entryDoc(t.UID, entryID)); gerr == nil && es.Exists() {
			return ErrDuplicateTopupPayment
		}
		for id, h := range b.Holds {
			if h.PendingReload && h.TopupID == topupID {
				promoted = append(promoted, id)
			}
		}
		l := s.newLedger(b)
		before := b.BalanceCents - b.FrozenCents
		if err := l.apply(BalanceOp{Kind: EntryTopup, Cents: cents, TopupID: topupID, Ref: pi, Auto: t.Auto, EntryID: entryID}); err != nil {
			return err
		}
		if err := l.finish(before); err != nil {
			return err
		}
		now := l.now
		t.State, t.PaymentIntentID, t.PaidCents, t.PaidWith, t.PaidAt, t.Lease, t.Error = TopupPaid, pi, cents, paidWith, &now, nil, ""
		t.UpdatedAt = now
		if err := tx.Set(s.topupDoc(topupID), &t); err != nil {
			return err
		}
		out, fx = &t, l.effects
		return s.commitLedger(tx, l)
	})
	return out, promoted, fx, err
}

// FailTopup ends a top-up unpaid. For a reload: in-flight cleared,
// auto-reload paused (reason), and its pending_reload holds released —
// the runs they belonged to are returned (they fall back to pay-as-you-go).
func (s *Store) FailTopup(ctx context.Context, topupID, reason, errMsg string) (*Topup, []string, error) {
	var out *Topup
	var released []string
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		released = nil
		snap, err := tx.Get(s.topupDoc(topupID))
		if err != nil {
			return err
		}
		var t Topup
		if err := snap.DataTo(&t); err != nil {
			return err
		}
		t.ID = topupID
		if t.State == TopupPaid || t.State == TopupFailed || t.State == TopupCanceled {
			out = &t
			return nil
		}
		b, err := s.txBalance(tx, t.UID)
		if err != nil {
			return err
		}
		l := s.newLedger(b)
		before := b.BalanceCents - b.FrozenCents
		if b.ReloadInFlight != nil && b.ReloadInFlight.TopupID == topupID {
			b.ReloadInFlight = nil
		}
		for id, h := range b.Holds {
			if h.PendingReload && h.TopupID == topupID {
				released = append(released, id)
			}
		}
		sort.Strings(released)
		for _, id := range released {
			if err := l.apply(BalanceOp{Kind: EntryRelease, ConversionID: id}); err != nil {
				return err
			}
		}
		if t.Auto && reason != "" {
			b.AutoReload.PausedReason = reason
			if reason == "limit" {
				b.AutoReload.PausedDay = l.now.Format("2006-01-02")
			}
		}
		if err := l.finish(before); err != nil {
			return err
		}
		t.State, t.Error, t.Lease, t.UpdatedAt = TopupFailed, errMsg, nil, l.now
		if !t.Auto {
			t.State = TopupCanceled
		}
		if err := tx.Set(s.topupDoc(topupID), &t); err != nil {
			return err
		}
		out = &t
		return s.commitLedger(tx, l)
	})
	return out, released, err
}

// ListEntries pages an account's ledger, newest first.
func (s *Store) ListEntries(ctx context.Context, uid string, limit int, startingAfter string) ([]Entry, bool, error) {
	q := s.balanceDoc(uid).Collection("entries").OrderBy("seq", firestore.Desc)
	if startingAfter != "" {
		snap, err := s.entryDoc(uid, startingAfter).Get(ctx)
		if err != nil {
			return nil, false, err
		}
		q = q.StartAfter(snap.Data()["seq"])
	}
	iter := q.Limit(limit + 1).Documents(ctx)
	defer iter.Stop()
	var out []Entry
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			break
		}
		if err != nil {
			return nil, false, err
		}
		var e Entry
		if err := snap.DataTo(&e); err != nil {
			return nil, false, err
		}
		e.ID = snap.Ref.ID
		out = append(out, e)
	}
	more := len(out) > limit
	if more {
		out = out[:limit]
	}
	return out, more, nil
}

// ListBalancesExpiringBy lists balances that expire before t and haven't
// expired (the expiry sweep and its notices).
func (s *Store) ListBalancesExpiringBy(ctx context.Context, t time.Time, limit int) ([]*Balance, error) {
	// One range filter (no composite index); expired ones are skipped here.
	iter := s.fs.Collection(balancesCol(s.env)).Where("expires_at", "<", t).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*Balance
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		b, err := snapToBalance(snap.Ref.ID, snap)
		if err != nil {
			return nil, err
		}
		if !b.Expired {
			out = append(out, b)
		}
	}
}

// MarkExpiryNotice records an expiry notice for the current expires_at;
// false when it was already sent.
func (s *Store) MarkExpiryNotice(ctx context.Context, uid, key string) (bool, error) {
	sent := false
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		b, err := s.txBalance(tx, uid)
		if err != nil {
			return err
		}
		if b.Notices[key] {
			sent = false
			return nil
		}
		if b.Notices == nil {
			b.Notices = map[string]bool{}
		}
		b.Notices[key], sent = true, true
		return tx.Set(s.balanceDoc(uid), b)
	})
	return sent, err
}

// EntryExists reports whether a keyed ledger entry was written.
func (s *Store) EntryExists(ctx context.Context, uid, id string) (bool, error) {
	snap, err := s.entryDoc(uid, id).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return snap.Exists(), nil
}

// expirePlanCredit removes plan credit that has run out (all of it when
// all): only what is available — credit reserved by holds stays until
// they end.
func (l *ledger) expirePlanCredit(ref string, all bool) {
	b := l.b
	room := max(b.Available(), 0)
	var gone int64
	keep := b.Fifo[:0]
	for _, it := range b.Fifo {
		due := it.PlanCredit && (all || (it.ExpiresAt != nil && !it.ExpiresAt.After(l.now)))
		if due && room > 0 {
			take := min(it.spendable(), room) // a frozen part waits for its dispute or block
			room -= take
			gone += take
			it.RemainingCents -= take
		}
		if it.RemainingCents > 0 {
			keep = append(keep, it)
		}
	}
	b.Fifo = keep
	if gone > 0 {
		l.add(Entry{Kind: EntryPlanCreditExpiry, Cents: gone, Delta: -gone, Ref: ref})
	}
}

// PlanCreditDue reports whether any plan credit has passed its end.
func (b *Balance) PlanCreditDue(now time.Time) bool {
	for _, it := range b.Fifo {
		if it.PlanCredit && it.ExpiresAt != nil && !it.ExpiresAt.After(now) && it.RemainingCents > 0 {
			return true
		}
	}
	return false
}

// PlanCreditCents is the unspent plan credit.
func (b *Balance) PlanCreditCents() int64 {
	var n int64
	for _, it := range b.Fifo {
		if it.PlanCredit {
			n += it.RemainingCents
		}
	}
	return n
}

// PlanCreditFrozen is the plan credit frozen by a dispute, a fraud
// warning or a block.
func (b *Balance) PlanCreditFrozen() int64 {
	var n int64
	for _, it := range b.Fifo {
		if it.PlanCredit {
			n += it.FrozenCents
		}
	}
	return n
}

// PlanCreditUnheld is the plan credit a freeze or removal reaches now:
// frozen parts plus what no in-flight run has reserved.
func (b *Balance) PlanCreditUnheld() int64 {
	return min(b.PlanCreditCents(), b.PlanCreditFrozen()+max(b.Available(), 0))
}

// CashCents is the unspent money from cash top-ups (what T11 can pay
// out).
func (b *Balance) CashCents() int64 {
	var n int64
	for _, it := range b.Fifo {
		if !it.PlanCredit && it.TopupID != "" {
			n += it.RemainingCents
		}
	}
	return n
}

// ListBalancesWithPlanCredit lists balances holding plan credit (the
// expiry sweep).
func (s *Store) ListBalancesWithPlanCredit(ctx context.Context, limit int) ([]*Balance, error) {
	iter := s.fs.Collection(balancesCol(s.env)).Where("has_plan_credit", "==", true).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*Balance
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		b, err := snapToBalance(snap.Ref.ID, snap)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
}

// RefundedToBalance sums what went back to the balance for a run.
func (s *Store) RefundedToBalance(ctx context.Context, uid, convID string) (int64, error) {
	iter := s.balanceDoc(uid).Collection("entries").Where("conversion_id", "==", convID).Documents(ctx)
	defer iter.Stop()
	var n int64
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return n, nil
		}
		if err != nil {
			return n, err
		}
		var e Entry
		if err := snap.DataTo(&e); err != nil {
			return n, err
		}
		if e.Kind == EntryRefundToBalance {
			n += e.Cents
		}
	}
}
