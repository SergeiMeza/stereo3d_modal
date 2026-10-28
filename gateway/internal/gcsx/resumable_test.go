package gcsx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"cloud.google.com/go/storage"
)

// storageStub answers an XML-API resumable start like storage does and
// records what the signer was asked for.
func storageStub(t *testing.T, status int, location string) (*Client, *http.Request, *storage.SignedURLOptions) {
	t.Helper()
	var got http.Request
	var opts storage.SignedURLOptions
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = *r.Clone(context.Background())
		if location != "" {
			w.Header().Set("Location", location)
		}
		w.WriteHeader(status)
	}))
	t.Cleanup(srv.Close)
	sign := func(key string, o *storage.SignedURLOptions) (string, error) {
		opts = *o
		return srv.URL + "/spatial-video-studio-app/" + key + "?X-Goog-Signature=sig", nil
	}
	return NewWithSigner("spatial-video-studio-app", "stereo3d/test/", sign, srv.Client()), &got, &opts
}

func TestStartResumableUpload(t *testing.T) {
	loc := "https://storage.googleapis.com/spatial-video-studio-app/stereo3d/test/users/u1/abc/source.mp4?upload_id=ADPy"
	c, req, opts := storageStub(t, http.StatusCreated, loc)
	got, err := c.StartResumableUpload(context.Background(), "stereo3d/test/users/u1/abc/source.mp4", "video/mp4", "https://www.stereo3d.studio")
	if err != nil {
		t.Fatal(err)
	}
	if got != loc {
		t.Fatalf("session: %q", got)
	}
	if req.Method != http.MethodPost || req.Header.Get("x-goog-resumable") != "start" ||
		req.Header.Get("Content-Type") != "video/mp4" || req.Header.Get("Origin") != "https://www.stereo3d.studio" {
		t.Fatalf("start request: %s %v", req.Method, req.Header)
	}
	if !strings.HasSuffix(req.URL.Path, "/stereo3d/test/users/u1/abc/source.mp4") {
		t.Fatalf("path: %s", req.URL.Path)
	}
	if opts.Method != "POST" || opts.ContentType != "video/mp4" || len(opts.Headers) != 1 || opts.Headers[0] != "x-goog-resumable:start" ||
		opts.Scheme != storage.SigningSchemeV4 || time.Until(opts.Expires) <= 0 {
		t.Fatalf("signed for: %+v", opts)
	}
}

func TestStartResumableUploadWithoutOrigin(t *testing.T) {
	c, req, _ := storageStub(t, http.StatusCreated, "https://storage.googleapis.com/b/k?upload_id=x")
	if _, err := c.StartResumableUpload(context.Background(), "stereo3d/test/k.mp4", "video/mp4", ""); err != nil {
		t.Fatal(err)
	}
	if _, ok := req.Header["Origin"]; ok {
		t.Fatal("sent an empty Origin")
	}
}

func TestStartResumableUploadFailures(t *testing.T) {
	for name, c := range map[string]struct {
		status int
		loc    string
	}{
		"refused":      {http.StatusForbidden, ""},
		"no location":  {http.StatusCreated, ""},
		"no upload id": {http.StatusCreated, "https://storage.googleapis.com/b/k"},
		"not https":    {http.StatusCreated, "http://storage.googleapis.com/b/k?upload_id=x"},
	} {
		client, _, _ := storageStub(t, c.status, c.loc)
		_, err := client.StartResumableUpload(context.Background(), "stereo3d/test/k.mp4", "video/mp4", "")
		if err == nil {
			t.Errorf("%s: want error", name)
			continue
		}
		if strings.Contains(err.Error(), "sig") {
			t.Errorf("%s: error leaks the signed URL: %v", name, err)
		}
	}
}
