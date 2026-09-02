package store

import (
	"context"
	"errors"
	"fmt"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func batchesCol(env string) string { return "billing_batches_" + env }

func (s *Store) batchDoc(id string) *firestore.DocumentRef {
	return s.fs.Collection(batchesCol(s.env)).Doc(id)
}

var ErrNotBatchable = errors.New("conversion is not awaiting an automatic charge")

func (s *Store) GetBatch(ctx context.Context, id string) (*Batch, error) {
	snap, err := s.batchDoc(id).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return snapToBatch(snap)
}

func snapToBatch(snap *firestore.DocumentSnapshot) (*Batch, error) {
	var b Batch
	if err := snap.DataTo(&b); err != nil {
		return nil, err
	}
	b.ID = snap.Ref.ID
	return &b, nil
}

func (s *Store) collectBatches(iter *firestore.DocumentIterator) ([]*Batch, error) {
	var out []*Batch
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		b, err := snapToBatch(snap)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}
}

func (s *Store) ListBatchesByState(ctx context.Context, state string, limit int) ([]*Batch, error) {
	iter := s.fs.Collection(batchesCol(s.env)).
		Where("state", "==", state).Limit(limit).Documents(ctx)
	return s.collectBatches(iter)
}

func (s *Store) ListUserBatchesByState(ctx context.Context, uid, state string, limit int) ([]*Batch, error) {
	iter := s.fs.Collection(batchesCol(s.env)).
		Where("uid", "==", uid).Where("state", "==", state).Limit(limit).Documents(ctx)
	return s.collectBatches(iter)
}

// BatchConversion folds a succeeded auto-mode conversion (pi_status
// charge_pending) into the user's open billing batch, opening one when
// none exists, in ONE transaction across the customer pointer, the batch
// and the conversion. The conversion becomes pi_status=batched with
// Stripe.BatchID set. If the appended total reaches capCents the batch is
// closed in the same transaction (state=charging, reason cap) and the
// caller must charge it. Re-running for an already batched conversion
// returns its batch unchanged (ErrNotBatchable is returned when the
// conversion is not in the charge_pending state at all).
func (s *Store) BatchConversion(ctx context.Context, conversionID string, item BatchItem, window time.Duration, capCents int64) (*Batch, error) {
	var result *Batch
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		convRef := s.convDoc(conversionID)
		convSnap, err := tx.Get(convRef)
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		conv, err := snapToConversion(convSnap)
		if err != nil {
			return err
		}
		if conv.State != StateSucceeded || conv.Stripe.Mode != BillingModeAuto {
			return ErrNotBatchable
		}
		if conv.Stripe.PIStatus == PIBatched && conv.Stripe.BatchID != "" {
			snap, gerr := tx.Get(s.batchDoc(conv.Stripe.BatchID))
			if gerr != nil {
				return gerr
			}
			result, err = snapToBatch(snap)
			return err
		}
		if conv.Stripe.PIStatus != PIChargePending {
			return ErrNotBatchable
		}

		custRef := s.fs.Collection(customersCol(s.env)).Doc(conv.UID)
		custSnap, err := tx.Get(custRef)
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		var cust Customer
		if err := custSnap.DataTo(&cust); err != nil {
			return err
		}

		now := time.Now().UTC()
		var batch *Batch
		if cust.OpenBatchID != "" {
			snap, gerr := tx.Get(s.batchDoc(cust.OpenBatchID))
			if gerr != nil && status.Code(gerr) != codes.NotFound {
				return gerr
			}
			if gerr == nil {
				if b, berr := snapToBatch(snap); berr == nil && b.State == BatchOpen {
					batch = b
				}
			}
		}
		if batch == nil {
			batch = &Batch{
				ID:        NewID(),
				UID:       conv.UID,
				Env:       s.env,
				State:     BatchOpen,
				Currency:  conv.Quote.Currency,
				CapCents:  capCents,
				OpenedAt:  now,
				DueAt:     now.Add(window),
				CreatedAt: now,
			}
			cust.OpenBatchID = batch.ID
		}
		for _, it := range batch.Items {
			if it.ConversionID == conversionID {
				return fmt.Errorf("%w: conversion %s already in batch %s", ErrStateConflict, conversionID, batch.ID)
			}
		}
		item.AddedAt = now
		batch.Items = append(batch.Items, item)
		batch.TotalCents += item.AmountCents
		batch.UpdatedAt = now
		if batch.TotalCents >= batch.CapCents {
			batch.State = BatchCharging
			batch.ClosedAt = &now
			batch.CloseReason = BatchCloseCap
			cust.OpenBatchID = ""
		}

		conv.Stripe.PIStatus = PIBatched
		conv.Stripe.BatchID = batch.ID
		conv.UpdatedAt = now

		if err := tx.Set(s.batchDoc(batch.ID), batch); err != nil {
			return err
		}
		if err := tx.Set(custRef, &cust); err != nil {
			return err
		}
		result = batch
		return tx.Set(convRef, conv)
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// CloseBatch moves the user's OPEN batch to charging (window elapsed or
// pay-now) and clears the customer's open pointer when it points at it.
// ErrStateConflict when the batch is no longer open (a concurrent close).
func (s *Store) CloseBatch(ctx context.Context, id, reason string) (*Batch, error) {
	var result *Batch
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.batchDoc(id))
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		b, err := snapToBatch(snap)
		if err != nil {
			return err
		}
		if b.State != BatchOpen {
			return fmt.Errorf("%w: batch %s is %s", ErrStateConflict, id, b.State)
		}
		custRef := s.fs.Collection(customersCol(s.env)).Doc(b.UID)
		custSnap, err := tx.Get(custRef)
		if err != nil && status.Code(err) != codes.NotFound {
			return err
		}
		now := time.Now().UTC()
		b.State = BatchCharging
		b.ClosedAt = &now
		b.CloseReason = reason
		b.UpdatedAt = now
		if err == nil {
			var cust Customer
			if derr := custSnap.DataTo(&cust); derr != nil {
				return derr
			}
			if cust.OpenBatchID == id {
				cust.OpenBatchID = ""
				if serr := tx.Set(custRef, &cust); serr != nil {
					return serr
				}
			}
		}
		result = b
		return tx.Set(s.batchDoc(id), b)
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// ExtendBatchDue pushes an OPEN batch's window out by another window from
// now (a tab below the Stripe minimum rolls over instead of closing).
// ErrStateConflict when the batch is no longer open.
func (s *Store) ExtendBatchDue(ctx context.Context, id string, window time.Duration) (*Batch, error) {
	var result *Batch
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.batchDoc(id))
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		b, err := snapToBatch(snap)
		if err != nil {
			return err
		}
		if b.State != BatchOpen {
			return fmt.Errorf("%w: batch %s is %s", ErrStateConflict, id, b.State)
		}
		now := time.Now().UTC()
		b.DueAt = now.Add(window)
		b.UpdatedAt = now
		result = b
		return tx.Set(s.batchDoc(id), b)
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// TransitionBatch atomically mutates a batch that is in one of fromStates,
// and applies convMutate to EVERY conversion in the batch in the same
// transaction (nil to leave them alone) — a batch settling to paid or
// failed must move its conversions with it, so the per-conversion gates
// (downloads, delinquency) never disagree with the ledger. custMutate (nil
// ok) patches the customer document in the same transaction (lifetime
// spend). ErrStateConflict when the batch is not in an expected state.
func (s *Store) TransitionBatch(ctx context.Context, id string, fromStates []string,
	mutate func(b *Batch) error, convMutate func(c *Conversion) error, custMutate func(c *Customer) error) (*Batch, error) {
	var result *Batch
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.batchDoc(id))
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		b, err := snapToBatch(snap)
		if err != nil {
			return err
		}
		ok := false
		for _, st := range fromStates {
			if b.State == st {
				ok = true
				break
			}
		}
		if !ok {
			return fmt.Errorf("%w: batch %s is %s", ErrStateConflict, id, b.State)
		}
		// All reads before any write (Firestore transaction rule).
		var convs []*Conversion
		if convMutate != nil {
			for _, it := range b.Items {
				csnap, gerr := tx.Get(s.convDoc(it.ConversionID))
				if status.Code(gerr) == codes.NotFound {
					continue // support deleted it; the ledger still settles
				}
				if gerr != nil {
					return gerr
				}
				c, cerr := snapToConversion(csnap)
				if cerr != nil {
					return cerr
				}
				convs = append(convs, c)
			}
		}
		var cust *Customer
		custRef := s.fs.Collection(customersCol(s.env)).Doc(b.UID)
		if custMutate != nil {
			csnap, gerr := tx.Get(custRef)
			if gerr != nil && status.Code(gerr) != codes.NotFound {
				return gerr
			}
			if gerr == nil {
				var c Customer
				if derr := csnap.DataTo(&c); derr != nil {
					return derr
				}
				cust = &c
			}
		}

		if err := mutate(b); err != nil {
			return err
		}
		now := time.Now().UTC()
		b.UpdatedAt = now
		for _, c := range convs {
			if err := convMutate(c); err != nil {
				return err
			}
			c.UpdatedAt = now
			if err := tx.Set(s.convDoc(c.ID), c); err != nil {
				return err
			}
		}
		if cust != nil {
			if err := custMutate(cust); err != nil {
				return err
			}
			if err := tx.Set(custRef, cust); err != nil {
				return err
			}
		}
		result = b
		return tx.Set(s.batchDoc(id), b)
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// OpenBatchFor returns the user's open batch, or nil when none.
func (s *Store) OpenBatchFor(ctx context.Context, uid string) (*Batch, error) {
	cust, err := s.GetCustomer(ctx, uid)
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if cust.OpenBatchID == "" {
		return nil, nil
	}
	b, err := s.GetBatch(ctx, cust.OpenBatchID)
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if b.State != BatchOpen {
		return nil, nil
	}
	return b, nil
}
