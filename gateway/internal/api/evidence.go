package api

import (
	"context"
	"fmt"
	"net/url"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Evidence snapshot (M7): built when a case opens and on Refresh
// evidence; frozen, each refresh adds the next. Run timeline, GPU work,
// files delivered, downloads and plays (M8), payments, previous cases,
// links.

func (s *Service) buildEvidence(ctx context.Context, cs *store.Case) {
	if s.Store == nil {
		return
	}
	snap := s.evidenceFor(ctx, cs)
	n := cs.EvidenceN + 1
	if err := s.Store.SaveEvidence(ctx, cs.ID, n, snap); err != nil {
		return
	}
	now := time.Now().UTC()
	s.Store.UpdateCase(ctx, cs.ID, "system", func(c *store.Case) error {
		c.EvidenceN, c.EvidenceAt = n, &now
		return nil
	})
	cs.EvidenceN, cs.EvidenceAt = n, &now
}

func (s *Service) evidenceFor(ctx context.Context, cs *store.Case) map[string]any {
	stripeBase := "https://dashboard.stripe.com"
	if s.Cfg.Env != "prod" {
		stripeBase += "/test"
	}
	var runs []map[string]any
	var jobIDs []string
	var from, to time.Time
	for _, id := range cs.Related.ConversionIDs {
		c, err := s.Store.GetConversion(ctx, id)
		if err != nil {
			continue
		}
		if from.IsZero() || c.CreatedAt.Before(from) {
			from = c.CreatedAt
		}
		if c.UpdatedAt.After(to) {
			to = c.UpdatedAt
		}
		r := map[string]any{
			"conversion_id": c.ID, "project_id": c.ProjectID, "step": c.Step, "method": store.MethodOr(c.Method),
			"preset": c.Params.Preset, "state": c.State, "created_at": c.CreatedAt, "updated_at": c.UpdatedAt,
			"payment_flow": c.PaymentFlow, "quote_cents": c.Quote.AmountCents, "captured_cents": c.Stripe.CapturedCents,
			"refunded_cents": c.Stripe.RefundedCents, "pi_status": c.Stripe.PIStatus, "canceled_by": c.CanceledBy,
			"submitted_at": c.Modal.SubmittedAt, "started_at": c.Modal.StartedAt, "job_id": c.Modal.JobID,
			"gpu_cost_usd": c.Modal.CostUSD, "queued_s": c.Modal.QueuedS,
			"brand_intro_usd": c.Modal.BrandIntroUSD, "intro_frames": c.Modal.IntroFrames,
			"priority": c.Modal.Priority, "max_gpu_workers": c.Modal.GPUWorkers, "express_cost_factor": c.Modal.ExpressCostFactor,
		}
		addRunMedia(r, c)
		if c.Error != nil {
			r["error"] = map[string]string{"code": c.Error.Code, "message": c.Error.UserMessage, "internal": c.Error.InternalMessage}
		}
		files := make([]string, 0, len(c.Outputs))
		for name := range c.Outputs {
			files = append(files, name)
		}
		r["files_delivered"] = files
		if len(c.Parts) > 0 {
			r["parts"] = len(c.Parts)
		}
		if rb := c.RunBalance; rb != nil {
			r["balance"] = map[string]any{"hold_cents": rb.HoldCents, "state": rb.State, "settled_cents": rb.SettledCents}
		}
		if c.Modal.JobID != "" {
			jobIDs = append(jobIDs, c.Modal.JobID)
		}
		runs = append(runs, r)
	}
	var payments []map[string]any
	if charges, err := s.Store.ListUserCharges(ctx, cs.UID, 200); err == nil {
		for _, ch := range charges {
			payments = append(payments, map[string]any{"charge_id": ch.ID, "kind": ch.Kind, "paid_at": ch.PaidAt,
				"amount_cents": ch.AmountCents, "payment_intent": ch.PaymentIntentID, "invoice_state": ch.InvoiceState})
		}
	}
	var refunds []map[string]any
	if rows, err := s.Store.ListUserRefundRows(ctx, cs.UID, 200); err == nil {
		for _, r := range rows {
			refunds = append(refunds, map[string]any{"id": r.ID, "case_id": r.CaseID, "pi": r.PI, "re_id": r.ReID,
				"total_cents": r.TotalCents, "status": r.Status, "source": r.Source, "at": r.CreatedAt})
		}
	}
	var previous []map[string]any
	if cases, err := s.Store.ListUserCases(ctx, cs.UID, 100); err == nil {
		for _, c := range cases {
			if c.ID == cs.ID {
				continue
			}
			d := map[string]any{"id": c.ID, "type": c.Type, "reason": c.Reason, "status": c.Status, "result": c.Result,
				"decided_cents": c.DecidedCents, "opened_at": c.OpenedAt}
			if c.Decision != nil {
				d["decision"] = c.Decision.Kind
			}
			previous = append(previous, d)
		}
	}
	links := map[string]any{}
	if !from.IsZero() {
		q := fmt.Sprintf(`resource.type="cloud_run_revision" AND (jsonPayload.conversion_id=(%s) OR jsonPayload.case_id="%s")`, quoteJoin(cs.Related.ConversionIDs), cs.ID)
		links["logs_url"] = "https://console.cloud.google.com/logs/query;query=" + url.PathEscape(q) +
			fmt.Sprintf(";startTime=%s;endTime=%s?project=%s", from.Add(-time.Hour).Format(time.RFC3339), to.Add(time.Hour).Format(time.RFC3339), s.Cfg.GCPProjectID)
	}
	var stripeURLs []string
	for _, pi := range cs.Related.PIIDs {
		stripeURLs = append(stripeURLs, stripeBase+"/payments/"+pi)
	}
	if cs.CustomerID != "" {
		stripeURLs = append(stripeURLs, stripeBase+"/customers/"+cs.CustomerID)
	}
	if cs.Related.DisputeID != "" {
		stripeURLs = append(stripeURLs, stripeBase+"/disputes/"+cs.Related.DisputeID)
	}
	links["stripe_urls"] = stripeURLs
	links["modal_job_ids"] = jobIDs
	return map[string]any{
		"built_at":  time.Now().UTC(),
		"runs":      runs,
		"downloads": s.downloadEvidence(ctx, cs.Related.ConversionIDs),
		"payments":  payments,
		"refunds":   refunds,
		"cases":     previous,
		"links":     links,
	}
}

func quoteJoin(ids []string) string {
	out := ""
	for i, id := range ids {
		if i > 0 {
			out += " OR "
		}
		out += `"` + id + `"`
	}
	return out
}
