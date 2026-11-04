package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
	mu      sync.Mutex
	bodies  []map[string]any
	status  string
	failNew bool
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
		w.WriteHeader(202)
		json.NewEncoder(w).Encode(map[string]any{"repack_id": "rp" + store.NewID()})
	case r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/repack/"):
		out := map[string]any{"status": l.status, "cost_stage": "repack"}
		if l.status == "done" || l.status == "completed" {
			out["output"] = map[string]any{"bytes": 1000, "width": 3840, "height": 2160, "frames": 240, "level": "5.1"}
		}
		if l.status == "failed" {
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
		if o == "mvhevc" {
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
		b["output_upload_url"] != "https://signed/PUT/stereo3d/test/outputs/"+c.Modal.JobID+"/repack_mvhevc.mov" || b["preset"] != "4k" || b["fps"] != float64(30) || b["job_id"] != c.Modal.JobID {
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
	// queued is in progress; the preference is one constant.
	stub.status = "queued"
	if got := s.pollRepacks(ctx, got); got != nil {
		t.Fatalf("queued changed the run: %+v", got.Repacks["half_sbs"])
	}
	defer func(p []string) { repackSourcePreference = p }(repackSourcePreference)
	repackSourcePreference = []string{"mvhevc", "sbs"}
	both := finishedRun(t, s, uid, "4k", "sbs", "mvhevc")
	if st := s.runFormatsOf(ctx, both); st.Source != "mvhevc" || strings.Join(st.Available, ",") != "half_sbs" {
		t.Fatalf("flipped preference %+v", st)
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
