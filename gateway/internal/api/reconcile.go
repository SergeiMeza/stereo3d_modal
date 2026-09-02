package api

import (
	"crypto/subtle"
	"net/http"
	"sync"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// POST /internal/reconcile — Cloud Scheduler, every 60s. This is what makes
// the system settle server-side: jobs and money reach terminal states even
// if the app never polls and webhooks get lost.
//
//  1. processing → poll Modal, settle terminal states (capture/cancel).
//  2. paid with no Modal job (lost webhook / crashed submit) → submit.
//  3. created older than createTTL → cancel hold, expire.
func (s *Service) HandleReconcile(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	if s.Cfg.ReconcileToken == "" ||
		subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Reconcile-Token")), []byte(s.Cfg.ReconcileToken)) != 1 {
		httpx.WriteErr(ctx, w, httpx.ErrUnauthorized())
		return
	}
	log := httpx.Log(ctx)
	stats := map[string]int{}

	processing, err := s.Store.ListByState(ctx, store.StateProcessing, 200)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	// Bounded fan-out: sequential 30s Modal polls would blow the request
	// timeout with a handful of active jobs.
	var mu sync.Mutex
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for _, conv := range processing {
		wg.Add(1)
		go func(conv *store.Conversion) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			before := conv.State
			updated, err := s.refreshFromModal(ctx, conv)
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				log.Warn("reconcile refresh failed", "conversion_id", conv.ID, "err", err)
			} else if updated != nil && updated.State != before {
				stats["settled_"+updated.State]++
			} else {
				stats["still_processing"]++
			}
		}(conv)
	}
	wg.Wait()

	// paid: submit (lost webhook / crashed submit); after paidTTL of failed
	// submits, fail the conversion and release the hold — a hold must never
	// ride out Stripe's 7-day auth on a job that will never start.
	paid, err := s.Store.ListByState(ctx, store.StatePaid, 50)
	if err == nil {
		for _, conv := range paid {
			if time.Since(conv.UpdatedAt) > paidTTL {
				failed, terr := s.Store.Transition(ctx, conv.ID, []string{store.StatePaid}, func(c *store.Conversion) error {
					c.State = store.StateFailed
					c.Stripe.PIStatus = store.PICancelPending
					c.Error = &store.Error{
						Code:            "submit_failed",
						UserMessage:     "Processing could not be started and you were not charged. Quote this ID to support: " + c.ID,
						InternalMessage: "modal submit failing since " + conv.UpdatedAt.Format(time.RFC3339),
					}
					return nil
				})
				if terr == nil {
					s.Slack.ConversionFailed(ctx, conv.ID, conv.UID, "submit", "modal submit failing past paidTTL")
					_, _ = s.releaseHold(ctx, failed)
					stats["submit_expired"]++
				}
				continue
			}
			if err := s.submitToModal(ctx, conv.ID); err != nil {
				stats["submit_retry_failed"]++
			} else {
				stats["submitted"]++
			}
		}
	}

	// created older than createTTL: claim expired FIRST, then release —
	// canceling before claiming could release a hold that a racing payment
	// webhook just authorized.
	created, err := s.Store.ListByState(ctx, store.StateCreated, 200)
	if err == nil {
		for _, conv := range created {
			if time.Since(conv.CreatedAt) < createTTL {
				continue
			}
			expired, terr := s.Store.Transition(ctx, conv.ID, []string{store.StateCreated}, func(c *store.Conversion) error {
				c.State = store.StateExpired
				c.Stripe.PIStatus = store.PICancelPending
				return nil
			})
			if terr == nil {
				_, _ = s.releaseHold(ctx, expired)
				stats["expired"]++
			}
		}
	}

	// Settle sweeps: money actions committed (capture_pending/cancel_pending)
	// whose Stripe call didn't land (crash, transient Stripe error).
	if pending, err := s.Store.ListByPIStatus(ctx, store.PICapturePending, 100); err == nil {
		for _, conv := range pending {
			if _, cerr := s.captureHold(ctx, conv); cerr != nil {
				log.Warn("capture sweep failed", "conversion_id", conv.ID, "err", cerr)
			} else {
				stats["capture_swept"]++
			}
		}
	}
	// Auto-billing charge sweep: committed charges whose Stripe call didn't
	// land (crash, transient Stripe/network error). Card declines flip to
	// charge_failed inside chargeConversion and leave this sweep.
	if pending, err := s.Store.ListByPIStatus(ctx, store.PIChargePending, 100); err == nil {
		for _, conv := range pending {
			if _, cerr := s.settleAutoCharge(ctx, conv); cerr != nil {
				log.Warn("charge sweep failed", "conversion_id", conv.ID, "err", cerr)
			} else {
				stats["charge_swept"]++
			}
		}
	}
	// Batched billing: close batches whose window elapsed, then collect
	// every batch committed to charging whose Stripe call didn't land.
	if open, err := s.Store.ListBatchesByState(ctx, store.BatchOpen, 200); err == nil {
		now := time.Now().UTC()
		for _, b := range open {
			if b.DueAt.After(now) {
				continue
			}
			if _, cerr := s.closeAndCharge(ctx, b.ID, store.BatchCloseWindow); cerr != nil {
				log.Warn("batch window close failed", "batch_id", b.ID, "err", cerr)
			} else {
				stats["batch_window_closed"]++
			}
		}
	}
	// Photo pack purchases whose charge hit transient trouble.
	if charging, err := s.Store.ListPhotoPacksByState(ctx, store.PackCharging, 50); err == nil {
		for _, p := range charging {
			if _, cerr := s.chargePhotoPack(ctx, p); cerr != nil {
				log.Warn("photo pack sweep failed", "pack_id", p.ID, "err", cerr)
			} else {
				stats["photo_pack_swept"]++
			}
		}
	}
	if charging, err := s.Store.ListBatchesByState(ctx, store.BatchCharging, 100); err == nil {
		for _, b := range charging {
			if _, cerr := s.chargeBatch(ctx, b); cerr != nil {
				log.Warn("batch charge sweep failed", "batch_id", b.ID, "err", cerr)
			} else {
				stats["batch_charge_swept"]++
			}
		}
	}
	if pending, err := s.Store.ListByPIStatus(ctx, store.PICancelPending, 100); err == nil {
		for _, conv := range pending {
			if store.IsTerminal(conv.State) {
				if _, cerr := s.releaseHold(ctx, conv); cerr != nil {
					log.Warn("cancel sweep failed", "conversion_id", conv.ID, "err", cerr)
				} else {
					stats["cancel_swept"]++
				}
			}
		}
	}

	// Free analyze jobs (projects): fold results server-side so a project
	// finishes analyzing even if the user closes the tab.
	if analyzing, err := s.Store.ListProjectsAnalyzing(ctx, 100); err == nil {
		for _, p := range analyzing {
			if _, aerr := s.refreshAnalyze(ctx, p); aerr != nil {
				log.Warn("analyze sweep failed", "project_id", p.ID, "err", aerr)
			} else {
				stats["analyze_polled"]++
			}
		}
	}

	if len(stats) > 0 {
		log.Info("reconcile sweep", "stats", stats)
	}
	httpx.WriteOK(w, stats)
}
