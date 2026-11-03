package emailcode

import (
	"context"
	"sync"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// FirestoreStore keeps records in auth_email_codes_{env}, one document per
// address hash, updated in transactions.
type FirestoreStore struct {
	col *firestore.CollectionRef
	fs  *firestore.Client
}

func NewFirestoreStore(fs *firestore.Client, env string) *FirestoreStore {
	return &FirestoreStore{fs: fs, col: fs.Collection("auth_email_codes_" + env)}
}

func (s *FirestoreStore) Update(ctx context.Context, key string, fn func(*Record) (*Record, error)) error {
	ref := s.col.Doc(key)
	return s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		var current *Record
		snap, err := tx.Get(ref)
		switch {
		case status.Code(err) == codes.NotFound:
		case err != nil:
			return err
		default:
			var r Record
			if err := snap.DataTo(&r); err != nil {
				return err
			}
			current = &r
		}
		next, err := fn(current)
		if err != nil {
			return err
		}
		if next == nil {
			return tx.Delete(ref)
		}
		return tx.Set(ref, next)
	})
}

// MemoryStore is a Store in memory (tests, local runs without Firestore).
type MemoryStore struct {
	mu   sync.Mutex
	recs map[string]Record
}

func NewMemoryStore() *MemoryStore { return &MemoryStore{recs: map[string]Record{}} }

func (m *MemoryStore) Update(_ context.Context, key string, fn func(*Record) (*Record, error)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	var current *Record
	if r, ok := m.recs[key]; ok {
		current = &r
	}
	next, err := fn(current)
	if err != nil {
		return err
	}
	if next == nil {
		delete(m.recs, key)
	} else {
		m.recs[key] = *next
	}
	return nil
}

// Get is a copy of key's record (tests).
func (m *MemoryStore) Get(key string) (Record, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	r, ok := m.recs[key]
	return r, ok
}
