package api

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// S3D-24: 90 days without use, notices 14 and 3 days before, each notice
// its full lead time, deleted projects 30 days after deletion.
func TestFileKeepingClock(t *testing.T) {
	rates := pricing.Defaults()
	notices, keep := rates.FileNotices(), rates.FileKeep()
	if len(notices) != 2 || notices[0] != 14*day || notices[1] != 3*day || keep != 90*day || rates.DeletedProjectPurge() != 30*day {
		t.Fatalf("defaults: %v %v %v", notices, keep, rates.DeletedProjectPurge())
	}
	t0 := time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC)
	p := &store.Project{ID: "p1", Name: "Trip"}
	noteUse(p, t0, keep)
	if !p.FilesDeleteAt.Equal(t0.Add(90 * day)) {
		t.Fatalf("delete at %v", p.FilesDeleteAt)
	}
	if shownFilesDeleteAt(p, t0, notices) != nil {
		t.Error("files_delete_at shown before a deletion is scheduled")
	}
	if _, ok := dueNotice(p, t0.Add(75*day), notices); ok {
		t.Error("notice before the 14-day window")
	}
	at := t0.Add(77 * day) // 13 days before
	lead, ok := dueNotice(p, at, notices)
	if !ok || lead != 14*day {
		t.Fatalf("first notice: %v %v", lead, ok)
	}
	if shownFilesDeleteAt(p, at, notices) == nil {
		t.Error("files_delete_at hidden inside the notice window")
	}
	noticeSent(p, lead, at) // a day late: the files stay 14 days from now
	if !p.FilesDeleteAt.Equal(at.Add(14 * day)) {
		t.Errorf("late 14-day notice: delete at %v", p.FilesDeleteAt)
	}
	if _, ok := dueNotice(p, at.Add(day), notices); ok {
		t.Error("14-day notice twice")
	}
	if purgeDue(p, p.FilesDeleteAt.Add(time.Hour), notices) {
		t.Error("purge without the 3-day notice")
	}
	at3 := p.FilesDeleteAt.Add(-3 * day)
	if lead, ok := dueNotice(p, at3, notices); !ok || lead != 3*day {
		t.Fatalf("3-day notice: %v %v", lead, ok)
	}
	noticeSent(p, 3*day, at3)
	if purgeDue(p, at3.Add(3*day-time.Minute), notices) || !purgeDue(p, at3.Add(3*day), notices) {
		t.Error("purge timing after the 3-day notice")
	}
	// Opening the project resets everything.
	noteUse(p, at3.Add(day), keep)
	if p.FilesNoticeDays != 0 || p.FilesNoticeAt != nil || shownFilesDeleteAt(p, at3.Add(day), notices) != nil {
		t.Errorf("use did not reset: %+v", p)
	}
	// A missed window sends only the shortest notice due, and still waits
	// its lead time.
	q := &store.Project{}
	noteUse(q, t0, keep)
	late := t0.Add(89 * day)
	if lead, ok := dueNotice(q, late, notices); !ok || lead != 3*day {
		t.Fatalf("late notice: %v %v", lead, ok)
	}
	noticeSent(q, 3*day, late)
	if !q.FilesDeleteAt.Equal(late.Add(3 * day)) {
		t.Errorf("late 3-day notice: %v", q.FilesDeleteAt)
	}
	// Deleted projects: no notices, purge on the date.
	del := t0
	d := &store.Project{Deleted: true, DeletedAt: &del}
	purge := del.Add(30 * day)
	d.FilesDeleteAt = &purge
	if _, ok := dueNotice(d, purge.Add(-day), notices); ok {
		t.Error("notice for a deleted project")
	}
	if purgeDue(d, purge.Add(-time.Minute), notices) || !purgeDue(d, purge, notices) {
		t.Error("deleted project purge timing")
	}
	gone := purge
	d.FilesDeletedAt = &gone
	if purgeDue(d, purge.Add(day), notices) {
		t.Error("purge twice")
	}
}

func TestFileKeepingBackfill(t *testing.T) {
	now := time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC)
	notices := []time.Duration{14 * day, 3 * day}
	old := &store.Project{CreatedAt: now.Add(-400 * day), UpdatedAt: now.Add(-200 * day)}
	if got := backfillDeleteAt(old, now, 90*day, 30*day, notices); !got.Equal(now.Add(14 * day)) {
		t.Errorf("old project gets every notice: %v", got)
	}
	recent := &store.Project{CreatedAt: now.Add(-40 * day), UpdatedAt: now.Add(-10 * day)}
	if got := backfillDeleteAt(recent, now, 90*day, 30*day, notices); !got.Equal(now.Add(80 * day)) {
		t.Errorf("recent: %v", got)
	}
	when := now.Add(-5 * day)
	deleted := &store.Project{Deleted: true, DeletedAt: &when}
	if got := backfillDeleteAt(deleted, now, 90*day, 30*day, notices); !got.Equal(when.Add(30 * day)) {
		t.Errorf("deleted: %v", got)
	}
}

func TestProjectFileTargets(t *testing.T) {
	const prefix = "stereo3d/test/"
	fromURL := func(u string) (string, error) {
		k, ok := strings.CutPrefix(u, "https://storage.googleapis.com/bucket/")
		if !ok {
			return "", fmt.Errorf("bad %q", u)
		}
		return k, nil
	}
	p := &store.Project{
		Source:      store.Source{GCSKey: prefix + "users/u/abc/source.mp4"},
		Analyze:     store.Analyze{JobID: "job-analyze"},
		Profile:     &store.ProfileJob{JobID: "job-profile"},
		DepthUpload: &store.DepthUpload{GCSKey: prefix + "users/u/dep/source.mp4"},
		PreviewURL:  "https://storage.googleapis.com/bucket/" + prefix + "outputs/job-analyze/proxy.mp4",
		StripThumbs: []store.Thumb{{URL: "https://storage.googleapis.com/bucket/" + prefix + "outputs/job-analyze/t0.jpg"}},
	}
	convs := []*store.Conversion{
		{Modal: store.Modal{JobID: "job-run1"}, Outputs: map[string]string{"mvhevc": prefix + "outputs/job-run1/mvhevc.mov"}},
		{Modal: store.Modal{JobID: "../evil"}, Outputs: map[string]string{"sbs": "stereo3d/prod/outputs/x/sbs.mp4"}},
	}
	keys, folders := projectFileTargets(p, convs, prefix, fromURL)
	wantFolders := []string{prefix + "outputs/job-analyze/", prefix + "outputs/job-profile/", prefix + "outputs/job-run1/"}
	if !slices.Equal(folders, wantFolders) {
		t.Errorf("folders %v", folders)
	}
	for _, k := range keys {
		if !strings.HasPrefix(k, prefix) || k == p.Source.GCSKey {
			t.Errorf("unexpected key %q", k)
		}
	}
	if !slices.Contains(keys, prefix+"users/u/dep/source.mp4") || !slices.Contains(keys, prefix+"outputs/job-run1/mvhevc.mov") || !slices.Contains(keys, prefix+"outputs/job-analyze/proxy.mp4") {
		t.Errorf("keys %v", keys)
	}
}

func TestFileNoticeMail(t *testing.T) {
	now := time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC)
	a, b := now.Add(14*day), now.Add(16*day)
	m := fileNoticeMail([]*store.Project{
		{ID: "p2", Name: "Beach", FilesDeleteAt: &b},
		{ID: "p1", FilesDeleteAt: &a},
	}, 14*day, now, "https://www.stereo3d.studio", 90*day)
	if !strings.Contains(m.Subject, "Spatial Video Studio") || !strings.Contains(m.Subject, "2 projects") || !strings.Contains(m.Subject, "17 November") {
		t.Errorf("subject %q", m.Subject)
	}
	for _, want := range []string{"90 days", "- Untitled project: deleted on 17 November 2026", "https://www.stereo3d.studio/projects/p1", "- Beach: deleted on 19 November 2026", "Keep files"} {
		if !strings.Contains(m.Text, want) {
			t.Errorf("body lacks %q:\n%s", want, m.Text)
		}
	}
	if strings.Index(m.Text, "Untitled") > strings.Index(m.Text, "Beach") {
		t.Error("projects not soonest first")
	}
}
