package api

import (
	"context"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"time"
)

// Draining on SIGTERM (owner 2026-11-07): Cloud Run sends SIGTERM and
// allows 10 s before it kills the instance. Every open live stream gets a
// bye {reason: "restart", retry_ms} with a jittered 1–3 s retry, so its
// browser reconnects promptly to the new revision instead of waiting for
// the stream to break; then the server stops taking requests and lets the
// in-flight ones finish.

// byeRetryMS: a restart's retry_ms, jittered so viewers don't all come
// back in the same instant (a variable for tests).
var byeRetryMS = func() int { return 1000 + rand.IntN(2001) }

// drainCh is closed when the instance starts draining.
func (s *Service) drainCh() chan struct{} {
	s.drainInit.Do(func() { s.drain = make(chan struct{}) })
	return s.drain
}

// Drain tells every open stream to say bye and close (once).
func (s *Service) Drain() {
	ch := s.drainCh()
	s.drainClose.Do(func() { close(ch) })
}

// Shutdown drains srv's streams, waits grace for their bye to flush, then
// stops srv, letting in-flight requests finish within timeout. Grace plus
// timeout stay inside Cloud Run's 10 s.
func Shutdown(srv *http.Server, svc *Service, grace, timeout time.Duration) error {
	slog.Info("shutting down: streams told to reconnect", "grace", grace)
	svc.Drain()
	time.Sleep(grace)
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	return srv.Shutdown(ctx)
}
