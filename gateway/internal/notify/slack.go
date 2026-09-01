// Package notify posts conversion failures to Slack so problems surface
// before the support ticket does. No-op when SLACK_WEBHOOK_URL is unset.
package notify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"
)

type Slack struct {
	webhookURL string
	env        string
	http       *http.Client
}

func NewSlack(webhookURL, env string) *Slack {
	return &Slack{webhookURL: webhookURL, env: env, http: &http.Client{Timeout: 10 * time.Second}}
}

func (s *Slack) post(ctx context.Context, text string) {
	if s.webhookURL == "" {
		return
	}
	body, _ := json.Marshal(map[string]string{"text": text})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.webhookURL, bytes.NewReader(body))
	if err != nil {
		return
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.http.Do(req)
	if err != nil {
		slog.WarnContext(ctx, "slack notify failed", "err", err)
		return
	}
	resp.Body.Close()
}

func (s *Slack) ConversionFailed(ctx context.Context, conversionID, uid, stage, internalErr string) {
	s.post(ctx, fmt.Sprintf(
		":rotating_light: [gateway/%s] conversion `%s` FAILED (hold released)\nuser: `%s`  stage: `%s`\n```%s```",
		s.env, conversionID, uid, stage, truncate(internalErr, 500)))
}

// SettleFailed flags money that needs manual follow-up (e.g. capture failed
// because the hold expired). These are the tickets to catch proactively.
func (s *Slack) SettleFailed(ctx context.Context, conversionID, uid, action string, err error) {
	s.post(ctx, fmt.Sprintf(
		":money_with_wings: [gateway/%s] Stripe %s FAILED for conversion `%s` — needs manual follow-up\nuser: `%s`\n```%v```",
		s.env, action, conversionID, uid, err))
}

// BatchChargeFailed: a batched charge hit a card decision — the account is
// delinquent with several steps' worth of delivered work behind it.
func (s *Slack) BatchChargeFailed(ctx context.Context, batchID, uid string, items int, cents int64, err error) {
	s.post(ctx, fmt.Sprintf(
		":money_with_wings: [gateway/%s] batched charge FAILED for batch `%s` (%d step(s), %d cents) — account delinquent\nuser: `%s`\n```%v```",
		s.env, batchID, items, cents, uid, err))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
