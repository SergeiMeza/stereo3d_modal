// Package modalapi is the typed client for the private stereo3d Modal API.
// Every request carries Modal proxy-auth headers; the Modal deployment sets
// requires_proxy_auth=True so nothing else can reach it.
package modalapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

type Client struct {
	base        string
	tokenID     string
	tokenSecret string
	http        *http.Client
}

func New(baseURL, tokenID, tokenSecret string) *Client {
	return &Client{
		base:        baseURL,
		tokenID:     tokenID,
		tokenSecret: tokenSecret,
		http:        &http.Client{Timeout: 30 * time.Second},
	}
}

type SubmitResponse struct {
	JobID     string `json:"job_id"`
	Status    string `json:"status"`
	StatusURL string `json:"status_url"`
}

// Job mirrors the fields of GET /v1/jobs/{id} the gateway consumes
// (docs/API.md documents the full shape).
type Job struct {
	JobID          string             `json:"job_id"`
	Status         string             `json:"status"` // pending | in_progress | completed | failed
	Stage          string             `json:"stage"`
	Progress       float64            `json:"progress"`
	ProgressDetail struct {
		ETASeconds int64 `json:"eta_seconds"`
	} `json:"progress_detail"`
	// Video jobs: {name: url}. Image jobs: {item_id: {name: url}}. Kept raw;
	// the gateway flattens both shapes (see api.Service.collectOutputs).
	Outputs map[string]json.RawMessage `json:"outputs"`
	// Metadata is job-kind-specific (analyze jobs carry probe/scenes/thumbs;
	// video jobs carry probe/crop/av_sync/...). Decode per use.
	Metadata json.RawMessage `json:"metadata"`
	Error    string          `json:"error"`
	CostSummary struct {
		TotalUSD float64 `json:"total_usd"`
	} `json:"cost_summary"`
}

// SubmitVideo posts the clamped request body to POST /v1/videos.
func (c *Client) SubmitVideo(ctx context.Context, body map[string]any) (*SubmitResponse, error) {
	var out SubmitResponse
	if err := c.do(ctx, http.MethodPost, "/v1/videos", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) SubmitImage(ctx context.Context, body map[string]any) (*SubmitResponse, error) {
	var out SubmitResponse
	if err := c.do(ctx, http.MethodPost, "/v1/images", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) SubmitAnalyze(ctx context.Context, body map[string]any) (*SubmitResponse, error) {
	var out SubmitResponse
	if err := c.do(ctx, http.MethodPost, "/v1/analyze", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// SubmitProfile starts a standalone shot-profiling job (free: the adaptive
// profiler over the analyze proxy + current cuts — no conversion).
func (c *Client) SubmitProfile(ctx context.Context, body map[string]any) (*SubmitResponse, error) {
	var out SubmitResponse
	if err := c.do(ctx, http.MethodPost, "/v1/profile", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// AnalyzeMetadata is the metadata shape of a completed /v1/analyze job
// (docs/API.md). All frame indices are source-frame space.
type AnalyzeMetadata struct {
	Probe struct {
		Width       int     `json:"width"`
		Height      int     `json:"height"`
		FPS         float64 `json:"fps"`
		FPSRational string  `json:"fps_rational"`
		Duration    float64 `json:"duration"`
		NumFrames   int     `json:"num_frames"`
	} `json:"probe"`
	Crop    string `json:"crop"`
	Preview struct {
		URL       string `json:"url"`
		ShortSide int    `json:"short_side"`
	} `json:"preview"`
	SceneCuts []int `json:"scene_cuts"`
	Thumbnails struct {
		Strip []struct {
			Frame int    `json:"frame"`
			URL   string `json:"url"`
		} `json:"strip"`
		Scenes []struct {
			Scene int    `json:"scene"`
			Frame int    `json:"frame"`
			URL   string `json:"url"`
		} `json:"scenes"`
	} `json:"thumbnails"`
}

func (j *Job) DecodeAnalyzeMetadata() (*AnalyzeMetadata, error) {
	var m AnalyzeMetadata
	if err := json.Unmarshal(j.Metadata, &m); err != nil {
		return nil, err
	}
	return &m, nil
}

// ReuseLookup checks Modal's content-addressed cache for the given request
// params without submitting a job (POST /v1/reuse/lookup).
type ReuseLookup struct {
	Preprocess struct {
		Cached bool `json:"cached"`
	} `json:"preprocess"`
	Depth struct {
		Cached bool `json:"cached"`
	} `json:"depth"`
	Scenes struct {
		Cached bool `json:"cached"`
	} `json:"scenes"`
}

func (c *Client) LookupReuse(ctx context.Context, body map[string]any) (*ReuseLookup, error) {
	var out ReuseLookup
	if err := c.do(ctx, http.MethodPost, "/v1/reuse/lookup", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) GetJob(ctx context.Context, jobID string) (*Job, error) {
	var out Job
	if err := c.do(ctx, http.MethodGet, "/v1/jobs/"+jobID, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CancelJob(ctx context.Context, jobID string) error {
	return c.do(ctx, http.MethodDelete, "/v1/jobs/"+jobID, nil, nil)
}

// UpstreamError preserves the Modal response for internal logs; handlers must
// not forward .Body to clients.
type UpstreamError struct {
	StatusCode int
	Body       string
}

func (e *UpstreamError) Error() string {
	return fmt.Sprintf("modal upstream %d: %s", e.StatusCode, e.Body)
}

func (c *Client) do(ctx context.Context, method, path string, body map[string]any, out any) error {
	var payload io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return err
		}
		payload = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, payload)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.tokenID != "" {
		req.Header.Set("Modal-Key", c.tokenID)
		req.Header.Set("Modal-Secret", c.tokenSecret)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &UpstreamError{StatusCode: resp.StatusCode, Body: string(raw)}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}
