package api

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"path"
	"regexp"
	"slices"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// File keeping (S3D-24). A project's stored files — the original upload,
// the analysis proxy and thumbnails, a depth upload, every run's outputs —
// are erased after file_keep_days (90) without use. Use = opening the
// project, starting a run, downloading, or POST /v1/projects/{id}/keep;
// each resets the clock. Notice mails go out file_notice_days (14, 3)
// before, one per account listing its projects. A deleted project's files
// are erased deleted_project_purge_days (30) after the deletion, without
// notices. The records stay: the project (files_deleted_at), its runs and
// all billing. Accounts deleted through POST /v1/account/delete keep their
// own rule (manual purge) and are skipped.
//
// Test env: notices and erasing are real only for test accounts (the
// owner's alert address and FILE_KEEPING_TEST_ACCOUNTS), and their mails
// go to the owner's address; every other test project is a dry run
// (logged, nothing mailed or erased).

const (
	fileKeepingEvery   = time.Hour // sweep cadence, any instance
	projectUseThrottle = time.Hour // how often a use is written
	fileSweepLimit     = 500
)

const day = 24 * time.Hour

func leadDays(d time.Duration) int { return int(d / day) }

// noteUse restarts a project's clock: last use now, files kept keep from
// now, notices cleared.
func noteUse(p *store.Project, now time.Time, keep time.Duration) {
	at := now.Add(keep)
	p.LastActivityAt, p.FilesDeleteAt = &now, &at
	p.FilesNoticeDays, p.FilesNoticeAt, p.FilesDryRunAt = 0, nil, nil
}

// noteProjectUse records a use (S3D-24), at most hourly unless forced or
// a notice already went out (then any use must reset the clock at once).
// It returns the project as stored, or p unchanged when nothing was
// written or the write failed (never fails the request).
func (s *Service) noteProjectUse(ctx context.Context, p *store.Project, force bool) *store.Project {
	if p == nil || p.Deleted || p.FilesDeletedAt != nil || p.Sample {
		return p
	}
	now := time.Now().UTC()
	if !force && p.FilesNoticeDays == 0 && p.LastActivityAt != nil && now.Sub(*p.LastActivityAt) < projectUseThrottle {
		return p
	}
	keep := s.rates(ctx).FileKeep()
	updated, err := s.Store.UpdateProjectQuiet(ctx, p.ID, func(pp *store.Project) error {
		if pp.Deleted || pp.FilesDeletedAt != nil {
			return errNoChange
		}
		noteUse(pp, now, keep)
		return nil
	})
	if err != nil {
		if !errors.Is(err, errNoChange) {
			slog.WarnContext(ctx, "file keeping: use not recorded", "project_id", p.ID, "err", err)
		}
		return p
	}
	return updated
}

func (s *Service) rates(ctx context.Context) *pricing.Rates {
	if s.Pricing == nil {
		return pricing.Defaults()
	}
	return s.Pricing.Rates(ctx)
}

// shownFilesDeleteAt is files_delete_at as the API shows it: only once a
// deletion is scheduled — inside the longest notice's window, or a notice
// went out — and never after the files are gone (files_deleted_at then).
func shownFilesDeleteAt(p *store.Project, now time.Time, notices []time.Duration) *time.Time {
	if p.FilesDeletedAt != nil || p.FilesDeleteAt == nil || len(notices) == 0 {
		return nil
	}
	if p.FilesNoticeDays > 0 || !now.Before(p.FilesDeleteAt.Add(-notices[0])) {
		return p.FilesDeleteAt
	}
	return nil
}

func (s *Service) filesDeleteAtFor(p *store.Project) *time.Time {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	return shownFilesDeleteAt(p, time.Now().UTC(), s.rates(ctx).FileNotices())
}

// errFilesDeleted answers anything that needs a project's files once
// they're gone.
func errFilesDeleted() error {
	return httpx.Err(http.StatusGone, "files_deleted",
		"this project's files were deleted after a long time without use; upload the video again to start over")
}

func requireFiles(p *store.Project) error {
	if p.FilesDeletedAt != nil {
		return errFilesDeleted()
	}
	return nil
}

// POST /v1/projects/{id}/keep — "Keep files": restarts the clock.
// → {project_id, files_delete_at: null} (null = no deletion scheduled).
func (s *Service) HandleKeepProject(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	p, err := s.ownedProject(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	if err := requireFiles(p); err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	p = s.noteProjectUse(ctx, p, true)
	httpx.WriteOK(w, map[string]any{"project_id": p.ID, "files_delete_at": s.filesDeleteAtFor(p)})
}

// dueNotice is the notice a project owes now: the shortest lead time
// whose window has opened and that is shorter than the one already sent.
func dueNotice(p *store.Project, now time.Time, notices []time.Duration) (time.Duration, bool) {
	if p.Deleted || p.FilesDeleteAt == nil || p.FilesDeletedAt != nil {
		return 0, false
	}
	var due time.Duration
	for _, lead := range notices { // longest first
		if !now.Before(p.FilesDeleteAt.Add(-lead)) {
			due = lead
		}
	}
	if due == 0 || (p.FilesNoticeDays > 0 && p.FilesNoticeDays <= leadDays(due)) {
		return 0, false
	}
	return due, true
}

// noticeSent records a notice; the files then stay at least its lead
// time from now.
func noticeSent(p *store.Project, lead time.Duration, now time.Time) {
	p.FilesNoticeDays, p.FilesNoticeAt = leadDays(lead), &now
	if earliest := now.Add(lead); p.FilesDeleteAt == nil || p.FilesDeleteAt.Before(earliest) {
		p.FilesDeleteAt = &earliest
	}
}

// purgeDue: the date has come and, for a kept project, the last notice
// went out its full lead time ago.
func purgeDue(p *store.Project, now time.Time, notices []time.Duration) bool {
	if p.FilesDeletedAt != nil || p.FilesDeleteAt == nil || now.Before(*p.FilesDeleteAt) {
		return false
	}
	if p.Deleted {
		return true
	}
	last := notices[len(notices)-1]
	return p.FilesNoticeDays == leadDays(last) && p.FilesNoticeAt != nil && !now.Before(p.FilesNoticeAt.Add(last))
}

// backfillDeleteAt dates a project made before file keeping: its last
// use (or last change) + keep, and never inside the first notice's window
// from now, so every customer gets every notice.
func backfillDeleteAt(p *store.Project, now time.Time, keep, purge time.Duration, notices []time.Duration) time.Time {
	if p.Deleted {
		if p.DeletedAt != nil {
			return p.DeletedAt.Add(purge)
		}
		return now.Add(purge)
	}
	base := p.CreatedAt
	if p.UpdatedAt.After(base) {
		base = p.UpdatedAt
	}
	if p.LastActivityAt != nil && p.LastActivityAt.After(base) {
		base = *p.LastActivityAt
	}
	at := base.Add(keep)
	if earliest := now.Add(notices[0]); at.Before(earliest) {
		at = earliest
	}
	return at
}

var safeJobID = regexp.MustCompile(`^[A-Za-z0-9_-]{4,80}$`)

// projectFileTargets lists what a project stored: exact keys (depth
// upload, run outputs, proxy, thumbnails) and its jobs' output folders
// (outputs/<job>/ under the env prefix). The source upload is decided
// separately (it may be shared with a re-created project).
func projectFileTargets(p *store.Project, convs []*store.Conversion, envPrefix string, keyFromURL func(string) (string, error)) (keys, folders []string) {
	addKey := func(k string) {
		if k != "" && strings.HasPrefix(k, envPrefix) && !slices.Contains(keys, k) {
			keys = append(keys, k)
		}
	}
	addURL := func(u string) {
		if u == "" {
			return
		}
		if k, err := keyFromURL(u); err == nil {
			addKey(k)
		}
	}
	addJob := func(id string) {
		if !safeJobID.MatchString(id) {
			return
		}
		if f := envPrefix + "outputs/" + id + "/"; !slices.Contains(folders, f) {
			folders = append(folders, f)
		}
	}
	if p.DepthUpload != nil {
		addKey(p.DepthUpload.GCSKey)
	}
	addURL(p.PreviewURL)
	for _, t := range p.StripThumbs {
		addURL(t.URL)
	}
	for _, t := range p.SceneThumbs {
		addURL(t.URL)
	}
	if p.Poster != nil {
		addURL(p.Poster.URL)
	}
	addJob(p.Analyze.JobID)
	if p.Profile != nil {
		addJob(p.Profile.JobID)
	}
	for _, c := range convs {
		addJob(c.Modal.JobID)
		names := make([]string, 0, len(c.Outputs))
		for n := range c.Outputs {
			names = append(names, n)
		}
		slices.Sort(names)
		for _, n := range names {
			addKey(c.Outputs[n])
		}
	}
	return keys, folders
}

// fileKeepingSweep runs from the reconciler; it does its work at most
// hourly (claimed in ops_{env}/file_keeping).
func (s *Service) fileKeepingSweep(ctx context.Context) {
	if s.GCS == nil {
		return
	}
	state, claimed, err := s.Store.ClaimFileKeeping(ctx, fileKeepingEvery)
	if err != nil || !claimed {
		if err != nil {
			slog.WarnContext(ctx, "file keeping: claim failed", "err", err)
		}
		return
	}
	rates := s.rates(ctx)
	notices := rates.FileNotices()
	now := time.Now().UTC()
	if !state.Backfilled {
		if err := s.backfillFileKeeping(ctx, now, rates.FileKeep(), rates.DeletedProjectPurge(), notices); err != nil {
			slog.WarnContext(ctx, "file keeping: backfill failed", "err", err)
			return
		}
	}
	due, err := s.Store.ListProjectsFilesDueBy(ctx, now.Add(notices[0]), fileSweepLimit)
	if err != nil {
		slog.WarnContext(ctx, "file keeping: list failed", "err", err)
		return
	}
	accounts := map[string]*store.Customer{}
	account := func(uid string) *store.Customer {
		if c, ok := accounts[uid]; ok {
			return c
		}
		c, err := s.Store.GetCustomer(ctx, uid)
		if err != nil {
			c = nil
		}
		accounts[uid] = c
		return c
	}
	owed := map[string]bool{}
	owing := func(uid string) bool {
		if o, ok := owed[uid]; ok {
			return o
		}
		owed[uid] = s.owedCents(ctx, uid) > 0
		return owed[uid]
	}
	type noticeKey struct {
		uid  string
		lead time.Duration
	}
	pending := map[noticeKey][]*store.Project{}
	stats := map[string]int{}
	for _, p := range due {
		if p.FilesDeletedAt != nil {
			continue
		}
		cust := account(p.UID)
		if cust != nil && cust.AccountDeleted {
			continue // account deletion keeps its own rule
		}
		if owing(p.UID) {
			// M5: the clock and its notices pause while the account owes
			// money; holding the clock at "now" restarts it when it clears.
			s.noteProjectUse(ctx, p, true)
			stats["paused_outstanding"]++
			continue
		}
		live := s.fileKeepingLive(cust)
		if lead, ok := dueNotice(p, now, notices); ok {
			if live {
				k := noticeKey{p.UID, lead}
				pending[k] = append(pending[k], p)
			} else {
				s.recordNotice(ctx, p, lead, now, "dry run")
				stats["notices_dry_run"]++
			}
			continue
		}
		if purgeDue(p, now, notices) {
			s.purgeProjectFiles(ctx, p, live, now, stats)
		}
	}
	for k, projects := range pending {
		cust := account(k.uid)
		if s.sendFileNotice(ctx, cust, projects, k.lead, now) {
			for _, p := range projects {
				s.recordNotice(ctx, p, k.lead, now, "mailed")
			}
			stats["notice_mails"]++
		}
	}
	if len(stats) > 0 {
		slog.InfoContext(ctx, "file keeping sweep", "stats", stats)
	}
}

func (s *Service) backfillFileKeeping(ctx context.Context, now time.Time, keep, purge time.Duration, notices []time.Duration) error {
	n := 0
	err := s.Store.EachProject(ctx, func(p *store.Project) error {
		if p.FilesDeleteAt != nil || p.FilesDeletedAt != nil || p.Sample {
			return nil
		}
		at := backfillDeleteAt(p, now, keep, purge, notices)
		_, err := s.Store.UpdateProjectQuiet(ctx, p.ID, func(pp *store.Project) error {
			if pp.FilesDeleteAt != nil || pp.FilesDeletedAt != nil {
				return errNoChange
			}
			pp.FilesDeleteAt = &at
			return nil
		})
		if err == nil {
			n++
		} else if !errors.Is(err, errNoChange) {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	slog.InfoContext(ctx, "file keeping: backfill done", "projects_dated", n)
	return s.Store.MarkFileKeepingBackfilled(ctx)
}

// fileKeepingLive: prod always; test only for test accounts.
func (s *Service) fileKeepingLive(cust *store.Customer) bool {
	if s.Cfg.Env == "prod" {
		return true
	}
	if cust == nil || cust.Email == "" {
		return false
	}
	email := strings.ToLower(strings.TrimSpace(cust.Email))
	return (s.Cfg.OwnerAlertEmail != "" && email == strings.ToLower(s.Cfg.OwnerAlertEmail)) ||
		slices.Contains(s.Cfg.FileKeepingTestAccounts, email)
}

func (s *Service) recordNotice(ctx context.Context, p *store.Project, lead time.Duration, now time.Time, how string) {
	if _, err := s.Store.UpdateProjectQuiet(ctx, p.ID, func(pp *store.Project) error {
		if pp.Deleted || pp.FilesDeletedAt != nil {
			return errNoChange
		}
		noticeSent(pp, lead, now)
		return nil
	}); err != nil && !errors.Is(err, errNoChange) {
		slog.WarnContext(ctx, "file keeping: notice not recorded", "project_id", p.ID, "err", err)
		return
	}
	slog.InfoContext(ctx, "file keeping: notice", "project_id", p.ID, "uid", p.UID, "days_before", leadDays(lead), "how", how)
}

// sendFileNotice mails one account about its projects; on test it goes to
// the owner's address instead. Reports whether it went out (else the
// notice stays due and the files stay).
func (s *Service) sendFileNotice(ctx context.Context, cust *store.Customer, projects []*store.Project, lead time.Duration, now time.Time) bool {
	if cust == nil || cust.Email == "" || !s.Mail.Configured() {
		slog.WarnContext(ctx, "file keeping: notice not sendable (no address or mail key)", "projects", len(projects))
		return false
	}
	lang := mailLangOf(cust)
	l := fileNoticeLayout(projects, lead, now, s.Cfg.SiteURL, s.rates(ctx).FileKeep(), lang)
	to := cust.Email
	if s.Cfg.Env != "prod" {
		if s.Cfg.OwnerAlertEmail == "" {
			return false
		}
		to = s.Cfg.OwnerAlertEmail
		l.Subject += " (test)"
		l.Banner = mail.T(lang, "common.testBanner", mail.Args{"email": cust.Email})
	}
	m := mail.Message{To: to, Subject: l.FullSubject(), Text: l.Text(), HTML: l.HTML(), ReplyTo: supportInbox}
	if err := s.Mail.Send(ctx, m); err != nil {
		slog.ErrorContext(ctx, "file keeping: notice mail failed", "err", err)
		return false
	}
	return true
}

// fileNoticeMail is the English notice (tests, admin).
func fileNoticeMail(projects []*store.Project, lead time.Duration, now time.Time, site string, keep time.Duration) mail.Message {
	l := fileNoticeLayout(projects, lead, now, site, keep, "en")
	return mail.Message{Subject: l.FullSubject(), Text: l.Text(), HTML: l.HTML()}
}

// fileNoticeLayout is FK1 in lang: the projects whose files go soon,
// soonest first, each linking to itself; the subject names the soonest
// day.
func fileNoticeLayout(projects []*store.Project, lead time.Duration, now time.Time, site string, keep time.Duration, lang string) mail.Layout {
	sorted := slices.Clone(projects)
	slices.SortFunc(sorted, func(a, b *store.Project) int { return a.FilesDeleteAt.Compare(*b.FilesDeleteAt) })
	earliest := now.Add(lead)
	soonest := *sorted[0].FilesDeleteAt
	if soonest.Before(earliest) {
		soonest = earliest // noticeSent moves it there
	}
	l := page(lang, "fk1", mail.Args{"date": mail.FormatDayMonth(lang, soonest)})
	l.Paras = []string{mail.T(lang, "fk1.body", mail.Args{"days": istr(leadDays(keep))})}
	for _, p := range sorted {
		at := *p.FilesDeleteAt
		if at.Before(earliest) {
			at = earliest
		}
		name := strings.TrimSpace(p.Name)
		if name == "" {
			name = t(lang, "fk1.untitled")
		}
		l.Rows = append(l.Rows, mail.Row{Label: name, Value: mail.FormatDate(lang, at), Href: strings.TrimRight(site, "/") + "/projects/" + p.ID})
	}
	l.After = []string{t(lang, "fk1.keep")}
	l.Button, l.ButtonURL = t(lang, "fk1.button"), strings.TrimRight(site, "/")+"/projects"
	l.Reason = t(lang, "common.reason.files")
	return l
}

// purgeProjectFiles erases a project's stored files (live) or logs what
// it would erase (dry run). A project with a run in progress waits.
func (s *Service) purgeProjectFiles(ctx context.Context, p *store.Project, live bool, now time.Time, stats map[string]int) {
	if (!live && p.FilesDryRunAt != nil) || p.Sample {
		return // the sample's files are the CDN's, shared
	}
	convs, err := s.Store.ListProjectConversions(ctx, p.ID, 500)
	if err != nil {
		slog.WarnContext(ctx, "file keeping: runs not listed", "project_id", p.ID, "err", err)
		return
	}
	if slices.ContainsFunc(convs, func(c *store.Conversion) bool { return !store.IsTerminal(c.State) }) {
		return
	}
	keys, folders := projectFileTargets(p, convs, s.GCS.Prefix(), s.GCS.KeyFromPublicURL)
	if src := p.Source.GCSKey; src != "" && s.GCS.InPrefix(src) {
		shared := false
		if others, err := s.Store.ListProjectsBySource(ctx, src); err != nil {
			shared = true // can't tell: keep it
		} else {
			shared = slices.ContainsFunc(others, func(o *store.Project) bool { return o.ID != p.ID && o.FilesDeletedAt == nil })
		}
		if !shared {
			keys = append(keys, src)
		}
	}
	for _, f := range folders {
		found, err := s.GCS.List(ctx, f)
		if err != nil {
			slog.WarnContext(ctx, "file keeping: folder not listed", "project_id", p.ID, "folder", f, "err", err)
			return
		}
		for _, k := range found {
			if !slices.Contains(keys, k) {
				keys = append(keys, k)
			}
		}
	}
	if !live {
		slog.InfoContext(ctx, "file keeping: dry run, nothing erased", "project_id", p.ID, "uid", p.UID,
			"deleted_project", p.Deleted, "objects", len(keys), "sample", keys[:min(len(keys), 5)])
		_, _ = s.Store.UpdateProjectQuiet(ctx, p.ID, func(pp *store.Project) error {
			pp.FilesDryRunAt = &now
			return nil
		})
		stats["purge_dry_run"]++
		return
	}
	for _, k := range keys {
		if err := s.GCS.Delete(ctx, k); err != nil {
			slog.WarnContext(ctx, "file keeping: delete failed, retried next sweep", "project_id", p.ID, "key", path.Base(k), "err", err)
			return
		}
	}
	if _, err := s.Store.UpdateProjectQuiet(ctx, p.ID, func(pp *store.Project) error {
		pp.FilesDeletedAt = &now
		pp.PreviewURL, pp.StripThumbs, pp.SceneThumbs, pp.Poster, pp.DepthUpload = "", nil, nil, nil, nil
		return nil
	}); err != nil {
		slog.WarnContext(ctx, "file keeping: erased but not recorded", "project_id", p.ID, "err", err)
		return
	}
	slog.InfoContext(ctx, "file keeping: files erased", "project_id", p.ID, "uid", p.UID, "deleted_project", p.Deleted, "objects", len(keys))
	stats["purged"]++
}
