package store

import (
	"context"
	"time"
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
