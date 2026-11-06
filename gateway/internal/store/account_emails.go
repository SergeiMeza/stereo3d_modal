package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Main and additional emails (design 2, owner 2026-11-06):
// account_emails_{env}/{EmailID(email)} holds one account per email; an
// account has at most MaxAccountEmails active ones and exactly one main
// (customers.email mirrors it, and Firebase's email is set to it).
// Released rows (an email removed, an account deleted) keep the old uid
// for support and Restore; a new account may claim a released email.
// account_email_events_{env} is the audit trail; email_syncs_{env} the
// pending Firebase/Stripe updates after a main switch.

const (
	MaxAccountEmails  = 5
	EmailActive       = "active"
	EmailReleased     = "released"
	EmailSyncPending  = "pending"
	EmailSyncDone     = "done"
	EmailSyncDrift    = "drift"
	RelayEmailDomain  = "privaterelay.appleid.com"
	emailIDSaltPrefix = "account-email:"
	emailSyncMaxTries = 5
)

var (
	ErrEmailTaken        = errors.New("email belongs to another account")
	ErrTooManyEmails     = errors.New("too many emails")
	ErrMainNotRemovable  = errors.New("the main email can't be removed")
	ErrEmailNotOnAccount = errors.New("email not on this account")
	ErrEmailRelayNotMain = errors.New("a relay address can't be the main email")
	ErrEmailUnverified   = errors.New("verify the email before making it main")
)

// AccountEmail is one email's row.
type AccountEmail struct {
	ID         string     `firestore:"-" json:"id"`
	Email      string     `firestore:"email" json:"email"`
	UID        string     `firestore:"uid" json:"-"`
	State      string     `firestore:"state" json:"-"`
	Main       bool       `firestore:"main" json:"main"`
	Verified   bool       `firestore:"verified" json:"-"`
	VerifiedAt *time.Time `firestore:"verified_at,omitempty" json:"-"`
	Source     string     `firestore:"source" json:"-"` // code | firebase | apple | google | backfill
	AddedAt    time.Time  `firestore:"added_at" json:"added_at"`
	ReleasedAt *time.Time `firestore:"released_at,omitempty" json:"-"`
	// SupportCase / SupportNote: a support marker on the row (e.g.
	// duplicate_email: two Firebase users share it), for the console.
	SupportCase string `firestore:"support_case,omitempty" json:"-"`
	SupportNote string `firestore:"support_note,omitempty" json:"-"`
}

// Relay: an Apple private relay address.
func (e *AccountEmail) Relay() bool { return IsRelayEmail(e.Email) }

// IsRelayEmail: an @privaterelay.appleid.com address.
func IsRelayEmail(email string) bool {
	return strings.HasSuffix(strings.ToLower(strings.TrimSpace(email)), "@"+RelayEmailDomain)
}

// EmailID is an email's document id (a hash: ids carry no addresses).
func EmailID(email string) string {
	sum := sha256.Sum256([]byte(emailIDSaltPrefix + strings.ToLower(strings.TrimSpace(email))))
	return hex.EncodeToString(sum[:16])
}

// EmailTakenError names the account holding an email.
type EmailTakenError struct{ UID string }

func (e *EmailTakenError) Error() string { return ErrEmailTaken.Error() }
func (e *EmailTakenError) Unwrap() error { return ErrEmailTaken }

// EmailSync is a main switch still to reach Firebase and Stripe.
type EmailSync struct {
	ID        string    `firestore:"-"`
	UID       string    `firestore:"uid"`
	Email     string    `firestore:"email"`
	Previous  string    `firestore:"previous,omitempty"`
	State     string    `firestore:"state"`
	Tries     int       `firestore:"tries"`
	Error     string    `firestore:"error,omitempty"`
	CreatedAt time.Time `firestore:"created_at"`
	UpdatedAt time.Time `firestore:"updated_at"`
}

// EmailEvent is one audit row.
type EmailEvent struct {
	UID     string    `firestore:"uid"`
	EmailID string    `firestore:"email_id"`
	Kind    string    `firestore:"kind"` // added | main | released | claimed | sync_done | sync_drift
	Who     string    `firestore:"who"`
	At      time.Time `firestore:"at"`
}

func accountEmailsCol(env string) string { return "account_emails_" + env }
func emailEventsCol(env string) string   { return "account_email_events_" + env }
func emailSyncsCol(env string) string    { return "email_syncs_" + env }

func (s *Store) emailRef(email string) *firestore.DocumentRef {
	return s.fs.Collection(accountEmailsCol(s.env)).Doc(EmailID(email))
}

func emailOf(snap *firestore.DocumentSnapshot) (*AccountEmail, error) {
	var e AccountEmail
	if err := snap.DataTo(&e); err != nil {
		return nil, err
	}
	e.ID = snap.Ref.ID
	return &e, nil
}

// GetAccountEmail is an email's row (ErrNotFound when none).
func (s *Store) GetAccountEmail(ctx context.Context, email string) (*AccountEmail, error) {
	snap, err := s.emailRef(email).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return emailOf(snap)
}

// EmailOwner is the uid an active email belongs to ("" when none).
func (s *Store) EmailOwner(ctx context.Context, email string) (string, error) {
	e, err := s.GetAccountEmail(ctx, email)
	if errors.Is(err, ErrNotFound) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if e.State != EmailActive {
		return "", nil
	}
	return e.UID, nil
}

// ListAccountEmails is an account's active emails, main first.
func (s *Store) ListAccountEmails(ctx context.Context, uid string) ([]*AccountEmail, error) {
	snaps, err := s.fs.Collection(accountEmailsCol(s.env)).Where("uid", "==", uid).Where("state", "==", EmailActive).
		Limit(MaxAccountEmails * 2).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	return sortedEmails(snaps)
}

// ListEmailHistory is every row an account ever held (released ones too;
// support and Restore).
func (s *Store) ListEmailHistory(ctx context.Context, uid string) ([]*AccountEmail, error) {
	snaps, err := s.fs.Collection(accountEmailsCol(s.env)).Where("uid", "==", uid).Limit(50).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	return sortedEmails(snaps)
}

func sortedEmails(snaps []*firestore.DocumentSnapshot) ([]*AccountEmail, error) {
	out := make([]*AccountEmail, 0, len(snaps))
	for _, sn := range snaps {
		e, err := emailOf(sn)
		if err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	// main first, then oldest
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && less(out[j], out[j-1]); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	return out, nil
}

func less(a, b *AccountEmail) bool {
	if a.Main != b.Main {
		return a.Main
	}
	return a.AddedAt.Before(b.AddedAt)
}

// AddEmailSpec is one email to put on an account.
type AddEmailSpec struct {
	UID, Email, Source, Who string
	Verified                bool
	// Main: make it the main email (the others lose it). An account's
	// first email is main whatever this says.
	Main bool
	// MainIfNone: main only when the account has no main yet.
	MainIfNone bool
	// RelayNotMain refuses a relay address as main (a plan account).
	RelayNotMain bool
	// Claim records the account's Firebase email as it is: becoming main
	// queues no sync (Firebase already has it).
	Claim bool
	At    time.Time
}

// AddAccountEmailResult says what happened.
type AddAccountEmailResult struct {
	Email        *AccountEmail
	BecameMain   bool
	PreviousMain string
	Existed      bool // already on this account
	SyncID       string
}

// AddAccountEmail puts an email on an account in one transaction: an
// email active on another account is refused (EmailTakenError); at most
// MaxAccountEmails; a new main unsets the old one and queues the Firebase
// and Stripe update (email_syncs).
func (s *Store) AddAccountEmail(ctx context.Context, spec AddEmailSpec) (*AddAccountEmailResult, error) {
	email := strings.ToLower(strings.TrimSpace(spec.Email))
	at := spec.At
	if at.IsZero() {
		at = time.Now().UTC()
	}
	ref := s.emailRef(email)
	res := &AddAccountEmailResult{}
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		*res = AddAccountEmailResult{}
		snap, err := tx.Get(ref)
		var current *AccountEmail
		if err == nil {
			if current, err = emailOf(snap); err != nil {
				return err
			}
		} else if status.Code(err) != codes.NotFound {
			return err
		}
		if current != nil && current.State == EmailActive && current.UID != spec.UID {
			return &EmailTakenError{UID: current.UID}
		}
		mine, err := tx.Documents(s.fs.Collection(accountEmailsCol(s.env)).Where("uid", "==", spec.UID).
			Where("state", "==", EmailActive).Limit(MaxAccountEmails * 2)).GetAll()
		if err != nil {
			return err
		}
		var oldMain *firestore.DocumentSnapshot
		for _, m := range mine {
			if main, _ := m.Data()["main"].(bool); main && m.Ref.ID != ref.ID {
				oldMain = m
			}
		}
		existed := current != nil && current.State == EmailActive && current.UID == spec.UID
		if !existed && len(mine) >= MaxAccountEmails {
			return ErrTooManyEmails
		}
		makeMain := spec.Main || len(mine) == 0 || (spec.MainIfNone && oldMain == nil && !(existed && current.Main))
		if existed && current.Main {
			makeMain = false // already main
		}
		if makeMain && spec.RelayNotMain && IsRelayEmail(email) {
			return ErrEmailRelayNotMain
		}
		row := &AccountEmail{Email: email, UID: spec.UID, State: EmailActive, Source: spec.Source, AddedAt: at,
			Verified: spec.Verified, Main: makeMain}
		if existed {
			row = current
			row.Verified = row.Verified || spec.Verified
			row.Main = row.Main || makeMain
		}
		if row.Verified && row.VerifiedAt == nil {
			row.VerifiedAt = &at
		}
		if err := tx.Set(ref, row); err != nil {
			return err
		}
		res.Email, res.Existed = row, existed
		if makeMain {
			res.BecameMain = true
			if oldMain != nil {
				res.PreviousMain, _ = oldMain.Data()["email"].(string)
				if err := tx.Update(oldMain.Ref, []firestore.Update{{Path: "main", Value: false}}); err != nil {
					return err
				}
			}
			if !spec.Claim {
				sref := s.fs.Collection(emailSyncsCol(s.env)).NewDoc()
				res.SyncID = sref.ID
				if err := tx.Create(sref, &EmailSync{UID: spec.UID, Email: email, Previous: res.PreviousMain, State: EmailSyncPending,
					CreatedAt: at, UpdatedAt: at}); err != nil {
					return err
				}
			}
		}
		kind := "added"
		if existed {
			kind = "claimed"
		}
		return tx.Create(s.fs.Collection(emailEventsCol(s.env)).NewDoc(), &EmailEvent{UID: spec.UID, EmailID: ref.ID, Kind: kind, Who: spec.Who, At: at})
	})
	if err != nil {
		return nil, err
	}
	res.Email.ID = ref.ID
	return res, nil
}

// SetMainEmail makes an account's email (by id) its main one and queues
// the sync; relayNotMain refuses a relay address.
func (s *Store) SetMainEmail(ctx context.Context, uid, id, who string, relayNotMain bool) (*AddAccountEmailResult, error) {
	ref := s.fs.Collection(accountEmailsCol(s.env)).Doc(id)
	res := &AddAccountEmailResult{}
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		*res = AddAccountEmailResult{}
		snap, err := tx.Get(ref)
		if status.Code(err) == codes.NotFound {
			return ErrEmailNotOnAccount
		}
		if err != nil {
			return err
		}
		e, err := emailOf(snap)
		if err != nil {
			return err
		}
		if e.UID != uid || e.State != EmailActive {
			return ErrEmailNotOnAccount
		}
		res.Email, res.Existed = e, true
		if e.Main {
			return nil
		}
		if relayNotMain && e.Relay() {
			return ErrEmailRelayNotMain
		}
		if !e.Verified {
			return ErrEmailUnverified
		}
		mine, err := tx.Documents(s.fs.Collection(accountEmailsCol(s.env)).Where("uid", "==", uid).
			Where("state", "==", EmailActive).Limit(MaxAccountEmails * 2)).GetAll()
		if err != nil {
			return err
		}
		now := time.Now().UTC()
		for _, m := range mine {
			if main, _ := m.Data()["main"].(bool); main {
				res.PreviousMain, _ = m.Data()["email"].(string)
				if err := tx.Update(m.Ref, []firestore.Update{{Path: "main", Value: false}}); err != nil {
					return err
				}
			}
		}
		if err := tx.Update(ref, []firestore.Update{{Path: "main", Value: true}}); err != nil {
			return err
		}
		e.Main, res.BecameMain = true, true
		sref := s.fs.Collection(emailSyncsCol(s.env)).NewDoc()
		res.SyncID = sref.ID
		if err := tx.Create(sref, &EmailSync{UID: uid, Email: e.Email, Previous: res.PreviousMain, State: EmailSyncPending, CreatedAt: now, UpdatedAt: now}); err != nil {
			return err
		}
		return tx.Create(s.fs.Collection(emailEventsCol(s.env)).NewDoc(), &EmailEvent{UID: uid, EmailID: id, Kind: "main", Who: who, At: now})
	})
	if err != nil {
		return nil, err
	}
	return res, nil
}

// ReleaseAccountEmail removes an additional email from its account (the
// main one can't go).
func (s *Store) ReleaseAccountEmail(ctx context.Context, uid, id, who string) error {
	ref := s.fs.Collection(accountEmailsCol(s.env)).Doc(id)
	return s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(ref)
		if status.Code(err) == codes.NotFound {
			return ErrEmailNotOnAccount
		}
		if err != nil {
			return err
		}
		e, err := emailOf(snap)
		if err != nil {
			return err
		}
		if e.UID != uid || e.State != EmailActive {
			return ErrEmailNotOnAccount
		}
		if e.Main {
			return ErrMainNotRemovable
		}
		now := time.Now().UTC()
		if err := tx.Update(ref, []firestore.Update{{Path: "state", Value: EmailReleased}, {Path: "released_at", Value: now}}); err != nil {
			return err
		}
		return tx.Create(s.fs.Collection(emailEventsCol(s.env)).NewDoc(), &EmailEvent{UID: uid, EmailID: id, Kind: "released", Who: who, At: now})
	})
}

// ReleaseAllAccountEmails releases every email of a deleted account (the
// rows keep its uid for support and Restore).
func (s *Store) ReleaseAllAccountEmails(ctx context.Context, uid, who string) (int, error) {
	mine, err := s.ListAccountEmails(ctx, uid)
	if err != nil {
		return 0, err
	}
	now := time.Now().UTC()
	n := 0
	for _, e := range mine {
		if _, err := s.fs.Collection(accountEmailsCol(s.env)).Doc(e.ID).Update(ctx, []firestore.Update{
			{Path: "state", Value: EmailReleased}, {Path: "released_at", Value: now}}); err != nil {
			return n, err
		}
		_, _, _ = s.fs.Collection(emailEventsCol(s.env)).Add(ctx, &EmailEvent{UID: uid, EmailID: e.ID, Kind: "released", Who: who, At: now})
		n++
	}
	return n, nil
}

// ListPendingEmailSyncs is the main switches still to reach Firebase.
func (s *Store) ListPendingEmailSyncs(ctx context.Context, limit int) ([]*EmailSync, error) {
	snaps, err := s.fs.Collection(emailSyncsCol(s.env)).Where("state", "==", EmailSyncPending).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]*EmailSync, 0, len(snaps))
	for _, sn := range snaps {
		var e EmailSync
		if sn.DataTo(&e) == nil {
			e.ID = sn.Ref.ID
			out = append(out, &e)
		}
	}
	return out, nil
}

// FinishEmailSync records a sync's try: done, or one more failure (drift
// after emailSyncMaxTries). It answers the new state.
func (s *Store) FinishEmailSync(ctx context.Context, id string, failure string) (string, error) {
	ref := s.fs.Collection(emailSyncsCol(s.env)).Doc(id)
	state := EmailSyncDone
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(ref)
		if err != nil {
			return err
		}
		var e EmailSync
		if err := snap.DataTo(&e); err != nil {
			return err
		}
		now := time.Now().UTC()
		ups := []firestore.Update{{Path: "updated_at", Value: now}}
		if failure == "" {
			state = EmailSyncDone
			ups = append(ups, firestore.Update{Path: "state", Value: EmailSyncDone}, firestore.Update{Path: "error", Value: ""})
		} else {
			state = EmailSyncPending
			if e.Tries+1 >= emailSyncMaxTries {
				state = EmailSyncDrift
			}
			ups = append(ups, firestore.Update{Path: "tries", Value: e.Tries + 1}, firestore.Update{Path: "error", Value: failure},
				firestore.Update{Path: "state", Value: state})
		}
		return tx.Update(ref, ups)
	})
	return state, err
}

// IsEmailTaken reports an EmailTakenError and its owner.
func IsEmailTaken(err error) (string, bool) {
	var t *EmailTakenError
	if errors.As(err, &t) {
		return t.UID, true
	}
	return "", false
}

// SearchAccountEmails is up to limit email rows starting with prefix
// (lowercased), released ones included (the console's search).
func (s *Store) SearchAccountEmails(ctx context.Context, prefix string, limit int) ([]*AccountEmail, error) {
	p := strings.ToLower(strings.TrimSpace(prefix))
	snaps, err := s.fs.Collection(accountEmailsCol(s.env)).Where("email", ">=", p).Where("email", "<=", p+"").
		Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]*AccountEmail, 0, len(snaps))
	for _, sn := range snaps {
		if e, err := emailOf(sn); err == nil {
			out = append(out, e)
		}
	}
	return out, nil
}

// PutReleasedEmail records a deleted account's email as released when the
// email has no row yet (the EM-01 backfill); it answers whether it wrote.
func (s *Store) PutReleasedEmail(ctx context.Context, uid, email string, at time.Time) (bool, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	_, err := s.emailRef(email).Create(ctx, &AccountEmail{Email: email, UID: uid, State: EmailReleased, Main: true, Source: "backfill",
		AddedAt: at, ReleasedAt: &at})
	if status.Code(err) == codes.AlreadyExists {
		return false, nil
	}
	return err == nil, err
}

// EachCustomer calls fn with every customer record (the EM-01 backfill).
func (s *Store) EachCustomer(ctx context.Context, fn func(uid string, c *Customer) error) error {
	it := s.fs.Collection(customersCol(s.env)).Documents(ctx)
	defer it.Stop()
	for {
		sn, err := it.Next()
		if err == iterator.Done {
			return nil
		}
		if err != nil {
			return err
		}
		var c Customer
		if sn.DataTo(&c) != nil {
			continue
		}
		if err := fn(sn.Ref.ID, &c); err != nil {
			return err
		}
	}
}

// MarkEmailSupportCase puts a support marker on an email's row (the
// console shows it); an empty kind clears it.
func (s *Store) MarkEmailSupportCase(ctx context.Context, email, kind, note string) error {
	_, err := s.emailRef(email).Update(ctx, []firestore.Update{{Path: "support_case", Value: kind}, {Path: "support_note", Value: note}})
	return err
}
