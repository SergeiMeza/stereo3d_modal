package modalapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRepackCalls(t *testing.T) {
	var got map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Modal-Key") != "id" || r.Header.Get("Modal-Secret") != "secret" {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/repack":
			json.NewDecoder(r.Body).Decode(&got)
			w.WriteHeader(202)
			w.Write([]byte(`{"repack_id":"rp1"}`))
		case r.Method == http.MethodGet && r.URL.Path == "/repack/rp1":
			w.Write([]byte(`{"status":"completed","output":{"bytes":10,"width":3840,"height":1080,"frames":240,"level":"5.1"},"cost_stage":"repack"}`))
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	c := New(srv.URL, "id", "secret")
	id, err := c.SubmitRepack(context.Background(), RepackRequest{JobID: "job1", Source: RepackSource{URL: "https://get", Format: "sbs"},
		TargetFormat: "mvhevc", OutputUploadURL: "https://put", Preset: "4k", FPS: 24})
	if err != nil || id != "rp1" {
		t.Fatalf("submit %q %v", id, err)
	}
	if got["target_format"] != "mvhevc" || got["source"].(map[string]any)["format"] != "sbs" || got["fps"] != float64(24) || got["output_upload_url"] != "https://put" {
		t.Fatalf("body %v", got)
	}
	st, err := c.GetRepack(context.Background(), "rp1")
	if err != nil || !st.Done() || st.Output.Width != 3840 || st.CostStage != "repack" {
		t.Fatalf("status %+v %v", st, err)
	}
}
