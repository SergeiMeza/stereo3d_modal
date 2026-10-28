package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"cloud.google.com/go/storage"

	"spatial-ai-labs/stereo3d-gateway/internal/gcsx"
	"spatial-ai-labs/stereo3d-gateway/internal/mediahost"
)

const testBucket = "spatial-video-studio-app"

// uploadService signs URLs on storage.googleapis.com and answers resumable
// starts from a stub, recording the Origin each start carried.
func uploadService(t *testing.T) (*Service, *[]string) {
	t.Helper()
	var origins []string
	stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.Header.Get("x-goog-resumable") != "start" {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		origins = append(origins, r.Header.Get("Origin"))
		w.Header().Set("Location", "https://storage.googleapis.com"+r.URL.Path+"?upload_id=ADPy")
		w.WriteHeader(http.StatusCreated)
	}))
	t.Cleanup(stub.Close)
	sign := func(key string, o *storage.SignedURLOptions) (string, error) {
		host := "https://storage.googleapis.com"
		if o.Method == "POST" {
			host = stub.URL // the session start goes to the stub
		}
		return host + "/" + testBucket + "/" + key + "?X-Goog-Signature=sig&X-Goog-Method=" + o.Method, nil
	}
	return &Service{GCS: gcsx.NewWithSigner(testBucket, "stereo3d/test/", sign, stub.Client())}, &origins
}

func createUpload(t *testing.T, h http.Handler, body string, viaRelay bool) map[string]any {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/v1/uploads", strings.NewReader(body))
	r.Header.Set("Origin", "https://www.stereo3d.studio")
	if viaRelay {
		r.Header.Set("X-Test-Relay", "1")
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("POST /v1/uploads %s: %d %s", body, w.Code, w.Body)
	}
	var m map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

func uploadHandler(s *Service) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/uploads", func(w http.ResponseWriter, r *http.Request) {
		s.HandleCreateUpload(w, r, &AuthedUser{UID: "u1"})
	})
	relay := func(r *http.Request) bool { return r.Header.Get("X-Test-Relay") == "1" }
	return mediahost.New("https://cn.media.stereo3d.studio", testBucket, "stereo3d/test/", relay).Middleware(mux)
}

func TestCreateUploadDefaultIsOneSignedPut(t *testing.T) {
	s, origins := uploadService(t)
	m := createUpload(t, uploadHandler(s), `{"filename":"clip.MP4","content_type":"video/mp4"}`, false)
	url, _ := m["upload_url"].(string)
	if !strings.HasPrefix(url, "https://storage.googleapis.com/"+testBucket+"/stereo3d/test/users/u1/") || !strings.Contains(url, "X-Goog-Method=PUT") {
		t.Fatalf("upload_url: %q", url)
	}
	if _, ok := m["resumable"]; ok {
		t.Fatalf("default ticket says resumable: %v", m)
	}
	if h, _ := m["headers"].(map[string]any); h["Content-Type"] != "video/mp4" {
		t.Fatalf("headers: %v", m["headers"])
	}
	if key, _ := m["gcs_key"].(string); !strings.HasSuffix(key, "/source.mp4") || !strings.Contains(url, key) {
		t.Fatalf("gcs_key %q vs url %q", key, url)
	}
	if len(*origins) != 0 {
		t.Fatal("a default ticket started a session")
	}
}

func TestCreateUploadResumable(t *testing.T) {
	s, origins := uploadService(t)
	m := createUpload(t, uploadHandler(s), `{"filename":"clip.mov","content_type":"video/quicktime","resumable":true}`, false)
	key, _ := m["gcs_key"].(string)
	want := "https://storage.googleapis.com/" + testBucket + "/" + key + "?upload_id=ADPy"
	if m["upload_url"] != want || m["resumable"] != true {
		t.Fatalf("ticket: %v, want upload_url %s", m, want)
	}
	if h, _ := m["headers"].(map[string]any); len(h) != 0 {
		t.Fatalf("resumable chunks need no headers: %v", h)
	}
	if m["expires_in"] != float64(7*24*3600) {
		t.Fatalf("expires_in: %v", m["expires_in"])
	}
	if len(*origins) != 1 || (*origins)[0] != "https://www.stereo3d.studio" {
		t.Fatalf("session start origins: %v", *origins)
	}
}

func TestCreateUploadThroughRelayGetsMediaHost(t *testing.T) {
	s, _ := uploadService(t)
	h := uploadHandler(s)

	m := createUpload(t, h, `{"filename":"clip.mp4","content_type":"video/mp4","resumable":true}`, true)
	key, _ := m["gcs_key"].(string)
	if want := "https://cn.media.stereo3d.studio/" + testBucket + "/" + key + "?upload_id=ADPy"; m["upload_url"] != want {
		t.Fatalf("resumable via relay: %v, want %s", m["upload_url"], want)
	}

	m = createUpload(t, h, `{"filename":"clip.mp4","content_type":"video/mp4"}`, true)
	if url, _ := m["upload_url"].(string); !strings.HasPrefix(url, "https://cn.media.stereo3d.studio/"+testBucket+"/stereo3d/test/") {
		t.Fatalf("single PUT via relay: %q", url)
	}
}

func TestCreateUploadResumableStartFailureIsBusy(t *testing.T) {
	sign := func(key string, o *storage.SignedURLOptions) (string, error) {
		return "http://127.0.0.1:1/" + testBucket + "/" + key, nil
	}
	s := &Service{GCS: gcsx.NewWithSigner(testBucket, "stereo3d/test/", sign, http.DefaultClient)}
	r := httptest.NewRequest(http.MethodPost, "/v1/uploads", strings.NewReader(`{"filename":"a.mp4","content_type":"video/mp4","resumable":true}`))
	w := httptest.NewRecorder()
	s.HandleCreateUpload(w, r.WithContext(context.Background()), &AuthedUser{UID: "u1"})
	if w.Code != http.StatusServiceUnavailable || !strings.Contains(w.Body.String(), "service_busy") {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
}
