package store

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/api/iterator"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Collections are per-env so test and prod never mix.
func conversionsCol(env string) string { return "conversions_" + env }
func customersCol(env string) string   { return "customers_" + env }

var ErrNotFound = errors.New("not found")
var ErrStateConflict = errors.New("state conflict")
var ErrAlreadyExists = errors.New("already exists")

type Store struct {
	fs  *firestore.Client
	env string
}

func New(ctx context.Context, projectID, env string) (*Store, error) {
	fs, err := firestore.NewClient(ctx, projectID)
	if err != nil {
		return nil, err
	}
	return &Store{fs: fs, env: env}, nil
}

func (s *Store) Close() error { return s.fs.Close() }

func NewID() string {
	b := make([]byte, 6)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b) // 12 hex chars, mirrors Modal job ids
}

// ------------------------------------------------------------- customers

func (s *Store) GetCustomer(ctx context.Context, uid string) (*Customer, error) {
	snap, err := s.fs.Collection(customersCol(s.env)).Doc(uid).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var c Customer
	if err := snap.DataTo(&c); err != nil {
		return nil, err
	}
	return &c, nil
}

// PutCustomer creates the mapping once; a concurrent duplicate returns
// ErrAlreadyExists so callers re-read instead of overwriting (an overwrite
// would orphan payment methods attached to the first Stripe customer).
func (s *Store) PutCustomer(ctx context.Context, uid string, c *Customer) error {
	_, err := s.fs.Collection(customersCol(s.env)).Doc(uid).Create(ctx, c)
	if status.Code(err) == codes.AlreadyExists {
		return ErrAlreadyExists
	}
	return err
}

// ------------------------------------------------------------ conversions

func (s *Store) convDoc(id string) *firestore.DocumentRef {
	return s.fs.Collection(conversionsCol(s.env)).Doc(id)
}

func (s *Store) CreateConversion(ctx context.Context, c *Conversion) error {
	c.CreatedAt = time.Now().UTC()
	c.UpdatedAt = c.CreatedAt
	_, err := s.convDoc(c.ID).Create(ctx, c)
	return err
}

func (s *Store) GetConversion(ctx context.Context, id string) (*Conversion, error) {
	snap, err := s.convDoc(id).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return snapToConversion(snap)
}

// FindByIdemKey returns a prior conversion created by the same user with the
// same Idempotency-Key header, making POST /v1/conversions retry-safe.
// Infrastructure errors are returned as-is (NOT mapped to ErrNotFound —
// treating an outage as "no prior" would defeat idempotency exactly when
// retries are most likely).
func (s *Store) FindByIdemKey(ctx context.Context, uid, key string) (*Conversion, error) {
	iter := s.fs.Collection(conversionsCol(s.env)).
		Where("uid", "==", uid).Where("idem_key", "==", key).Limit(1).Documents(ctx)
	defer iter.Stop()
	snap, err := iter.Next()
	if err == iterator.Done {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return snapToConversion(snap)
}

// Requires the composite index (uid ASC, created_at DESC) — see README.
func (s *Store) ListUserConversions(ctx context.Context, uid string, limit int) ([]*Conversion, error) {
	return s.collect(s.fs.Collection(conversionsCol(s.env)).
		Where("uid", "==", uid).
		OrderBy("created_at", firestore.Desc).
		Limit(limit).Documents(ctx))
}

// ListByState returns conversions in the given state (reconciler queries).
func (s *Store) ListByState(ctx context.Context, state string, limit int) ([]*Conversion, error) {
	return s.collect(s.fs.Collection(conversionsCol(s.env)).
		Where("state", "==", state).Limit(limit).Documents(ctx))
}

// ListByPIStatus finds conversions with pending/failed money actions
// (reconciler settle sweeps). Equality-only filter — no composite index.
func (s *Store) ListByPIStatus(ctx context.Context, piStatus string, limit int) ([]*Conversion, error) {
	return s.collect(s.fs.Collection(conversionsCol(s.env)).
		Where("stripe.pi_status", "==", piStatus).Limit(limit).Documents(ctx))
}

func isIterDone(err error) bool { return err == iterator.Done }

// collect drains an iterator, propagating real errors instead of treating
// them as end-of-results (a missing index or outage must surface, not
// silently return an empty list).
func (s *Store) collect(iter *firestore.DocumentIterator) ([]*Conversion, error) {
	defer iter.Stop()
	var out []*Conversion
	for {
		snap, err := iter.Next()
		if err == iterator.Done {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		c, err := snapToConversion(snap)
		if err != nil {
			return nil, err
		}
		out = append(out, c)
	}
}

func (s *Store) CountActiveForUser(ctx context.Context, uid string) (int, error) {
	n := 0
	for _, st := range ActiveStates {
		iter := s.fs.Collection(conversionsCol(s.env)).
			Where("uid", "==", uid).Where("state", "==", st).Documents(ctx)
		docs, err := iter.GetAll()
		if err != nil {
			return 0, err
		}
		n += len(docs)
	}
	return n, nil
}

// Transition atomically moves a conversion from one of fromStates to mutate's
// result, returning ErrStateConflict if the document is no longer in an
// expected state. All money- and Modal-affecting writes go through this.
func (s *Store) Transition(ctx context.Context, id string, fromStates []string, mutate func(c *Conversion) error) (*Conversion, error) {
	var result *Conversion
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.convDoc(id))
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		c, err := snapToConversion(snap)
		if err != nil {
			return err
		}
		ok := false
		for _, st := range fromStates {
			if c.State == st {
				ok = true
				break
			}
		}
		if !ok {
			return fmt.Errorf("%w: conversion %s is %s", ErrStateConflict, id, c.State)
		}
		if err := mutate(c); err != nil {
			return err
		}
		c.UpdatedAt = time.Now().UTC()
		result = c
		return tx.Set(s.convDoc(id), c)
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// Update applies a non-state-changing patch (progress, poll timestamps).
func (s *Store) Update(ctx context.Context, c *Conversion) error {
	c.UpdatedAt = time.Now().UTC()
	_, err := s.convDoc(c.ID).Set(ctx, c)
	return err
}

func snapToConversion(snap *firestore.DocumentSnapshot) (*Conversion, error) {
	var c Conversion
	if err := snap.DataTo(&c); err != nil {
		return nil, err
	}
	c.ID = snap.Ref.ID
	return &c, nil
}
