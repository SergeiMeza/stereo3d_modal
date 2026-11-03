package store

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Download and issuance log (spec M8): downloads_{env}/{auto_id}, one row
// per signed-URL issuance and per View in 3D or preview play. Kept 13
// months (expire_at feeds a Firestore TTL policy; the nightly M3 run also
// deletes past rows, so retention holds without the policy). The raw IP is
// never stored: only a salted SHA-256 and the country.

// DownloadRetention is how long a row is kept.
const DownloadRetention = 396 * 24 * time.Hour // 13 months

// Download kinds.
const (
	DownloadIssued  = "download_issued" // a signed URL handed out
	DownloadPlay    = "view_in_3d_play"
	DownloadPreview = "preview_play"
)

// DownloadRow is one row.
type DownloadRow struct {
	UID          string    `firestore:"uid" json:"-"`
	ConversionID string    `firestore:"conversion_id" json:"conversion_id"`
	ProjectID    string    `firestore:"project_id,omitempty" json:"project_id,omitempty"`
	File         string    `firestore:"file" json:"file"`
	Kind         string    `firestore:"kind" json:"kind"`
	At           time.Time `firestore:"at" json:"at"`
	IPCountry    string    `firestore:"ip_country,omitempty" json:"ip_country,omitempty"`
	IPHash       string    `firestore:"ip_hash,omitempty" json:"ip_hash,omitempty"`
	UserAgent    string    `firestore:"user_agent,omitempty" json:"user_agent,omitempty"`
	ExpireAt     time.Time `firestore:"expire_at" json:"-"`
}

func downloadsCol(env string) string { return "downloads_" + env }

// DownloadLog batches rows off the request path: Log queues, a flusher
// writes every interval or every 100 rows, Flush drains (shutdown, tests).
type DownloadLog struct {
	st      *Store
	mu      sync.Mutex
	pending []DownloadRow
	kick    chan struct{}
	once    sync.Once
}

// NewDownloadLog starts the flusher.
func (s *Store) NewDownloadLog(interval time.Duration) *DownloadLog {
	l := &DownloadLog{st: s, kick: make(chan struct{}, 1)}
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-t.C:
			case <-l.kick:
			}
			l.Flush(context.Background())
		}
	}()
	return l
}

// Log queues rows (never blocks the request on Firestore).
func (l *DownloadLog) Log(rows ...DownloadRow) {
	if l == nil || len(rows) == 0 {
		return
	}
	now := time.Now().UTC()
	l.mu.Lock()
	for _, r := range rows {
		if r.At.IsZero() {
			r.At = now
		}
		r.ExpireAt = r.At.Add(DownloadRetention)
		if len(l.pending) < 5000 { // a stuck Firestore can't eat the memory
			l.pending = append(l.pending, r)
		}
	}
	n := len(l.pending)
	l.mu.Unlock()
	if n >= 100 {
		select {
		case l.kick <- struct{}{}:
		default:
		}
	}
}

// Flush writes what's queued, 400 rows per batch; failed rows go back.
func (l *DownloadLog) Flush(ctx context.Context) {
	if l == nil {
		return
	}
	l.mu.Lock()
	rows := l.pending
	l.pending = nil
	l.mu.Unlock()
	for len(rows) > 0 {
		n := min(len(rows), 400)
		bw := l.st.fs.BulkWriter(ctx)
		for _, r := range rows[:n] {
			if _, err := bw.Create(l.st.fs.Collection(downloadsCol(l.st.env)).NewDoc(), r); err != nil {
				slog.WarnContext(ctx, "download log row not queued", "err", err)
			}
		}
		bw.End()
		rows = rows[n:]
	}
}

// ListDownloads is a run's rows, oldest first (M7 evidence).
func (s *Store) ListDownloads(ctx context.Context, convID string, limit int) ([]DownloadRow, error) {
	snaps, err := s.fs.Collection(downloadsCol(s.env)).Where("conversion_id", "==", convID).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]DownloadRow, 0, len(snaps))
	for _, sn := range snaps {
		var r DownloadRow
		if sn.DataTo(&r) == nil {
			out = append(out, r)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At.Before(out[j].At) })
	return out, nil
}

// DeleteDownloadsBefore deletes up to max rows older than t (retention,
// behind the TTL policy). Returns how many went.
func (s *Store) DeleteDownloadsBefore(ctx context.Context, t time.Time, max int) (int, error) {
	snaps, err := s.fs.Collection(downloadsCol(s.env)).Where("at", "<", t).Limit(max).Documents(ctx).GetAll()
	if err != nil || len(snaps) == 0 {
		return 0, err
	}
	bw := s.fs.BulkWriter(ctx)
	for _, sn := range snaps {
		_, _ = bw.Delete(sn.Ref)
	}
	bw.End()
	return len(snaps), nil
}

// ----------------------------------------------------------- block list

// BlockedCard is blocklist_{env}/{fingerprint} (H): card fingerprints from
// disputes and early fraud warnings, refused at the gate and in webhooks.
type BlockedCard struct {
	Fingerprint string     `firestore:"fingerprint" json:"fingerprint"`
	Reason      string     `firestore:"reason" json:"reason"` // dispute | efw | manual
	SourceID    string     `firestore:"source_id,omitempty" json:"source_id,omitempty"`
	UID         string     `firestore:"uid,omitempty" json:"uid,omitempty"`
	PI          string     `firestore:"pi,omitempty" json:"pi,omitempty"`
	Brand       string     `firestore:"brand,omitempty" json:"brand,omitempty"`
	Country     string     `firestore:"country,omitempty" json:"country,omitempty"`
	By          string     `firestore:"by" json:"by"`
	Note        string     `firestore:"note,omitempty" json:"note,omitempty"`
	At          time.Time  `firestore:"at" json:"at"`
	Hits        int        `firestore:"hits" json:"hits"`
	LastHitAt   *time.Time `firestore:"last_hit_at,omitempty" json:"last_hit_at,omitempty"`
}

func blocklistCol(env string) string { return "blocklist_" + env }

// BlockCard adds a fingerprint; an existing entry is kept (first reason).
// Reports whether it was new.
func (s *Store) BlockCard(ctx context.Context, b BlockedCard) (bool, error) {
	if b.At.IsZero() {
		b.At = time.Now().UTC()
	}
	_, err := s.fs.Collection(blocklistCol(s.env)).Doc(b.Fingerprint).Create(ctx, b)
	if status.Code(err) == codes.AlreadyExists {
		return false, nil
	}
	return err == nil, err
}

// UnblockCard removes a fingerprint.
func (s *Store) UnblockCard(ctx context.Context, fp string) error {
	_, err := s.fs.Collection(blocklistCol(s.env)).Doc(fp).Delete(ctx)
	return err
}

// BlockedCards lists the block list.
func (s *Store) BlockedCards(ctx context.Context, limit int) ([]BlockedCard, error) {
	snaps, err := s.fs.Collection(blocklistCol(s.env)).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]BlockedCard, 0, len(snaps))
	for _, sn := range snaps {
		var b BlockedCard
		if sn.DataTo(&b) == nil {
			out = append(out, b)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].At.After(out[j].At) })
	return out, nil
}

// NoteBlockHit counts a refusal on an entry.
func (s *Store) NoteBlockHit(ctx context.Context, fp string) {
	now := time.Now().UTC()
	_, _ = s.fs.Collection(blocklistCol(s.env)).Doc(fp).Update(ctx, []firestore.Update{
		{Path: "hits", Value: firestore.Increment(1)}, {Path: "last_hit_at", Value: now}})
}

// ------------------------------------------------------------- M3 helpers

// RunOnce claims key (counters_{env}/{key}) once: true for the first
// caller, false after (a daily job on many instances runs once).
func (s *Store) RunOnce(ctx context.Context, key string) (bool, error) {
	_, err := s.fs.Collection("counters_"+s.env).Doc(key).Create(ctx, map[string]any{"at": time.Now().UTC()})
	if status.Code(err) == codes.AlreadyExists {
		return false, nil
	}
	return err == nil, err
}

// SaveReconcileReport writes reconcile_reports_{env}/{id} (M3: the KPI
// stack reads it).
func (s *Store) SaveReconcileReport(ctx context.Context, id string, report any) error {
	_, err := s.fs.Collection("reconcile_reports_"+s.env).Doc(id).Set(ctx, report)
	return err
}

// ListAllBalances lists balance documents (M3: balance = Σ entries).
func (s *Store) ListAllBalances(ctx context.Context, limit int) ([]*Balance, error) {
	snaps, err := s.fs.Collection(balancesCol(s.env)).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]*Balance, 0, len(snaps))
	for _, sn := range snaps {
		if b, err := snapToBalance(sn.Ref.ID, sn); err == nil {
			out = append(out, b)
		}
	}
	return out, nil
}

// LedgerFacts sums an account's entries: Σ delta, the entry count and
// how many topup entries each top-up has (M3 v7 flags).
func (s *Store) LedgerFacts(ctx context.Context, uid string) (sum int64, n int, topups map[string]int, err error) {
	topups = map[string]int{}
	iter := s.balanceDoc(uid).Collection("entries").Documents(ctx)
	defer iter.Stop()
	for {
		sn, ierr := iter.Next()
		if isIterDone(ierr) {
			break
		}
		if ierr != nil {
			return sum, n, topups, ierr
		}
		var e Entry
		if sn.DataTo(&e) != nil {
			continue
		}
		sum += e.Delta
		n++
		if e.Kind == EntryTopup && e.TopupID != "" {
			topups[e.TopupID]++
		}
	}
	return sum, n, topups, nil
}

// ListPendingDeletions lists customers whose deletion waits for a
// closure case (N8 step 3).
func (s *Store) ListPendingDeletions(ctx context.Context, limit int) (map[string]*Customer, error) {
	snaps, err := s.fs.Collection(customersCol(s.env)).Where("deletion_pending", "==", true).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := map[string]*Customer{}
	for _, sn := range snaps {
		var c Customer
		if sn.DataTo(&c) == nil {
			out[sn.Ref.ID] = &c
		}
	}
	return out, nil
}
