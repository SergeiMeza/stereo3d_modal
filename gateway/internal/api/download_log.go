package api

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Download and issuance log (spec M8). Every signed download URL handed
// out and every View in 3D or preview play the web reports becomes a row
// in downloads_{env}: run, file, kind, time, the IP's country, a salted
// hash of the IP (never the IP) and the user agent. Rows are queued and
// written in batches off the request path; case evidence (M7) reads them.

// countryHeaders carry the caller's country when a front end adds one:
// the load balancer's custom header ({client_region}), the relay's, or a
// CDN's. Cloud Run itself adds none.
var countryHeaders = []string{"X-Client-Region", "X-Client-Country", "X-Client-Geo-Country", "CF-IPCountry", "X-Appengine-Country"}

func requestCountry(r *http.Request) string {
	for _, h := range countryHeaders {
		if v := strings.ToUpper(strings.TrimSpace(r.Header.Get(h))); len(v) == 2 && v != "ZZ" && v != "XX" {
			return v
		}
	}
	return ""
}

// ipSalt: IP_HASH_SALT, else derived from the reconcile token (a secret
// already mounted), so hashes can't be reversed from the IP space.
func (s *Service) ipSalt() string {
	if v := strings.TrimSpace(os.Getenv("IP_HASH_SALT")); v != "" {
		return v
	}
	sum := sha256.Sum256([]byte("svs-ip-hash|" + s.Cfg.Env + "|" + s.Cfg.ReconcileToken))
	return hex.EncodeToString(sum[:])
}

func (s *Service) ipHash(ip string) string {
	if ip == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(s.ipSalt() + "|" + ip))
	return hex.EncodeToString(sum[:])
}

func (s *Service) downloadRow(r *http.Request, conv *store.Conversion, file, kind string) store.DownloadRow {
	ua := r.Header.Get("User-Agent")
	if len(ua) > 400 {
		ua = ua[:400]
	}
	return store.DownloadRow{UID: conv.UID, ConversionID: conv.ID, ProjectID: conv.ProjectID, File: file, Kind: kind,
		IPCountry: requestCountry(r), IPHash: s.ipHash(clientIP(r)), UserAgent: ua}
}

// logIssued records one row per signed URL handed out.
func (s *Service) logIssued(r *http.Request, conv *store.Conversion, files []outputFile) {
	if s.Downloads == nil {
		return
	}
	rows := make([]store.DownloadRow, 0, len(files))
	for _, f := range files {
		name := f.Filename
		if name == "" {
			name = f.Name
		}
		rows = append(rows, s.downloadRow(r, conv, name, store.DownloadIssued))
	}
	s.Downloads.Log(rows...)
}

// POST /v1/conversions/{id}/plays {file, kind: view_in_3d|preview} → {logged}
// The web reports a View in 3D or preview play (M8). Optional: an older
// client that never calls it just leaves no play rows.
func (s *Service) HandleLogPlay(w http.ResponseWriter, r *http.Request, user *AuthedUser, id string) {
	ctx := r.Context()
	conv, err := s.ownedConversion(ctx, user, id)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	var req struct {
		File string `json:"file"`
		Kind string `json:"kind"`
	}
	_ = json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&req)
	kind := store.DownloadPlay
	if req.Kind == "preview" {
		kind = store.DownloadPreview
	}
	file := strings.TrimSpace(req.File)
	if len(file) > 200 {
		file = file[:200]
	}
	if s.Downloads != nil && !conv.Sample {
		s.Downloads.Log(s.downloadRow(r, conv, file, kind))
	}
	s.noteWatched(ctx, conv) // onboarding: their first play (not the sample)
	httpx.WriteOK(w, map[string]any{"logged": true})
}

// downloadEvidence lists the case's runs' rows for M7.
func (s *Service) downloadEvidence(ctx context.Context, convIDs []string) []map[string]any {
	out := []map[string]any{}
	for _, id := range convIDs {
		rows, err := s.Store.ListDownloads(ctx, id, 500)
		if err != nil {
			continue
		}
		for _, r := range rows {
			out = append(out, map[string]any{"conversion_id": r.ConversionID, "file": r.File, "kind": r.Kind, "at": r.At,
				"ip_country": r.IPCountry, "ip_hash": shortHash(r.IPHash), "user_agent": r.UserAgent})
		}
	}
	return out
}

func shortHash(h string) string {
	if len(h) > 12 {
		return h[:12]
	}
	return h
}

// downloadRetention deletes rows past 13 months (behind the TTL policy).
func (s *Service) downloadRetention(ctx context.Context) int {
	n, _ := s.Store.DeleteDownloadsBefore(ctx, time.Now().Add(-store.DownloadRetention), 2000)
	return n
}
