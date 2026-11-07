package api

import (
	"net"
	"net/http"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// SIGTERM (owner 2026-11-07): every open stream gets bye {reason:
// restart, retry_ms 1000–3000} and closes; Shutdown then stops the server
// within its window.
func TestDrainSaysByeAndShutsDown(t *testing.T) {
	s, _ := eventsService(t, &eventsTiming{Heartbeat: 20 * time.Second, MaxAge: time.Minute, Flush: 50 * time.Millisecond})
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.HandleEventStream(w, r) })}
	go srv.Serve(ln)
	base := "http://" + ln.Addr().String()
	uid := "u" + store.NewID()
	var clients []*sseClient
	for i := 0; i < 3; i++ {
		req, _ := http.NewRequest(http.MethodGet, base+"/v1/events", nil)
		req.Header.Set("X-Test-UID", uid)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		c := readStream(t, resp)
		c.next("snapshot", 5*time.Second)
		clients = append(clients, c)
	}
	start := time.Now()
	done := make(chan error, 1)
	go func() { done <- Shutdown(srv, s, 200*time.Millisecond, 2*time.Second) }()
	for i, c := range clients {
		_, d := c.next("bye", 3*time.Second)
		ms, _ := d["retry_ms"].(float64)
		if d["reason"] != "restart" || ms < 1000 || ms > 3000 {
			t.Fatalf("stream %d bye %v", i, d)
		}
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("shutdown: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown didn't finish")
	}
	if took := time.Since(start); took > 3*time.Second {
		t.Fatalf("shutdown took %v", took)
	}
	if _, err := http.Get(base + "/v1/events"); err == nil {
		t.Fatal("still serving after shutdown")
	}
	for i := 0; i < 50; i++ {
		if n := byeRetryMS(); n < 1000 || n > 3000 {
			t.Fatalf("retry %d", n)
		}
	}
}
