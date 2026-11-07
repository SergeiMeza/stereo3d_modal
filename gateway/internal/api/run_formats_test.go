package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"cloud.google.com/go/storage"

	"spatial-ai-labs/stereo3d-gateway/internal/gcsx"
	"spatial-ai-labs/stereo3d-gateway/internal/modalapi"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// lifelikeStub answers POST /repack and GET /repack/{id} like the
// Lifelike service; status says what a poll answers.
type lifelikeStub struct {
	mu       sync.Mutex
	bodies   []map[string]any
	status   string
	progress *float64
	failNew  bool
	ids      []string          // repack ids handed out, in order
	byID     map[string]string // a status for one repack over status
}

func (l *lifelikeStub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	l.mu.Lock()
	defer l.mu.Unlock()
	switch {
	case r.Method == http.MethodPost && r.URL.Path == "/repack":
		if l.failNew {
			w.WriteHeader(503)
			return
		}
		var b map[string]any
		json.NewDecoder(r.Body).Decode(&b)
		l.bodies = append(l.bodies, b)
		id := "rp" + store.NewID()
		l.ids = append(l.ids, id)
		w.WriteHeader(202)
		json.NewEncoder(w).Encode(map[string]any{"repack_id": id})
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/repack/"):
		status := l.status
		if st, ok := l.byID[strings.TrimPrefix(r.URL.Path, "/repack/")]; ok {
			status = st
		}
		out := map[string]any{"status": status, "cost_stage": "repack"}
		if l.progress != nil {
			out["progress"] = *l.progress
		}
		if status == "done" || status == "completed" {
			out["output"] = map[string]any{"bytes": 1000, "width": 3840, "height": 2160, "frames": 240, "level": "5.1"}
			out["metadata"] = map[string]any{"outputs_media": map[string]any{"mvhevc": map[string]any{"video_kbps": 41000, "audio_codec": "aac", "audio_kbps": 250},
				"sbs": map[string]any{"video_kbps": 52000, "audio_codec": nil, "audio_kbps": nil}}}
		}
		if status == "failed" {
			out["error"] = "decoder"
		}
		json.NewEncoder(w).Encode(out)
	default:
		w.WriteHeader(404)
	}
}

func formatsService(t *testing.T) (*Service, *lifelikeStub) {
	s, _ := e0Service(t)
	stub := &lifelikeStub{status: "running"}
	srv := httptest.NewServer(stub)
	t.Cleanup(srv.Close)
	s.Lifelike = modalapi.New(srv.URL, "", "")
	s.GCS = gcsx.NewWithSigner("bucket", "stereo3d/test/", func(key string, o *storage.SignedURLOptions) (string, error) {
		return "https://signed/" + o.Method + "/" + key, nil
	}, nil)
	return s, stub
}

// finishedRun: a succeeded Lifelike run in a live project with outputs.
func finishedRun(t *testing.T, s *Service, uid, preset string, outputs ...string) *store.Conversion {
	t.Helper()
	ctx := context.Background()
	p := &store.Project{ID: store.NewID(), UID: uid, Name: "Beach"}
	if err := s.Store.CreateProject(ctx, p); err != nil {
		t.Fatal(err)
	}
	c := &store.Conversion{ID: store.NewID(), UID: uid, State: store.StateSucceeded, Kind: "video", Method: store.MethodLifelike, ProjectID: p.ID,
		Params: store.Params{Preset: preset, Formats: outputs}, Source: store.Source{FPS: 30}, Outputs: map[string]string{}}
	c.Modal.JobID = "job" + c.ID
	for _, o := range outputs {
		ext := ".mp4"
		if strings.HasPrefix(o, "mvhevc") {
			ext = ".mov"
		}
		c.Outputs[o] = "stereo3d/test/outputs/" + c.Modal.JobID + "/" + o + ext
	}
	if err := s.Store.CreateConversion(ctx, c); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Store.Transition(ctx, c.ID, []string{store.StateSucceeded}, func(x *store.Conversion) error { x.State = store.StateSucceeded; return nil }); err != nil {
		t.Fatal(err)
	}
	return c
}

func formatsCall(s *Service, uid, id, method, body string) (int, map[string]any) {
	w := httptest.NewRecorder()
	r := httptest.NewRequest(method, "/v1/runs/"+id+"/formats", strings.NewReader(body))
	u := &AuthedUser{UID: uid}
	if method == http.MethodGet {
		s.HandleRunFormats(w, r, u, id)
	} else {
		s.HandleRunFormatAdd(w, r, u, id)
	}
	var out map[string]any
	json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

func strs(v any) []string {
	var out []string
	for _, x := range v.([]any) {
		out = append(out, x.(string))
	}
	return out
}

// A half SBS + full SBS run gets spatial from the full SBS; the file
// joins the outputs when the repack completes; one per format; a failed
// one can be retried.
func TestRunFormatsRepack(t *testing.T) {
	s, stub := formatsService(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	c := finishedRun(t, s, uid, "4k", "sbs", "half_sbs")
	code, out := formatsCall(s, uid, c.ID, http.MethodGet, "")
	if code != 200 || strings.Join(strs(out["available"]), ",") != "mvhevc" || strings.Join(strs(out["have"]), ",") != "sbs,half_sbs" ||
		out["unavailable_reason"] != nil || out["price_cents"] != float64(0) {
		t.Fatalf("formats %d %v", code, out)
	}
	code, out = formatsCall(s, uid, c.ID, http.MethodPost, `{"format":"mvhevc"}`)
	if code != 202 || out["job_id"] == nil || out["status"] != "processing" || out["source"] != "sbs" || out["price_cents"] != float64(0) {
		t.Fatalf("start %d %v", code, out)
	}
	b := stub.bodies[0]
	src := b["source"].(map[string]any)
	if b["target_format"] != "mvhevc" || src["format"] != "sbs" || !strings.HasPrefix(src["url"].(string), "https://signed/GET/stereo3d/test/outputs/"+c.Modal.JobID+"/sbs.mp4") ||
		b["output_upload_url"] != "https://signed/PUT/stereo3d/test/outputs/"+c.Modal.JobID+"/repack_mvhevc.mov" || b["preset"] != "4k" || b["fps"] != float64(30) || b["job_id"] != c.Modal.JobID ||
		b["output_bitrate_bps"] != nil {
		t.Fatalf("repack body %v", b)
	}
	if code, out := formatsCall(s, uid, c.ID, http.MethodPost, `{"format":"mvhevc"}`); code != 409 || out["error"] != "format_in_progress" {
		t.Fatalf("second start %d %v", code, out)
	}
	if p, _ := s.Store.GetProject(ctx, c.ProjectID); p.LastActivityAt == nil {
		t.Fatal("counts as use")
	}
	// The reconciler's poll: completed → the file joins the outputs.
	stub.status = "done"
	if n := s.pollAllRepacks(ctx); n < 1 {
		t.Fatal("not polled")
	}
	got, _ := s.Store.GetConversion(ctx, c.ID)
	if got.Outputs["mvhevc"] != "stereo3d/test/outputs/"+c.Modal.JobID+"/repack_mvhevc.mov" || got.RepackPending || got.Repacks["mvhevc"].Width != 3840 {
		t.Fatalf("after %+v %+v", got.Outputs, got.Repacks["mvhevc"])
	}
	if m := got.OutputsMedia["mvhevc"]; m.Source != "worker" || m.VideoKbps != 41000 || m.AudioCodec != "aac" { // the repack's metadata.outputs_media.<target>
		t.Fatalf("repack media %+v", got.OutputsMedia)
	}
	if names := projectDownloadNames(nil, []*store.Conversion{got}); names[c.ID]["mvhevc"] == "" {
		t.Fatalf("download name %v", names)
	}
	code, out = formatsCall(s, uid, c.ID, http.MethodGet, "")
	if len(strs(out["available"])) != 0 || len(strs(out["have"])) != 3 {
		t.Fatalf("after %v", out)
	}
	if code, out := formatsCall(s, uid, c.ID, http.MethodPost, `{"format":"mvhevc"}`); code != 409 || out["error"] != "format_exists" {
		t.Fatalf("again %d %v", code, out)
	}

	// A failure, then a retry.
	d := finishedRun(t, s, uid, "4k", "mvhevc")
	stub.status = "running"
	formatsCall(s, uid, d.ID, http.MethodPost, `{"format":"half_sbs"}`)
	stub.status = "failed"
	formatsCall(s, uid, d.ID, http.MethodGet, "") // the GET polls too
	got, _ = s.Store.GetConversion(ctx, d.ID)
	if r := got.Repacks["half_sbs"]; r == nil || r.Status != "failed" || r.Error != "decoder" || got.Outputs["half_sbs"] != "" {
		t.Fatalf("failed %+v", r)
	}
	stub.status = "running"
	if code, out := formatsCall(s, uid, d.ID, http.MethodPost, `{"format":"half_sbs"}`); code != 202 || stub.bodies[len(stub.bodies)-1]["source"].(map[string]any)["format"] != "mvhevc" {
		t.Fatalf("retry %d %v", code, out)
	}
	if got, _ = s.Store.GetConversion(ctx, d.ID); got.Repacks["half_sbs"].Attempts != 2 {
		t.Fatalf("attempts %d", got.Repacks["half_sbs"].Attempts)
	}
	// queued is in progress.
	stub.status = "queued"
	if got := s.pollRepacks(ctx, got); got != nil {
		t.Fatalf("queued changed the run: %+v", got.Repacks["half_sbs"])
	}
	// Sources per target: half SBS from spatial before full SBS; spatial
	// only from full SBS; full SBS only from spatial.
	both := finishedRun(t, s, uid, "4k", "sbs", "mvhevc")
	if st := s.runFormatsOf(ctx, both); st.Sources["half_sbs"] != "mvhevc" || strings.Join(st.Available, ",") != "half_sbs" {
		t.Fatalf("both %+v", st)
	}
	if st := s.runFormatsOf(ctx, finishedRun(t, s, uid, "4k", "sbs")); st.Sources["half_sbs"] != "sbs" || st.Sources["mvhevc"] != "sbs" {
		t.Fatalf("sbs only %+v", st.Sources)
	}
	if st := s.runFormatsOf(ctx, finishedRun(t, s, uid, "4k", "mvhevc", "half_sbs")); st.Sources["sbs"] != "mvhevc" || strings.Join(st.Available, ",") != "sbs" {
		t.Fatalf("mvhevc + half %+v", st)
	}
	// A run with its own bitrate (Master) sends it along.
	master := finishedRun(t, s, uid, "4k", "sbs")
	s.Store.Transition(ctx, master.ID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		x.Params.Bitrate, x.Params.OutputBitrateBps = bitrateMaster, 150_000_000
		return nil
	})
	stub.status = "running"
	if code, _ := formatsCall(s, uid, master.ID, http.MethodPost, `{"format":"half_sbs"}`); code != 202 || stub.bodies[len(stub.bodies)-1]["output_bitrate_bps"] != float64(150_000_000) {
		t.Fatalf("bitrate %d %v", code, stub.bodies[len(stub.bodies)-1])
	}
	// Admin history.
	if h := repacksHistory(got); len(h) != 1 || h[0]["format"] != "half_sbs" {
		t.Fatalf("history %v", h)
	}
}

// Refused: half SBS only, files erased, a failed run, full SBS at 6K,
// another account's run, an unknown format, Lifelike down.
func TestRunFormatsRules(t *testing.T) {
	s, stub := formatsService(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	reason := func(c *store.Conversion) any {
		_, out := formatsCall(s, uid, c.ID, http.MethodGet, "")
		return out["unavailable_reason"]
	}
	half := finishedRun(t, s, uid, "4k", "half_sbs")
	if reason(half) != "half_only" {
		t.Fatal("half only")
	}
	if code, out := formatsCall(s, uid, half.ID, http.MethodPost, `{"format":"sbs"}`); code != 409 || out["error"] != "format_unavailable" || out["details"].(map[string]any)["reason"] != "half_only" {
		t.Fatalf("half only post %d %v", code, out)
	}
	erased := finishedRun(t, s, uid, "4k", "sbs")
	now := time.Now()
	s.Store.UpdateProjectQuiet(ctx, erased.ProjectID, func(p *store.Project) error { p.FilesDeletedAt = &now; return nil })
	if reason(erased) != "files_erased" {
		t.Fatal("erased")
	}
	failed := finishedRun(t, s, uid, "4k", "sbs")
	s.Store.Transition(ctx, failed.ID, []string{store.StateSucceeded}, func(x *store.Conversion) error { x.State = store.StateFailed; return nil })
	if reason(failed) != "run_failed" {
		t.Fatal("failed run")
	}
	wide := finishedRun(t, s, uid, "6k", "mvhevc")
	_, out := formatsCall(s, uid, wide.ID, http.MethodGet, "")
	if strings.Join(strs(out["available"]), ",") != "half_sbs" {
		t.Fatalf("6k %v", out)
	}
	if code, _ := formatsCall(s, uid, wide.ID, http.MethodPost, `{"format":"sbs"}`); code != 409 {
		t.Fatalf("6k sbs %d", code)
	}
	if code, _ := formatsCall(s, "someone-else", wide.ID, http.MethodGet, ""); code != 404 {
		t.Fatalf("another account %d", code)
	}
	if code, _ := formatsCall(s, uid, wide.ID, http.MethodPost, `{"format":"anaglyph"}`); code != 400 {
		t.Fatalf("unknown format %d", code)
	}
	stub.failNew = true
	if code, out := formatsCall(s, uid, wide.ID, http.MethodPost, `{"format":"half_sbs"}`); code != 502 || out["error"] != "repack_unavailable" {
		t.Fatalf("lifelike down %d %v", code, out)
	}
	if got, _ := s.Store.GetConversion(ctx, wide.ID); got.Repacks["half_sbs"].Status != "failed" || got.RepackPending {
		t.Fatalf("after a failed start %+v", got.Repacks["half_sbs"])
	}
}

// A split run gets one repack per part; the format is done when every
// part is, and a failed part is retried alone; part outputs are named
// like split outputs (half_sbs_part1, half_sbs_part2).
func TestRunFormatsSplitRun(t *testing.T) {
	s, stub := formatsService(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	c := finishedRun(t, s, uid, "4k", "mvhevc_part1", "mvhevc_part2", "sbs_part1", "sbs_part2")
	code, out := formatsCall(s, uid, c.ID, http.MethodGet, "")
	if code != 200 || strings.Join(strs(out["have"]), ",") != "mvhevc,sbs" || strings.Join(strs(out["available"]), ",") != "half_sbs" || out["unavailable_reason"] != nil {
		t.Fatalf("split formats %d %v", code, out)
	}
	code, out = formatsCall(s, uid, c.ID, http.MethodPost, `{"format":"half_sbs"}`)
	if code != 202 || len(strs(out["job_ids"])) != 2 || out["source"] != "mvhevc" {
		t.Fatalf("split post %d %v", code, out)
	}
	if len(stub.bodies) != 2 || !strings.HasSuffix(stub.bodies[1]["source"].(map[string]any)["url"].(string), "/mvhevc_part2.mov") ||
		!strings.HasSuffix(stub.bodies[1]["output_upload_url"].(string), "/repack_half_sbs_part2.mp4") {
		t.Fatalf("split bodies %v", stub.bodies)
	}
	stub.byID = map[string]string{stub.ids[0]: "done", stub.ids[1]: "running"}
	_, out = formatsCall(s, uid, c.ID, http.MethodGet, "")
	if strings.Join(strs(out["pending"]), ",") != "half_sbs" {
		t.Fatalf("one part done %v", out)
	}
	stub.byID[stub.ids[1]] = "failed"
	_, out = formatsCall(s, uid, c.ID, http.MethodGet, "")
	got, _ := s.Store.GetConversion(ctx, c.ID)
	if r := got.Repacks["half_sbs"]; r.Status != "failed" || got.Outputs["half_sbs_part1"] != "" || r.Parts[0].Status != "succeeded" || r.Parts[1].Status != "failed" {
		t.Fatalf("one part failed %+v %v", r, got.Outputs)
	}
	if strings.Join(strs(out["available"]), ",") != "half_sbs" {
		t.Fatalf("retryable %v", out)
	}
	code, out = formatsCall(s, uid, c.ID, http.MethodPost, `{"format":"half_sbs"}`)
	if code != 202 || len(stub.bodies) != 3 || !strings.HasSuffix(stub.bodies[2]["output_upload_url"].(string), "/repack_half_sbs_part2.mp4") {
		t.Fatalf("retry %d %v %d", code, out, len(stub.bodies))
	}
	stub.byID[stub.ids[2]] = "done"
	_, out = formatsCall(s, uid, c.ID, http.MethodGet, "")
	got, _ = s.Store.GetConversion(ctx, c.ID)
	if strings.Join(strs(out["have"]), ",") != "mvhevc,sbs,half_sbs" || got.RepackPending || got.Repacks["half_sbs"].Attempts != 2 ||
		!strings.HasSuffix(got.Outputs["half_sbs_part1"], "/repack_half_sbs_part1.mp4") || !strings.HasSuffix(got.Outputs["half_sbs_part2"], "/repack_half_sbs_part2.mp4") {
		t.Fatalf("split done %v %v", out, got.Outputs)
	}
}

// estimated_seconds: side-by-side ≈ 2× the length, spatial ≈ 10× at 4K,
// scaled by pixels, plus 30 s per file; spatial's give-up is max(3 h,
// 2× the estimate).
func TestRepackEstimate(t *testing.T) {
	// side-by-side: 1.6x at 1080p (+30 s): the 3:50 1080p run that took
	// ~6.3 min (377 s) estimates 398 s, not "about 2 minutes"
	c := &store.Conversion{Params: store.Params{Preset: "1080p"}, Source: store.Source{DurationS: 230}}
	if got := repackEstimate(c, "sbs"); got != 398 {
		t.Fatalf("1080p sbs %d", got)
	}
	// ≈ 2x at 4K: the 15 s 4K test (44-47 s with the start) estimates 61
	c = &store.Conversion{Params: store.Params{Preset: "4k"}, Source: store.Source{DurationS: 15}}
	if a, b := repackEstimate(c, "half_sbs"), repackEstimate(c, "mvhevc"); a != 61 || b != 180 { // mvhevc took 175-182 s
		t.Fatalf("4k %d %d", a, b)
	}
	c = &store.Conversion{Params: store.Params{Preset: "4k"}, Source: store.Source{DurationS: 60}}
	if got := repackEstimate(c, "mvhevc"); got != 630 {
		t.Fatalf("4k mvhevc %d", got)
	}
	c.Params.Preset = "1080p"
	if got := repackEstimate(c, "mvhevc"); got != 180 {
		t.Fatalf("1080p %d", got)
	}
	// bars removed: the recorded output size counts
	c.Params.Preset, c.Params.OutputWidth, c.Params.OutputHeight = "4k", 3840, 1600
	if got := repackEstimate(c, "mvhevc"); got != 30+445 { // 60 × 10 × 1600/2160 = 444.4
		t.Fatalf("cropped %d", got)
	}
	c.Params.OutputWidth, c.Params.OutputHeight = 0, 0
	c.Outputs = map[string]string{"sbs_part1": "a", "sbs_part2": "b", "sbs_part3": "c"}
	if got := repackEstimate(c, "half_sbs"); got != 121+90 { // 60 × 2.02 + 3 parts × 30
		t.Fatalf("split %d", got)
	}
	c.Outputs = nil
	c.Params.Preset, c.Source.DurationS = "8k", 1200 // 1200 × 10 × 4 + 30 = 13.3 h
	if got := repackTimeoutOf(c, "mvhevc"); got != 2*48030*time.Second {
		t.Fatalf("8k timeout %v", got)
	}
	if repackTimeoutOf(c, "sbs") != repackTimeout || repackTimeoutOf(&store.Conversion{}, "mvhevc") != repackTimeout {
		t.Fatal("3 h floor")
	}
}

// The sample has every format: a run stored with two outputs is
// backfilled (once, samples only) when it's read or listed; its formats
// list nothing more and a POST is 422 sample_project.
func TestSampleRunFormats(t *testing.T) {
	s, stub := formatsService(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	p := &store.Project{ID: sampleProjectID(uid), UID: uid, Name: "Sunset session", Method: store.MethodLifelike, Sample: true}
	if err := s.Store.CreateProject(ctx, p); err != nil {
		t.Fatal(err)
	}
	old := &store.Conversion{ID: sampleRunID(uid), UID: uid, Sample: true, Kind: "video", ProjectID: p.ID, Method: store.MethodLifelike,
		State: store.StateSucceeded, Params: store.Params{Preset: "4k", Formats: []string{"mvhevc", "sbs"}},
		Outputs: map[string]string{"mvhevc": sampleFiles["mvhevc"].URL, "sbs": sampleFiles["sbs"].URL}}
	if err := s.Store.CreateConversion(ctx, old); err != nil {
		t.Fatal(err)
	}
	other := finishedRun(t, s, uid, "4k", "sbs")

	// Listing: ensureSample sees the sample there and backfills its run.
	if _, added := s.ensureSample(ctx, uid, []*store.Project{p}); added {
		t.Fatal("the sample was there")
	}
	got, _ := s.Store.GetConversion(ctx, old.ID)
	if got.Outputs["half_sbs"] != sampleFiles["half_sbs"].URL || strings.Join(got.Params.Formats, ",") != "mvhevc,sbs,half_sbs" {
		t.Fatalf("backfill %v %v", got.Outputs, got.Params.Formats)
	}
	again := s.backfillSampleRun(ctx, got) // idempotent
	if len(again.Outputs) != 3 || len(again.Params.Formats) != 3 {
		t.Fatalf("twice %v %v", again.Outputs, again.Params.Formats)
	}
	if o := s.backfillSampleRun(ctx, other); len(o.Outputs) != 1 {
		t.Fatalf("a non-sample run touched %v", o.Outputs)
	}

	code, out := formatsCall(s, uid, old.ID, http.MethodGet, "")
	if code != 200 || len(strs(out["available"])) != 0 || len(strs(out["have"])) != 3 {
		t.Fatalf("sample formats %d %v", code, out)
	}
	if code, out := formatsCall(s, uid, old.ID, http.MethodPost, `{"format":"half_sbs"}`); code != 422 || out["error"] != "sample_project" {
		t.Fatalf("sample post %d %v", code, out)
	}
	if len(stub.bodies) != 0 {
		t.Fatal("the sample never reaches the Lifelike service")
	}

	// A sample made now has all three.
	fresh := "u" + store.NewID()
	fp := &store.Project{ID: sampleProjectID(fresh), UID: fresh, Sample: true}
	s.ensureSampleRun(ctx, fresh, fp)
	if c, _ := s.Store.GetConversion(ctx, sampleRunID(fresh)); len(c.Outputs) != 3 || len(c.Params.Formats) != 3 {
		t.Fatalf("new sample %v %v", c.Outputs, c.Params.Formats)
	}
}

// GET formats passes Lifelike's progress through per job (null until it
// says) with the seconds left from it, and a job is never gone from
// pending before its file is in have.
func TestRunFormatsProgress(t *testing.T) {
	s, stub := formatsService(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	c := finishedRun(t, s, uid, "4k", "sbs", "half_sbs")
	if code, _ := formatsCall(s, uid, c.ID, http.MethodPost, `{"format":"mvhevc"}`); code != 202 {
		t.Fatalf("post %d", code)
	}
	job := func() map[string]any {
		_, out := formatsCall(s, uid, c.ID, http.MethodGet, "")
		return out["jobs"].(map[string]any)["mvhevc"].(map[string]any)
	}
	if j := job(); j["progress"] != nil || j["remaining_seconds"] != nil || j["status"] != "processing" {
		t.Fatalf("before progress %v", j)
	}
	// 40 s in at 0.4: 60 s left
	s.Store.Transition(ctx, c.ID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		x.Repacks["mvhevc"].RequestedAt = time.Now().Add(-40 * time.Second)
		return nil
	})
	p := 0.4
	stub.progress = &p
	j := job()
	if j["progress"] != 0.4 || j["remaining_seconds"] == nil || j["remaining_seconds"].(float64) < 59 || j["remaining_seconds"].(float64) > 62 {
		t.Fatalf("at 0.4 %v", j)
	}
	if parts := j["parts"].([]any); parts[0].(map[string]any)["progress"] != 0.4 {
		t.Fatalf("part %v", parts)
	}
	// a record that says succeeded with its file not yet listed reads as
	// still being made (the GET never shows neither)
	s.Store.Transition(ctx, c.ID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		x.Repacks["mvhevc"].Status = "succeeded"
		return nil
	})
	got, _ := s.Store.GetConversion(ctx, c.ID)
	st := s.runFormatsOf(ctx, got)
	if !slices.Contains(st.Pending, "mvhevc") || slices.Contains(st.Have, "mvhevc") || st.json(got)["jobs"].(map[string]any)["mvhevc"].(map[string]any)["status"] != "processing" {
		t.Fatalf("gap %+v", st)
	}
	s.Store.Transition(ctx, c.ID, []string{store.StateSucceeded}, func(x *store.Conversion) error {
		x.Repacks["mvhevc"].Status = "processing"
		return nil
	})
	// done: in have and the job succeeded in the same answer, progress 1
	stub.status = "done"
	_, out := formatsCall(s, uid, c.ID, http.MethodGet, "")
	j = out["jobs"].(map[string]any)["mvhevc"].(map[string]any)
	if !slices.Contains(strs(out["have"]), "mvhevc") || slices.Contains(strs(out["pending"]), "mvhevc") || j["status"] != "succeeded" ||
		j["progress"] != 1.0 || j["remaining_seconds"] != nil {
		t.Fatalf("done %v", out)
	}
}
