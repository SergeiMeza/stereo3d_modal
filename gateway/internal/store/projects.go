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

// CountOwnProjects counts the account's own projects — not the sample, not
// deleted ones — stopping at upTo, so it reads only as far as it must
// (every deleted or sample project on the way, then upTo of its own).
func (s *Store) CountOwnProjects(ctx context.Context, uid string, upTo int) (int, error) {
	iter := s.fs.Collection(projectsCol(s.env)).Where("uid", "==", uid).Documents(ctx)
	defer iter.Stop()
	n := 0
	for n < upTo {
		snap, err := iter.Next()
		if isIterDone(err) {
			break
		}
		if err != nil {
			return 0, err
		}
		var p Project
		if err := snap.DataTo(&p); err != nil {
			return 0, err
		}
		if !p.Sample && !p.Deleted {
			n++
		}
	}
	return n, nil
}

// Live job progress on a project (analyze, profile): written at most every
// ProgressMinGap unless it moved at least ProgressMinStep (or the stage
// changed), so a job costs a few writes a minute however many viewers or
// instances poll it.
const (
	ProgressMinGap  = 5 * time.Second
	ProgressMinStep = 0.05
)

// Job kinds for SetJobProgress.
const (
	JobAnalyze = "analyze"
	JobProfile = "profile"
)

// JobProgress is a running job's live progress.
type JobProgress struct {
	Progress   float64
	Stage      string
	ETASeconds int64 // analyze only
}

// SetJobProgress writes a running job's progress onto its project (only
// the progress fields; updated_at stays) when the job is still the
// project's running one and the change passes the throttle. true when it
// wrote.
func (s *Store) SetJobProgress(ctx context.Context, projectID, kind, jobID string, jp JobProgress, now time.Time) (bool, error) {
	wrote := false
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		wrote = false
		snap, err := tx.Get(s.projDoc(projectID))
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
		var cur JobProgress
		var at *time.Time
		switch kind {
		case JobAnalyze:
			if p.Analyze.State != AnalyzeRunning || p.Analyze.JobID != jobID {
				return nil
			}
			cur, at = JobProgress{p.Analyze.Progress, p.Analyze.Stage, p.Analyze.ETASeconds}, p.Analyze.ProgressAt
		case JobProfile:
			if p.Profile == nil || p.Profile.State != "running" || p.Profile.JobID != jobID {
				return nil
			}
			cur, at, jp.ETASeconds = JobProgress{p.Profile.Progress, p.Profile.Stage, 0}, p.Profile.ProgressAt, 0
		default:
			return fmt.Errorf("job progress: unknown kind %q", kind)
		}
		if cur == jp {
			return nil
		}
		step := jp.Progress - cur.Progress
		if step < 0 {
			step = -step
		}
		if at != nil && now.Sub(*at) < ProgressMinGap && step < ProgressMinStep && jp.Stage == cur.Stage {
			return nil // too soon for so small a change
		}
		ups := []firestore.Update{{Path: kind + ".progress", Value: jp.Progress}, {Path: kind + ".stage", Value: jp.Stage},
			{Path: kind + ".progress_at", Value: now.UTC()}}
		if kind == JobAnalyze {
			ups = append(ups, firestore.Update{Path: "analyze.eta_seconds", Value: jp.ETASeconds})
		}
		wrote = true
		return tx.Update(s.projDoc(projectID), ups)
	})
	return wrote, err
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
	return s.updateProject(ctx, id, true, mutate)
}

// UpdateProjectQuiet is UpdateProject without bumping updated_at — for
// bookkeeping the customer didn't do (the file-keeping clock).
func (s *Store) UpdateProjectQuiet(ctx context.Context, id string, mutate func(p *Project) error) (*Project, error) {
	return s.updateProject(ctx, id, false, mutate)
}

func (s *Store) updateProject(ctx context.Context, id string, bump bool, mutate func(p *Project) error) (*Project, error) {
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
		if bump {
			p.UpdatedAt = time.Now().UTC()
		}
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
		if p.Analyze.CreditConsumedBy == conversionID && p.Analyze.CreditCents > 0 {
			credit = p.Analyze.CreditCents // the same run asking again (an idempotent replay, P3)
			return nil
		}
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

func (s *Store) collectProjects(iter *firestore.DocumentIterator) ([]*Project, error) {
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

// ListProjectsFilesDueBy returns projects whose files_delete_at is at or
// before t, soonest first (file-keeping sweep; single-field index).
func (s *Store) ListProjectsFilesDueBy(ctx context.Context, t time.Time, limit int) ([]*Project, error) {
	return s.collectProjects(s.fs.Collection(projectsCol(s.env)).
		Where("files_delete_at", "<=", t).
		OrderBy("files_delete_at", firestore.Asc).
		Limit(limit).Documents(ctx))
}

// ListProjectsBySource returns the projects made from one upload (a
// project re-created on the same upload shares its source file).
func (s *Store) ListProjectsBySource(ctx context.Context, gcsKey string) ([]*Project, error) {
	return s.collectProjects(s.fs.Collection(projectsCol(s.env)).
		Where("source.gcs_key", "==", gcsKey).Limit(50).Documents(ctx))
}

// EachProject calls fn for every project of the env, in pages (the
// file-keeping backfill).
func (s *Store) EachProject(ctx context.Context, fn func(p *Project) error) error {
	var last *firestore.DocumentSnapshot
	for {
		q := s.fs.Collection(projectsCol(s.env)).OrderBy(firestore.DocumentID, firestore.Asc).Limit(300)
		if last != nil {
			q = q.StartAfter(last)
		}
		iter := q.Documents(ctx)
		n := 0
		for {
			snap, err := iter.Next()
			if isIterDone(err) {
				break
			}
			if err != nil {
				iter.Stop()
				return err
			}
			n++
			last = snap
			var p Project
			if err := snap.DataTo(&p); err != nil {
				iter.Stop()
				return err
			}
			p.ID = snap.Ref.ID
			if err := fn(&p); err != nil {
				iter.Stop()
				return err
			}
		}
		iter.Stop()
		if n < 300 {
			return nil
		}
	}
}

// GetProjectsByID reads several projects in one round trip; missing ones
// are absent from the map.
func (s *Store) GetProjectsByID(ctx context.Context, ids []string) (map[string]*Project, error) {
	out := map[string]*Project{}
	if len(ids) == 0 {
		return out, nil
	}
	refs := make([]*firestore.DocumentRef, 0, len(ids))
	for _, id := range ids {
		refs = append(refs, s.projDoc(id))
	}
	snaps, err := s.fs.GetAll(ctx, refs)
	if err != nil {
		return nil, err
	}
	for _, sn := range snaps {
		if !sn.Exists() {
			continue
		}
		var p Project
		if sn.DataTo(&p) == nil {
			p.ID = sn.Ref.ID
			out[p.ID] = &p
		}
	}
	return out, nil
}

// ListUserSamples is every onboarding sample of uid, deleted ones too
// (equality filters only: no composite index).
func (s *Store) ListUserSamples(ctx context.Context, uid string) ([]*Project, error) {
	snaps, err := s.fs.Collection(projectsCol(s.env)).Where("uid", "==", uid).Where("sample", "==", true).Limit(20).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]*Project, 0, len(snaps))
	for _, sn := range snaps {
		var p Project
		if sn.DataTo(&p) == nil {
			p.ID = sn.Ref.ID
			out = append(out, &p)
		}
	}
	return out, nil
}

func uploadNamesCol(env string) string { return "upload_names_" + env }

// PutUploadName keeps an upload's file name (the device's) until the
// project is made from it; best effort.
func (s *Store) PutUploadName(ctx context.Context, uploadID, uid, name string) error {
	_, err := s.fs.Collection(uploadNamesCol(s.env)).Doc(uploadID).Set(ctx, map[string]any{
		"uid": uid, "name": name, "created_at": time.Now().UTC(),
		"expires_at": time.Now().UTC().Add(30 * 24 * time.Hour), // a TTL policy may take it
	})
	return err
}

// UploadName is the name an upload of uid's was given ("" = none).
func (s *Store) UploadName(ctx context.Context, uploadID, uid string) string {
	snap, err := s.fs.Collection(uploadNamesCol(s.env)).Doc(uploadID).Get(ctx)
	if err != nil {
		return ""
	}
	var d struct {
		UID  string `firestore:"uid"`
		Name string `firestore:"name"`
	}
	if snap.DataTo(&d) != nil || d.UID != uid {
		return ""
	}
	return d.Name
}

// MarkSampleCreated records the account's sample once (merged into its
// customer record, made when there's none yet); the first time stays.
func (s *Store) MarkSampleCreated(ctx context.Context, uid string, at time.Time) error {
	doc := s.fs.Collection(customersCol(s.env)).Doc(uid)
	return s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(doc)
		if err != nil && status.Code(err) != codes.NotFound {
			return err
		}
		if err == nil {
			if v, verr := snap.DataAt("sample_created_at"); verr == nil && v != nil {
				return nil
			}
		}
		return tx.Set(doc, map[string]any{"sample_created_at": at}, firestore.MergeAll)
	})
}
