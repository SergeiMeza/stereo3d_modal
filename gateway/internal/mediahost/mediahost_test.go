package mediahost

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

const (
	signed  = "https://storage.googleapis.com/spatial-video-studio-app/stereo3d/test/users/u1/abc/source.mp4?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=ff"
	session = "https://storage.googleapis.com/spatial-video-studio-app/stereo3d/test/users/u1/abc/source.mp4?upload_id=ADPy"
	public  = "https://storage.googleapis.com/spatial-video-studio-app/stereo3d/test/outputs/p1/preview.mp4"
	foreign = "https://storage.googleapis.com/spatial-video-studio-app/users/u1/photo.jpg"
	other   = "https://storage.googleapis.com/spatial-video-studio-app/stereo3d/prod/outputs/p1/preview.mp4"
)

func relayByHeader(r *http.Request) bool { return r.Header.Get("X-Test-Relay") == "1" }

func serve(t *testing.T, rw *Rewriter, origin string, relay bool, h http.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/v1/projects/p1", nil)
	if origin != "" {
		r.Header.Set("Origin", origin)
	}
	if relay {
		r.Header.Set("X-Test-Relay", "1")
	}
	w := httptest.NewRecorder()
	rw.Middleware(h).ServeHTTP(w, r)
	return w
}

func jsonAnswer(status int) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "rid")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"upload_url":   signed,
			"session":      session,
			"preview_url":  public,
			"strip_thumbs": []map[string]any{{"frame": 0, "url": public}},
			"foreign":      foreign,
			"other_env":    other,
		})
	}
}

func decode(t *testing.T, w *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatalf("answer is not JSON: %v: %s", err, w.Body)
	}
	return m
}

func TestRewritesStorageLinksForRelayBrowsers(t *testing.T) {
	rw := New("https://cn.media.stereo3d.studio/", "spatial-video-studio-app", "stereo3d/test/", relayByHeader)
	w := serve(t, rw, "https://www.stereo3d.studio", true, jsonAnswer(http.StatusCreated))
	if w.Code != http.StatusCreated || w.Header().Get("X-Request-Id") != "rid" {
		t.Fatalf("status/headers lost: %d %v", w.Code, w.Header())
	}
	m := decode(t, w)
	want := map[string]string{
		"upload_url":  "https://cn.media.stereo3d.studio/spatial-video-studio-app/stereo3d/test/users/u1/abc/source.mp4?X-Goog-Algorithm=GOOG4-RSA-SHA256&X-Goog-Signature=ff",
		"session":     "https://cn.media.stereo3d.studio/spatial-video-studio-app/stereo3d/test/users/u1/abc/source.mp4?upload_id=ADPy",
		"preview_url": "https://cn.media.stereo3d.studio/spatial-video-studio-app/stereo3d/test/outputs/p1/preview.mp4",
		// Outside the env prefix: the media host would refuse them anyway.
		"foreign":   foreign,
		"other_env": other,
	}
	for k, v := range want {
		if m[k] != v {
			t.Errorf("%s: got %v, want %v", k, m[k], v)
		}
	}
	thumb := m["strip_thumbs"].([]any)[0].(map[string]any)["url"]
	if thumb != want["preview_url"] {
		t.Errorf("thumb: %v", thumb)
	}
}

func TestLeavesEveryoneElseUntouched(t *testing.T) {
	rw := New("https://cn.media.stereo3d.studio", "spatial-video-studio-app", "stereo3d/test/", relayByHeader)
	for _, c := range []struct {
		name   string
		origin string
		relay  bool
	}{
		{"direct browser", "https://www.stereo3d.studio", false},
		{"app through the relay (no Origin)", "", true},
		{"app direct", "", false},
	} {
		m := decode(t, serve(t, rw, c.origin, c.relay, jsonAnswer(http.StatusOK)))
		if m["upload_url"] != signed || m["preview_url"] != public || m["session"] != session {
			t.Errorf("%s: rewritten: %v", c.name, m)
		}
	}

	off := New("", "spatial-video-studio-app", "stereo3d/test/", relayByHeader)
	m := decode(t, serve(t, off, "https://www.stereo3d.studio", true, jsonAnswer(http.StatusOK)))
	if m["upload_url"] != signed {
		t.Errorf("disabled rewriter rewrote: %v", m["upload_url"])
	}
}

func TestNonJSONPassesThrough(t *testing.T) {
	rw := New("https://cn.media.stereo3d.studio", "spatial-video-studio-app", "stereo3d/test/", relayByHeader)
	w := serve(t, rw, "https://www.stereo3d.studio", true, func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte(public))
	})
	if w.Code != 200 || w.Body.String() != public {
		t.Fatalf("got %d %q", w.Code, w.Body)
	}
}
