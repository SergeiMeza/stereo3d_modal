package store

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Operational state shared by every gateway instance (ops_{env}): alert
// throttles and the like, one document each.
func opsCol(env string) string { return "ops_" + env }

// GPULine is the GPU-queue alert's state (S3D-34): whether a line of runs
// waiting for a GPU is open, when it was last mailed about, and its
// longest wait so far.
type GPULine struct {
	Active       bool       `firestore:"active"`
	StartedAt    *time.Time `firestore:"started_at,omitempty"`
	LastMailAt   *time.Time `firestore:"last_mail_at,omitempty"`
	LongestWaitS float64    `firestore:"longest_wait_s"`
}

// UpdateGPULine runs mutate on the GPU-line state in a transaction (a
// missing document starts empty) and returns what was written.
func (s *Store) UpdateGPULine(ctx context.Context, mutate func(l *GPULine) error) (*GPULine, error) {
	doc := s.fs.Collection(opsCol(s.env)).Doc("gpu_line")
	var out GPULine
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		out = GPULine{}
		snap, err := tx.Get(doc)
		if err != nil && status.Code(err) != codes.NotFound {
			return err
		}
		if err == nil {
			if derr := snap.DataTo(&out); derr != nil {
				return derr
			}
		}
		if err := mutate(&out); err != nil {
			return err
		}
		return tx.Set(doc, &out)
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// FileKeeping is the file-keeping sweep's state (S3D-24): when it last
// ran (it runs hourly, whichever instance claims it) and whether the
// one-time backfill of files_delete_at is done.
type FileKeeping struct {
	LastRunAt  *time.Time `firestore:"last_run_at,omitempty"`
	Backfilled bool       `firestore:"backfilled"`
}

// ClaimFileKeeping claims a sweep when the last one is at least every
// old, returning the state found (claimed false = not due).
func (s *Store) ClaimFileKeeping(ctx context.Context, every time.Duration) (FileKeeping, bool, error) {
	doc := s.fs.Collection(opsCol(s.env)).Doc("file_keeping")
	var found FileKeeping
	var claimed bool
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		found, claimed = FileKeeping{}, false
		snap, err := tx.Get(doc)
		if err != nil && status.Code(err) != codes.NotFound {
			return err
		}
		if err == nil {
			if derr := snap.DataTo(&found); derr != nil {
				return derr
			}
		}
		now := time.Now().UTC()
		if found.LastRunAt != nil && now.Sub(*found.LastRunAt) < every {
			return nil
		}
		claimed = true
		next := found
		next.LastRunAt = &now
		return tx.Set(doc, &next)
	})
	return found, claimed, err
}

// MarkFileKeepingBackfilled records the backfill as done.
func (s *Store) MarkFileKeepingBackfilled(ctx context.Context) error {
	_, err := s.fs.Collection(opsCol(s.env)).Doc("file_keeping").
		Set(ctx, map[string]any{"backfilled": true}, firestore.MergeAll)
	return err
}
