// Package mediahost points storage links at the China media host for
// browsers that reach the gateway through the relay.
//
// Browsers in mainland China can't reach storage.googleapis.com. The relay
// serves cn.media.stereo3d.studio, which forwards to storage with
// Host: storage.googleapis.com kept, so a V4 signed URL (and a resumable
// upload session URL) stays valid when only its host is swapped. It forwards
// only paths under /<bucket>/stereo3d/.
//
// Rather than every handler knowing about the relay, Middleware rewrites the
// JSON answer once: every "https://storage.googleapis.com/<bucket>/<prefix>"
// becomes "https://<media host>/<bucket>/<prefix>". Upload tickets, preview
// and thumbnail links, step outputs and downloads are all covered, and any
// link added later is too. Requests that did not come through the relay,
// and callers that are not browsers (the iOS app sends no Origin), get the
// answer untouched.
package mediahost

import (
	"bytes"
	"net/http"
	"strings"
)

// StorageOrigin is where the gateway's storage links point.
const StorageOrigin = "https://storage.googleapis.com"

// Rewriter swaps the storage origin for the media origin in answers to
// browsers that came through the relay.
type Rewriter struct {
	from, to []byte
	viaRelay func(*http.Request) bool
}

// New rewrites links under /<bucket>/<prefix> to mediaOrigin
// ("https://cn.media.stereo3d.studio"). viaRelay says whether a request came
// through the relay (identity.IPPolicy). An empty mediaOrigin turns the
// rewrite off.
func New(mediaOrigin, bucket, prefix string, viaRelay func(*http.Request) bool) *Rewriter {
	mediaOrigin = strings.TrimRight(strings.TrimSpace(mediaOrigin), "/")
	if mediaOrigin == "" || viaRelay == nil {
		return &Rewriter{}
	}
	p := "/" + strings.Trim(bucket, "/") + "/" + strings.TrimLeft(prefix, "/")
	return &Rewriter{
		from:     []byte(StorageOrigin + p),
		to:       []byte(mediaOrigin + p),
		viaRelay: viaRelay,
	}
}

// Applies reports whether answers to r get the media host: a browser
// (it sends Origin) that came through the relay.
func (rw *Rewriter) Applies(r *http.Request) bool {
	return rw != nil && len(rw.to) > 0 && r.Header.Get("Origin") != "" && rw.viaRelay(r)
}

func (rw *Rewriter) rewrite(b []byte) []byte {
	return bytes.ReplaceAll(b, rw.from, rw.to)
}

// Middleware buffers JSON answers to relay browsers and rewrites their
// storage links. Everything else streams through untouched.
func (rw *Rewriter) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !rw.Applies(r) {
			next.ServeHTTP(w, r)
			return
		}
		buf := &bufferedWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(buf, r)
		body := buf.body.Bytes()
		if strings.HasPrefix(w.Header().Get("Content-Type"), "application/json") {
			body = rw.rewrite(body)
			w.Header().Del("Content-Length")
		}
		w.WriteHeader(buf.status)
		_, _ = w.Write(body)
	})
}

// bufferedWriter holds the status and body; headers go straight to the
// underlying writer's map (CORS and request-id headers are already there).
type bufferedWriter struct {
	http.ResponseWriter
	status      int
	wroteHeader bool
	body        bytes.Buffer
}

func (b *bufferedWriter) WriteHeader(status int) {
	if b.wroteHeader {
		return
	}
	b.wroteHeader = true
	b.status = status
}

func (b *bufferedWriter) Write(p []byte) (int, error) {
	b.wroteHeader = true
	return b.body.Write(p)
}
