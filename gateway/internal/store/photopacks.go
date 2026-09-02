package store

import (
	"context"
	"fmt"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func photoPacksCol(env string) string { return "photo_packs_" + env }

func (s *Store) packDoc(id string) *firestore.DocumentRef {
	return s.fs.Collection(photoPacksCol(s.env)).Doc(id)
}

func snapToPack(snap *firestore.DocumentSnapshot) (*PhotoPack, error) {
	var p PhotoPack
	if err := snap.DataTo(&p); err != nil {
		return nil, err
	}
	p.ID = snap.Ref.ID
	return &p, nil
}

func (s *Store) GetPhotoPack(ctx context.Context, id string) (*PhotoPack, error) {
	snap, err := s.packDoc(id).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return snapToPack(snap)
}

// FindPhotoPackByIdemKey returns the user's pack purchase created under
// this Idempotency-Key (a retried tap must never buy twice).
func (s *Store) FindPhotoPackByIdemKey(ctx context.Context, uid, key string) (*PhotoPack, error) {
	iter := s.fs.Collection(photoPacksCol(s.env)).
		Where("uid", "==", uid).Where("idem_key", "==", key).Limit(1).Documents(ctx)
	snap, err := iter.Next()
	if isIterDone(err) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return snapToPack(snap)
}

func (s *Store) CreatePhotoPack(ctx context.Context, p *PhotoPack) error {
	now := time.Now().UTC()
	p.CreatedAt, p.UpdatedAt = now, now
	_, err := s.packDoc(p.ID).Create(ctx, p)
	if status.Code(err) == codes.AlreadyExists {
		return ErrAlreadyExists
	}
	return err
}

func (s *Store) ListPhotoPacksByState(ctx context.Context, state string, limit int) ([]*PhotoPack, error) {
	iter := s.fs.Collection(photoPacksCol(s.env)).
		Where("state", "==", state).Limit(limit).Documents(ctx)
	var out []*PhotoPack
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		p, err := snapToPack(snap)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
}

// TransitionPhotoPack mutates a pack in one of fromStates. When the
// mutation lands the pack on PackPaid, the pack's credits are added to
// the customer IN THE SAME TRANSACTION — a paid pack can never be missing
// its credits, and a replayed webhook can never grant them twice (the
// state guard rejects the second pass).
func (s *Store) TransitionPhotoPack(ctx context.Context, id string, fromStates []string, mutate func(p *PhotoPack) error) (*PhotoPack, int64, error) {
	var result *PhotoPack
	var credits int64
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.packDoc(id))
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		p, err := snapToPack(snap)
		if err != nil {
			return err
		}
		ok := false
		for _, st := range fromStates {
			if p.State == st {
				ok = true
				break
			}
		}
		if !ok {
			return fmt.Errorf("%w: pack %s is %s", ErrStateConflict, id, p.State)
		}
		custRef := s.fs.Collection(customersCol(s.env)).Doc(p.UID)
		custSnap, err := tx.Get(custRef)
		if err != nil && status.Code(err) != codes.NotFound {
			return err
		}
		wasPaid := p.State == PackPaid
		if err := mutate(p); err != nil {
			return err
		}
		p.UpdatedAt = time.Now().UTC()
		if p.State == PackPaid && !wasPaid && custSnap != nil && custSnap.Exists() {
			var c Customer
			if derr := custSnap.DataTo(&c); derr != nil {
				return derr
			}
			c.PhotoCredits += int64(p.Size)
			c.LifetimePaidCents += p.AmountCents
			credits = c.PhotoCredits
			if serr := tx.Set(custRef, &c); serr != nil {
				return serr
			}
		}
		result = p
		return tx.Set(s.packDoc(id), p)
	})
	if err != nil {
		return nil, 0, err
	}
	return result, credits, nil
}

// ConsumePhotoCredit takes one purchased credit if any remain. ok=false
// (no write) when the balance is zero or the customer is unknown.
func (s *Store) ConsumePhotoCredit(ctx context.Context, uid string) (remaining int64, ok bool, err error) {
	ref := s.fs.Collection(customersCol(s.env)).Doc(uid)
	err = s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, gerr := tx.Get(ref)
		if status.Code(gerr) == codes.NotFound {
			return nil
		}
		if gerr != nil {
			return gerr
		}
		var c Customer
		if derr := snap.DataTo(&c); derr != nil {
			return derr
		}
		if c.PhotoCredits <= 0 {
			remaining = 0
			return nil
		}
		c.PhotoCredits--
		remaining, ok = c.PhotoCredits, true
		return tx.Set(ref, &c)
	})
	return remaining, ok, err
}

// RefundPhotoCredit gives back a credit for a credited run that never
// delivered (failed / canceled / expired).
func (s *Store) RefundPhotoCredit(ctx context.Context, uid string) error {
	_, err := s.UpdateCustomer(ctx, uid, func(c *Customer) error {
		c.PhotoCredits++
		return nil
	})
	return err
}
