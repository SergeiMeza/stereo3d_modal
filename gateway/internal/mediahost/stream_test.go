package mediahost

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// SSE through the relay: never buffered (the first event arrives while
// the stream is still open), storage links rewritten event by event.
func TestRelayStreamsEvents(t *testing.T) {
	rw := New("https://cn.media.stereo3d.studio/", "spatial-video-studio-app", "stereo3d/test/", relayByHeader)
	release := make(chan struct{})
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		io.WriteString(w, "event: project.updated\ndata: {\"preview_url\":\"https://storage.googleapis.com/spatial-video-studio-app/stereo3d/test/outputs/p1/preview.mp4\"}\n\n")
		http.NewResponseController(w).Flush()
		<-release
	})
	srv := httptest.NewServer(rw.Middleware(h))
	defer srv.Close()
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/v1/events", nil)
	req.Header.Set("Origin", "https://www.stereo3d.studio")
	req.Header.Set("X-Test-Relay", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	got := make(chan string, 1)
	go func() {
		buf := make([]byte, 4096)
		n, _ := resp.Body.Read(buf)
		got <- string(buf[:n])
	}()
	select {
	case s := <-got:
		if !strings.Contains(s, "https://cn.media.stereo3d.studio/spatial-video-studio-app/stereo3d/test/outputs/p1/preview.mp4") {
			t.Fatalf("not rewritten: %s", s)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("the event was buffered")
	}
	close(release)
}
