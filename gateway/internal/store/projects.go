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

func projectsCol(env string) string { return "projects_" + env }

func (s *Store) projDoc(id string) *firestore.DocumentRef {
	return s.fs.Collection(projectsCol(s.env)).Doc(id)
}

func (s *Store) CreateProject(ctx context.Context, p *Project) error {
	p.CreatedAt = time.Now().UTC()
	p.UpdatedAt = p.CreatedAt
	_, err := s.projDoc(p.ID).Create(ctx, p)
	return err
}

func (s *Store) GetProject(ctx context.Context, id string) (*Project, error) {
	snap, err := s.projDoc(id).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var p Project
	if err := snap.DataTo(&p); err != nil {
		return nil, err
	}
	p.ID = snap.Ref.ID
	return &p, nil
}

// Requires the composite index (uid ASC, created_at DESC) — see README.
func (s *Store) ListUserProjects(ctx context.Context, uid string, limit int) ([]*Project, error) {
	iter := s.fs.Collection(projectsCol(s.env)).
		Where("uid", "==", uid).
		OrderBy("created_at", firestore.Desc).
		Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*Project
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		var p Project
		if err := snap.DataTo(&p); err != nil {
			return nil, err
		}
		p.ID = snap.Ref.ID
		out = append(out, &p)
	}
}

// ListProjectsAnalyzing returns projects whose free analyze job is still
// running (reconciler sweep).
func (s *Store) ListProjectsAnalyzing(ctx context.Context, limit int) ([]*Project, error) {
	iter := s.fs.Collection(projectsCol(s.env)).
		Where("analyze.state", "==", AnalyzeRunning).Limit(limit).Documents(ctx)
	defer iter.Stop()
	var out []*Project
	for {
		snap, err := iter.Next()
		if isIterDone(err) {
			return out, nil
		}
		if err != nil {
			return nil, err
		}
		var p Project
		if err := snap.DataTo(&p); err != nil {
			return nil, err
		}
		p.ID = snap.Ref.ID
		out = append(out, &p)
	}
}

// UpdateProject transactionally mutates a project.
func (s *Store) UpdateProject(ctx context.Context, id string, mutate func(p *Project) error) (*Project, error) {
	var result *Project
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(s.projDoc(id))
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		var p Project
		if err := snap.DataTo(&p); err != nil {
			return err
		}
		p.ID = snap.Ref.ID
		if err := mutate(&p); err != nil {
			return err
		}
		p.UpdatedAt = time.Now().UTC()
		result = &p
		return tx.Set(s.projDoc(id), &p)
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// ConsumeAnalyzeCredit atomically claims the project's analyze credit for a
// conversion. Returns the credit amount (0 if none / already consumed).
func (s *Store) ConsumeAnalyzeCredit(ctx context.Context, projectID, conversionID string) (int64, error) {
	var credit int64
	_, err := s.UpdateProject(ctx, projectID, func(p *Project) error {
		if p.Analyze.State != AnalyzeSucceeded || p.Analyze.CreditCents <= 0 || p.Analyze.CreditConsumedBy != "" {
			credit = 0
			return nil
		}
		credit = p.Analyze.CreditCents
		p.Analyze.CreditConsumedBy = conversionID
		return nil
	})
	return credit, err
}

// RestoreAnalyzeCredit gives the credit back when the consuming conversion
// ends without a capture (failed/canceled/expired). No-op for anyone else.
func (s *Store) RestoreAnalyzeCredit(ctx context.Context, projectID, conversionID string) error {
	_, err := s.UpdateProject(ctx, projectID, func(p *Project) error {
		if p.Analyze.CreditConsumedBy == conversionID {
			p.Analyze.CreditConsumedBy = ""
		}
		return nil
	})
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

// UpdateScenes replaces the cut list, bumping the version. expectVersion
// guards lost updates from two open editors (-1 skips the check).
func (s *Store) UpdateScenes(ctx context.Context, projectID string, cuts []int, expectVersion int) (*Project, error) {
	return s.UpdateProject(ctx, projectID, func(p *Project) error {
		if p.Scenes == nil {
			return fmt.Errorf("%w: project has no analysis yet", ErrStateConflict)
		}
		if expectVersion >= 0 && p.Scenes.Version != expectVersion {
			return fmt.Errorf("%w: scenes at version %d, expected %d",
				ErrStateConflict, p.Scenes.Version, expectVersion)
		}
		p.Scenes = &Scenes{
			Version:   p.Scenes.Version + 1,
			Cuts:      cuts,
			Edited:    true,
			UpdatedAt: time.Now().UTC(),
		}
		return nil
	})
}

// ListProjectConversions returns a project's conversions, newest first.
// Requires the composite index (project_id ASC, created_at DESC).
func (s *Store) ListProjectConversions(ctx context.Context, projectID string, limit int) ([]*Conversion, error) {
	return s.collect(s.fs.Collection(conversionsCol(s.env)).
		Where("project_id", "==", projectID).
		OrderBy("created_at", firestore.Desc).
		Limit(limit).Documents(ctx))
}
