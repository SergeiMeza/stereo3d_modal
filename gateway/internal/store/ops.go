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
