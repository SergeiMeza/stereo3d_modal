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
	"mvhevc": {sampleCDN + "sunset-session-spatial.mov", 319_972_232},
	"sbs":    {sampleCDN + "sunset-session-sbs.mp4", 299_105_920},
}

// sampleSince: accounts that already existed before onboarding shipped
// get no sample and read welcome_done (they've used the app).
var sampleSince = time.Date(2026, 11, 4, 3, 0, 0, 0, time.UTC)

// oldAccounts: uids this instance found to predate onboarding.
var oldAccounts sync.Map

func errSampleProject() *httpx.APIError {
	return httpx.Err(http.StatusUnprocessableEntity, "sample_project", "This is a sample project. Add your own video to make 3D.")
}

// ValidResourceID: project and conversion ids in routes are 12 lowercase
// hex characters (store.NewID); anything else is 404 before a lookup.
func ValidResourceID(id string) bool {
	return len(id) == 12 && !strings.ContainsFunc(id, func(c rune) bool {
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

// existingAccount: the account was in use before onboarding shipped (a
// customer record or a project from before then).
func existingAccount(cust *store.Customer, projects []*store.Project) bool {
	if cust != nil && !cust.CreatedAt.IsZero() && cust.CreatedAt.Before(sampleSince) {
		return true
	}
	for _, p := range projects {
		if !p.Sample && !p.CreatedAt.IsZero() && p.CreatedAt.Before(sampleSince) {
			return true
		}
	}
	return false
}

// ensureSample seeds the sample on a new account's project list and
// reports whether it was added now. projects is the account's listing
// (archived and deleted included).
func (s *Service) ensureSample(ctx context.Context, uid string, projects []*store.Project) (*store.Project, bool) {
	id := sampleProjectID(uid)
	var legacy *store.Project
	for _, p := range projects {
		if p.ID == id {
			return nil, false // seeded before (archived or deleted stays so)
		}
		if p.Sample {
			if p.Deleted {
				return nil, false // they deleted the earlier one
			}
			legacy = p
		}
	}
	if legacy != nil {
		// An "smp…" sample the routes couldn't open: retire it for one
		// with a proper id (the account is new by construction).
		if _, err := s.Store.UpdateProject(ctx, legacy.ID, func(pp *store.Project) error {
			pp.Deleted = true
			return nil
		}); err != nil {
			slog.WarnContext(ctx, "legacy sample not retired", "uid", uid, "project_id", legacy.ID, "err", err)
			return nil, false
		}
		projects = slices.DeleteFunc(slices.Clone(projects), func(p *store.Project) bool { return p.ID == legacy.ID })
	} else if _, known := oldAccounts.Load(uid); known || existingAccount(nil, projects) {
		return nil, false
	}
	cust, _ := s.Store.GetCustomer(ctx, uid)
	if legacy == nil && existingAccount(cust, projects) {
		oldAccounts.Store(uid, true)
		return nil, false
	}
	if _, err := s.Store.GetProject(ctx, id); err == nil || !errors.Is(err, store.ErrNotFound) {
		return nil, false // past the listing window, or storage trouble
	}
	thumbs := make([]store.Thumb, 30)
	for i := range thumbs {
		thumbs[i] = store.Thumb{Frame: i * 375 / 30, URL: samplePoster}
	}
	p := &store.Project{ID: id, UID: uid, Env: s.Cfg.Env, Name: "Sunset session", Method: store.MethodLifelike, Sample: true,
		Source: store.Source{Bytes: 29_190_011, DurationS: 15, Frames: 375, FPS: 25, Width: 3840, Height: 2160},
		Probe: &store.Probe{Width: 3840, Height: 2160, FPS: 25, FPSRational: "25/1", DurationS: 15, NumFrames: 375,
			BitRate: 15_560_513, CountedFrames: 375},
		Analyze:     store.Analyze{State: store.AnalyzeSucceeded},
		Scenes:      &store.Scenes{Version: 1, Cuts: []int{}},
		PreviewURL:  sampleCDN + "sunset-session-2d.mp4",
		StripThumbs: thumbs, SceneThumbs: []store.Thumb{{Frame: 0, URL: samplePoster}},
	}
	if err := s.Store.CreateProject(ctx, p); err != nil {
		return nil, false // a racing list made it
	}
	run := &store.Conversion{ID: sampleRunID(uid), UID: uid, Env: s.Cfg.Env, Sample: true, Kind: "video", ProjectID: id,
		Step: store.StepProduction, Method: store.MethodLifelike, State: store.StateSucceeded,
		Source: p.Source, Params: store.Params{Preset: "4k", Formats: []string{"mvhevc", "sbs"}},
		Quote: store.Quote{AmountCents: 0, Currency: "usd", Breakdown: map[string]any{
			"billable_seconds": 15.0, "billable_minutes": int64(1), "sample": true}},
		Outputs: map[string]string{}}
	for name, f := range sampleFiles {
		run.Outputs[name] = f.URL
	}
	if err := s.Store.CreateConversion(ctx, run); err != nil {
		slog.WarnContext(ctx, "sample run not stored", "uid", uid, "err", err)
	}
	return p, true
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
		if sf, ok := sampleFiles[name]; ok {
			f.SizeBytes = sf.Bytes
		}
		files = append(files, f)
	}
	sortOutputFiles(files)
	return map[string]any{"downloads": urls, "files": files, "expires_in": int(downloadTTL.Seconds())}
}
