package store

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Consent is the record of a saved payment method's agreement (C3): who,
// which method, which text, when, from where, through which session.
type Consent struct {
	UID           string    `firestore:"uid"`
	PaymentMethod string    `firestore:"payment_method"`
	TextVersion   string    `firestore:"text_version"`
	SessionID     string    `firestore:"session_id,omitempty"`
	IP            string    `firestore:"ip,omitempty"`
	At            time.Time `firestore:"at"`
}

func consentsCol(env string) string { return "consents_" + env }

// RecordConsent writes one consent record, keyed by the method (a later
// save of the same method overwrites it with the newer agreement).
func (s *Store) RecordConsent(ctx context.Context, c Consent) error {
	_, err := s.fs.Collection(consentsCol(s.env)).Doc(c.UID+"_"+c.PaymentMethod).Set(ctx, c)
	return err
}

func mailsCol(env string) string { return "mails_" + env }

// ClaimMail reserves a customer mail by key (deduped: a retried event
// never mails twice). false when it was already claimed. A mail left
// deferred (DeferMail) is claimed once, by whoever gets there first.
func (s *Store) ClaimMail(ctx context.Context, key, uid, kind string) (bool, error) {
	ref := s.fs.Collection(mailsCol(s.env)).Doc(key)
	_, err := ref.Create(ctx, map[string]any{
		"uid": uid, "kind": kind, "claimed_at": time.Now().UTC(),
	})
	if status.Code(err) != codes.AlreadyExists {
		return err == nil, err
	}
	claimed := false
	err = s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		claimed = false
		snap, err := tx.Get(ref)
		if err != nil {
			return err
		}
		if st, _ := snap.DataAt("state"); st != MailDeferred {
			return nil
		}
		claimed = true
		return tx.Update(ref, []firestore.Update{{Path: "state", Value: firestore.Delete}, {Path: "claimed_at", Value: time.Now().UTC()}})
	})
	return claimed, err
}

// MailDeferred marks a mail waiting to be sent (DeferMail).
const MailDeferred = "deferred"

// DeferredMail is a mail waiting for a fact (E1: the payment's currency)
// or its due time.
type DeferredMail struct {
	Key          string    `firestore:"-"`
	UID          string    `firestore:"uid"`
	Kind         string    `firestore:"kind"`
	ConversionID string    `firestore:"conversion_id,omitempty"`
	DueAt        time.Time `firestore:"due_at"`
}

// DeferMail records that the mail under key waits until due (or until
// whoever learns the missing fact sends it). false when the key was
// already claimed or deferred.
func (s *Store) DeferMail(ctx context.Context, key, uid, kind, conversionID string, due time.Time) (bool, error) {
	_, err := s.fs.Collection(mailsCol(s.env)).Doc(key).Create(ctx, map[string]any{
		"uid": uid, "kind": kind, "state": MailDeferred, "conversion_id": conversionID, "due_at": due.UTC(),
	})
	if status.Code(err) == codes.AlreadyExists {
		return false, nil
	}
	return err == nil, err
}

// MailDeferred reports whether the mail under key is waiting (deferred).
func (s *Store) MailDeferred(ctx context.Context, key string) bool {
	snap, err := s.fs.Collection(mailsCol(s.env)).Doc(key).Get(ctx)
	if err != nil {
		return false
	}
	st, _ := snap.DataAt("state")
	return st == MailDeferred
}

// ListDeferredMailsFor lists uid's deferred mails of kind (due or not).
func (s *Store) ListDeferredMailsFor(ctx context.Context, uid, kind string, limit int) ([]*DeferredMail, error) {
	docs, err := s.fs.Collection(mailsCol(s.env)).Where("uid", "==", uid).Where("state", "==", MailDeferred).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	var out []*DeferredMail
	for _, d := range docs {
		var m DeferredMail
		if d.DataTo(&m) != nil || m.Kind != kind {
			continue
		}
		m.Key = d.Ref.ID
		out = append(out, &m)
	}
	return out, nil
}

// ListDueDeferredMails lists deferred mails due by now.
func (s *Store) ListDueDeferredMails(ctx context.Context, now time.Time, limit int) ([]*DeferredMail, error) {
	docs, err := s.fs.Collection(mailsCol(s.env)).Where("state", "==", MailDeferred).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	var out []*DeferredMail
	for _, d := range docs {
		var m DeferredMail
		if d.DataTo(&m) != nil || m.DueAt.After(now) {
			continue
		}
		m.Key = d.Ref.ID
		out = append(out, &m)
	}
	return out, nil
}

// MarkMail records a claimed mail's outcome.
func (s *Store) MarkMail(ctx context.Context, key, outcome string) {
	_, _ = s.fs.Collection(mailsCol(s.env)).Doc(key).Set(ctx, map[string]any{
		"outcome": outcome, "at": time.Now().UTC(),
	}, firestore.MergeAll)
}

// Handoff is a run's "pay on another device" code (B17):
// handoffs_{env}/{code}.
type Handoff struct {
	Code         string    `firestore:"-"`
	ConversionID string    `firestore:"conversion_id"`
	UID          string    `firestore:"uid"`
	Email        string    `firestore:"email,omitempty"`
	State        string    `firestore:"state"` // waiting | paying
	CreatedAt    time.Time `firestore:"created_at"`
	UpdatedAt    time.Time `firestore:"updated_at"`
}

func handoffsCol(env string) string { return "handoffs_" + env }

// CreateHandoff writes a new code; ErrAlreadyExists on a collision.
func (s *Store) CreateHandoff(ctx context.Context, h *Handoff) error {
	h.CreatedAt = time.Now().UTC()
	h.UpdatedAt = h.CreatedAt
	_, err := s.fs.Collection(handoffsCol(s.env)).Doc(h.Code).Create(ctx, h)
	if status.Code(err) == codes.AlreadyExists {
		return ErrAlreadyExists
	}
	return err
}

// GetHandoff reads a code.
func (s *Store) GetHandoff(ctx context.Context, code string) (*Handoff, error) {
	snap, err := s.fs.Collection(handoffsCol(s.env)).Doc(code).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var h Handoff
	if err := snap.DataTo(&h); err != nil {
		return nil, err
	}
	h.Code = code
	return &h, nil
}

// SetHandoffState updates a code's state.
func (s *Store) SetHandoffState(ctx context.Context, code, state string) {
	_, _ = s.fs.Collection(handoffsCol(s.env)).Doc(code).Set(ctx, map[string]any{
		"state": state, "updated_at": time.Now().UTC(),
	}, firestore.MergeAll)
}
