package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"log/slog"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The onboarding sample (owner 2026-11-04): on an account's first project
// list, a finished Lifelike "Sunset session" (4K per eye, 15 s at 25 fps)
// with a succeeded full run. Its files are the public CDN's 2026-11
// sample set, referenced, never copied per account (our bucket ages
// objects out at 90 days; the CDN keeps them). The thumbnails are the
// web's own poster (a path on the web's origin, as the web's mock has
// it). It's read-only: quotes and runs on it are 422 sample_project; it
// archives, unarchives and deletes like any project, its files are never
// purged, and it never counts in usage, KPIs or billing reports
// (Conversion.Sample, Project.Sample).

const sampleCDN = "https://cdn.public.spatial-video-studio.com/samples/2026-11/"

// samplePoster is on the web's origin (public/landing/samples).
const samplePoster = "/landing/samples/sunset-session-poster-1600.webp"

var sampleFiles = map[string]struct {
	URL   string
	Bytes int64
}{
	"mvhevc":   {sampleCDN + "sunset-session-spatial.mov", 319_972_232},
	"sbs":      {sampleCDN + "sunset-session-sbs.mp4", 299_105_920},
	"half_sbs": {sampleCDN + "sunset-session-half-sbs.mp4", 150_013_970}, // owner 2026-11-04, ADR 0137
}

// sampleSizes: the sample's finished runs below its 4K source (owner
// 2026-11-07), so people can download and compare: 1080p, 1440p and 3K,
// each in every format, rendered from the same 15 s (Master bitrate, no
// audio, no intro) and on the same CDN. Older first; the 4K run stays the
// newest, the one the project shows first.
var sampleSizes = []struct {
	Preset        string
	Width, Height int
	Files         map[string]struct {
		URL   string
		Bytes int64
	}
}{
	{"1080p", 1920, 1080, map[string]struct {
		URL   string
		Bytes int64
	}{
		"mvhevc": {sampleCDN + "sunset-session-1080p-spatial.mov", 141_603_183}, "sbs": {sampleCDN + "sunset-session-1080p-sbs.mp4", 113_521_804},
		"half_sbs": {sampleCDN + "sunset-session-1080p-half-sbs.mp4", 113_667_279}}},
	{"qhd", 2560, 1440, map[string]struct {
		URL   string
		Bytes int64
	}{
		"mvhevc": {sampleCDN + "sunset-session-qhd-spatial.mov", 184_167_835}, "sbs": {sampleCDN + "sunset-session-qhd-sbs.mp4", 152_013_085},
		"half_sbs": {sampleCDN + "sunset-session-qhd-half-sbs.mp4", 151_731_056}}},
	{"3k", 2880, 1620, map[string]struct {
		URL   string
		Bytes int64
	}{
		"mvhevc": {sampleCDN + "sunset-session-3k-spatial.mov", 185_915_748}, "sbs": {sampleCDN + "sunset-session-3k-sbs.mp4", 198_475_572},
		"half_sbs": {sampleCDN + "sunset-session-3k-half-sbs.mp4", 199_412_782}}},
}

// sampleFormats: the sample run has every format, so "Get another
// format" never runs on it.
var sampleFormats = []string{"mvhevc", "sbs", "half_sbs"}

// backfillSampleRun adds the sampleFiles a stored sample run lacks (runs
// stored before half_sbs joined) to its outputs and formats. Idempotent;
// any other run is returned untouched.
func (s *Service) backfillSampleRun(ctx context.Context, c *store.Conversion) *store.Conversion {
	if c == nil || !c.Sample || c.State != store.StateSucceeded || c.ID != sampleRunID(c.UID) {
		return c // the 4K run only; the smaller sizes were stored whole
	}
	missing := func(x *store.Conversion) bool {
		for name := range sampleFiles {
			if x.Outputs[name] == "" {
				return true
			}
		}
		for _, f := range sampleFormats {
			if !slices.Contains(x.Params.Formats, f) {
				return true
			}
		}
		return false
	}
	if !missing(c) {
		return c
	}
	updated, err := s.Store.Transition(ctx, c.ID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		if !x.Sample || !missing(x) {
			return errNoChange
		}
		if x.Outputs == nil {
			x.Outputs = map[string]string{}
		}
		for name, f := range sampleFiles {
			if x.Outputs[name] == "" {
				x.Outputs[name] = f.URL
			}
		}
		for _, f := range sampleFormats {
			if !slices.Contains(x.Params.Formats, f) {
				x.Params.Formats = append(x.Params.Formats, f)
			}
		}
		return nil
	})
	if err != nil {
		if !errors.Is(err, errNoChange) {
			slog.WarnContext(ctx, "sample run not backfilled", "conversion_id", c.ID, "err", err)
		}
		if fresh, gerr := s.Store.GetConversion(ctx, c.ID); gerr == nil {
			return fresh
		}
		return c
	}
	return updated
}

// backfilledSamples: uids whose sample run this instance has checked.
var backfilledSamples sync.Map

// backfillSampleOf checks the account's sample run once per instance (the
// list path).
func (s *Service) backfillSampleOf(ctx context.Context, uid string) {
	if _, done := backfilledSamples.Load(uid); done {
		return
	}
	if c, err := s.Store.GetConversion(ctx, sampleRunID(uid)); err == nil && c.UID == uid {
		c = s.backfillSampleRun(ctx, c)
		s.ensureSampleSizes(ctx, uid, c) // the 1080p, 1440p and 3K runs, once
	}
	backfilledSamples.Store(uid, true)
}

func errSampleProject() *httpx.APIError {
	return httpx.Err(http.StatusUnprocessableEntity, "sample_project", "This is a sample project. Add your own video to make 3D.")
}

// ValidResourceID: project and conversion ids in routes are 12 lowercase
// hex characters (store.NewID), or "k" + 15 for a run started with an
// Idempotency-Key (store.IdemConversionID); anything else is 404 before a
// lookup.
func ValidResourceID(id string) bool {
	if len(id) == 16 && id[0] == 'k' {
		return isLowerHex(id[1:])
	}
	return len(id) == 12 && isLowerHex(id)
}

func isLowerHex(s string) bool {
	return !strings.ContainsFunc(s, func(c rune) bool {
		return !strings.ContainsRune("0123456789abcdef", c)
	})
}

// sampleProjectID and sampleRunID are the account's sample's fixed ids
// (12 hex, like every id the routes take), so seeding is idempotent
// across racing lists. Samples made before 2026-11-04 05:00 UTC had
// "smp…" ids the routes refused; ensureSample replaces them.
func sampleProjectID(uid string) string {
	h := sha256.Sum256([]byte("sample:sunset-session:" + uid))
	return hex.EncodeToString(h[:])[:12]
}

func sampleRunID(uid string) string {
	h := sha256.Sum256([]byte("sample-run:sunset-session:" + uid))
	return hex.EncodeToString(h[:])[:12]
}

// sampleSizeRunID is the fixed id of the sample's run at a smaller size.
func sampleSizeRunID(uid, preset string) string {
	h := sha256.Sum256([]byte("sample-run:sunset-session:" + preset + ":" + uid))
	return hex.EncodeToString(h[:])[:12]
}

// ensureSample gives the account its "Sunset session" sample (owner
// 2026-11-07, final rule): every account that hasn't had one gets it
// exactly once, on its first project list — new, old or prod at launch,
// whatever its age or onboarding state — and never again
// (customer.sample_created_at). The user can delete it, and a deleted
// sample stays deleted. Only accounts pending deletion (or deleted) get
// none. An old "smp…" sample still visible is replaced once by the
// fixed-id one, so there's never a second visible sample. It reports the
// sample when it added one now (projects is the account's listing,
// archived and deleted included).
func (s *Service) ensureSample(ctx context.Context, uid string, projects []*store.Project) (*store.Project, bool) {
	id := sampleProjectID(uid)
	var current, legacy *store.Project
	classify := func(ps []*store.Project) {
		for _, p := range ps {
			switch {
			case p.ID == id:
				current = p
			case p.Sample && !ValidResourceID(p.ID) && (legacy == nil || legacy.Deleted):
				legacy = p
			}
		}
	}
	classify(projects)
	if current != nil { // there (archived, or deleted by the user and staying so)
		if !current.Deleted {
			s.backfillSampleOf(ctx, uid) // a run stored before half_sbs joined
		}
		s.markSample(ctx, uid) // samples made before the marker
		return nil, false
	}
	if _, done := sampleDone.Load(uid); done {
		return nil, false // this instance saw the marker: never twice
	}
	if legacy == nil {
		samples, err := s.Store.ListUserSamples(ctx, uid) // past the listing window
		if err != nil {
			slog.WarnContext(ctx, "samples unreadable", "err", err)
			return nil, false
		}
		classify(samples)
		if current != nil {
			s.markSample(ctx, uid)
			return nil, false
		}
	}
	cust, err := s.Store.GetCustomer(ctx, uid)
	if err != nil && !errors.Is(err, store.ErrNotFound) {
		slog.WarnContext(ctx, "sample: account unreadable", "err", err)
		return nil, false
	}
	if cust != nil && cust.SampleCreatedAt != nil {
		sampleDone.Store(uid, true) // had one: never twice
		return nil, false
	}
	if legacy != nil && legacy.Deleted {
		s.markSample(ctx, uid) // the user deleted it under the old ids: it stays deleted
		return nil, false
	}
	if cust != nil && (cust.AccountDeleted || cust.DeletionPending) {
		return nil, false
	}
	if s.Store.PendingAccountDeletion(ctx, uid) != nil { // the 48-hour wait
		return nil, false
	}
	archived := false
	if legacy != nil { // a visible old "smp…" sample: replaced once, still one sample
		archived = legacy.Archived
		if _, err := s.Store.UpdateProject(ctx, legacy.ID, func(pp *store.Project) error {
			pp.Deleted = true // replaced below
			return nil
		}); err != nil {
			slog.WarnContext(ctx, "legacy sample not retired", "project_id", legacy.ID, "err", err)
			return nil, false
		}
	}
	return s.createSample(ctx, uid, archived)
}

// sampleDone: uids this instance saw marked with no sample left (only
// skips reads; the marker decides). sampleMarked: uids this instance
// marked (skips a redundant write).
var sampleDone, sampleMarked sync.Map

// markSample records the account's sample once.
func (s *Service) markSample(ctx context.Context, uid string) {
	if _, ok := sampleMarked.Load(uid); ok {
		return
	}
	if err := s.Store.MarkSampleCreated(ctx, uid, time.Now().UTC()); err != nil {
		slog.WarnContext(ctx, "sample marker not stored", "err", err)
		return
	}
	sampleMarked.Store(uid, true)
}

func (s *Service) createSample(ctx context.Context, uid string, archived bool) (*store.Project, bool) {
	thumbs := make([]store.Thumb, 30)
	for i := range thumbs {
		thumbs[i] = store.Thumb{Frame: i * 375 / 30, URL: samplePoster}
	}
	p := &store.Project{ID: sampleProjectID(uid), UID: uid, Env: s.Cfg.Env, Name: "Sunset session", Method: store.MethodLifelike,
		Sample: true, Archived: archived,
		Source: store.Source{Bytes: 29_190_011, DurationS: 15, Frames: 375, FPS: 25, Width: 3840, Height: 2160},
		Probe: &store.Probe{Width: 3840, Height: 2160, FPS: 25, FPSRational: "25/1", DurationS: 15, NumFrames: 375,
			BitRate: 15_560_513, CountedFrames: 375},
		Analyze:     store.Analyze{State: store.AnalyzeSucceeded},
		Scenes:      &store.Scenes{Version: 1, Cuts: []int{}},
		PreviewURL:  sampleCDN + "sunset-session-2d.mp4",
		StripThumbs: thumbs, SceneThumbs: []store.Thumb{{Frame: 0, URL: samplePoster}}, Poster: &store.Thumb{Frame: 0, URL: samplePoster},
	}
	if err := s.Store.CreateProject(ctx, p); err != nil { // create-if-absent on the fixed id
		if errors.Is(err, store.ErrAlreadyExists) {
			s.markSample(ctx, uid) // a racing list made it
		} else {
			slog.WarnContext(ctx, "sample not created", "err", err)
		}
		return nil, false
	}
	s.markSample(ctx, uid)
	s.ensureSampleRun(ctx, uid, p)
	return p, true
}

// ensureSampleRun stores the sample's finished run (kept when it's there).
func (s *Service) ensureSampleRun(ctx context.Context, uid string, p *store.Project) {
	run := &store.Conversion{ID: sampleRunID(uid), UID: uid, Env: s.Cfg.Env, Sample: true, Kind: "video", ProjectID: p.ID,
		Step: store.StepProduction, Method: store.MethodLifelike, State: store.StateSucceeded,
		Source: p.Source, Params: store.Params{Preset: "4k", Formats: slices.Clone(sampleFormats)},
		Quote: store.Quote{AmountCents: 0, Currency: "usd", Breakdown: map[string]any{
			"billable_seconds": 15.0, "billable_minutes": int64(1), "sample": true}},
		Outputs: map[string]string{}}
	for name, f := range sampleFiles {
		run.Outputs[name] = f.URL
	}
	if err := s.Store.CreateConversion(ctx, run); err != nil && !errors.Is(err, store.ErrAlreadyExists) {
		slog.WarnContext(ctx, "sample run not stored", "project_id", p.ID, "err", err)
		return
	}
	if stored, err := s.Store.GetConversion(ctx, run.ID); err == nil {
		s.ensureSampleSizes(ctx, uid, stored)
	}
}

// ensureSampleSizes stores the sample's 1080p, 1440p and 3K runs beside
// its 4K one (kept when they're there), each a second older than the
// last so the 4K run stays the newest. Read-only, never billed or
// purged, like the 4K run (Sample).
func (s *Service) ensureSampleSizes(ctx context.Context, uid string, main *store.Conversion) {
	if main == nil || !main.Sample || main.UID != uid {
		return
	}
	for i, sz := range sampleSizes {
		run := &store.Conversion{ID: sampleSizeRunID(uid, sz.Preset), UID: uid, Env: main.Env, Sample: true, Kind: "video",
			ProjectID: main.ProjectID, Step: store.StepProduction, Method: store.MethodLifelike, State: store.StateSucceeded,
			Source: main.Source, Params: store.Params{Preset: sz.Preset, Formats: slices.Clone(sampleFormats), TargetFPS: 25,
				OutputWidth: sz.Width, OutputHeight: sz.Height},
			Quote: store.Quote{AmountCents: 0, Currency: "usd", Breakdown: map[string]any{
				"billable_seconds": 15.0, "billable_minutes": int64(1), "sample": true}},
			Outputs:   map[string]string{},
			CreatedAt: main.CreatedAt.Add(-time.Duration(len(sampleSizes)-i) * time.Second)}
		for name, f := range sz.Files {
			run.Outputs[name] = f.URL
		}
		if err := s.Store.CreateConversionAt(ctx, run); err != nil && !errors.Is(err, store.ErrAlreadyExists) {
			slog.WarnContext(ctx, "sample size run not stored", "preset", sz.Preset, "err", err)
		}
	}
}

// removeSamples: account deletion takes the sample with it.
func (s *Service) removeSamples(ctx context.Context, uid string) {
	samples, err := s.Store.ListUserSamples(ctx, uid)
	if err != nil {
		slog.WarnContext(ctx, "samples not removed", "err", err)
		return
	}
	now := time.Now().UTC()
	for _, p := range samples {
		if !p.Deleted {
			s.Store.UpdateProject(ctx, p.ID, func(pp *store.Project) error {
				pp.Deleted, pp.DeletedAt = true, &now
				return nil
			})
		}
	}
}

// sampleDownloads answers GET downloads for the sample's run: the CDN's
// public URLs as they are (they carry their own download names).
func sampleDownloads(c *store.Conversion) map[string]any {
	urls := map[string]string{}
	files := make([]outputFile, 0, len(c.Outputs))
	for name, u := range c.Outputs {
		urls[name] = u
		format, part := splitOutputName(name)
		f := outputFile{Name: name, Format: format, Part: part, URL: u}
		if sf, ok := sampleFiles[name]; ok && sf.URL == u {
			f.SizeBytes = sf.Bytes
		}
		for _, sz := range sampleSizes {
			if sf, ok := sz.Files[name]; ok && sf.URL == u {
				f.SizeBytes = sf.Bytes
			}
		}
		files = append(files, f)
	}
	sortOutputFiles(files)
	return map[string]any{"downloads": urls, "files": files, "expires_in": int(downloadTTL.Seconds())}
}
