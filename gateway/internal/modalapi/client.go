// Package modalapi is the typed client for the private stereo3d Modal API
// and, with the same shape, the shared lifelike3d service (ml-sharp-modal
// docs/LIFELIKE_API.md). Every request carries Modal proxy-auth headers when
// a token is configured; the prod deployments set requires_proxy_auth=True
// so nothing else can reach them.
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
		// An hour (owner, 2026-10-03): under a burst the Modal API answered
		// submits and polls after more than the 30 s this used to allow,
		// and every one that gave up was a failed photo. App-facing requests
		// are bounded far below this by their own deadline (cmd/gateway);
		// the reconciler is the caller that waits the full hour.
		http: &http.Client{Timeout: time.Hour},
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
	JobID          string  `json:"job_id"`
	Status         string  `json:"status"` // pending | in_progress | completed | failed | canceled (lifelike)
	Stage          string  `json:"stage"`
	Progress       float64 `json:"progress"`
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
	// ErrorCode: Lifelike's code for a failure the gateway can name
	// (today source_dolby_vision_unsupported); "" otherwise.
	ErrorCode string `json:"error_code"`
	// CostSummary: the pipeline's bill estimate. Lifelike's total_usd is
	// the list-price model × its measured billing factor (1.2, ~the real
	// bill since 2026-11-03); total_usd_raw keeps the model's own figure
	// (absent on Classic and older Lifelike records).
	CostSummary struct {
		TotalUSD    float64 `json:"total_usd"`
		TotalUSDRaw float64 `json:"total_usd_raw"`
		// Stages: per-stage costs (Lifelike: plan, render, encode_*,
		// brand_intro, coordinator); unknown stages are fine.
		Stages []struct {
			Stage    string  `json:"stage"`
			TotalUSD float64 `json:"total_usd"`
		} `json:"stages"`
	} `json:"cost_summary"`
	// Both pipelines: a GPU call is queued and none runs; total seconds
	// spent so. Absent on older records (false / 0).
	WaitingForGPU bool    `json:"waiting_for_gpu"`
	QueuedS       float64 `json:"queued_s"`
}

// Part is one file of a split output (metadata.parts): SOURCE frames, half
// open; start_s = from_frame / source fps.
type Part struct {
	Index     int     `json:"index"`
	FromFrame int     `json:"from_frame"`
	ToFrame   int     `json:"to_frame"`
	StartS    float64 `json:"start_s"`
	DurationS float64 `json:"duration_s"`
}

// Parts decodes metadata.parts; nil when the output is not split or the
// metadata doesn't say (yet).
func (j *Job) Parts() []Part {
	if len(j.Metadata) == 0 {
		return nil
	}
	var m struct {
		Parts []Part `json:"parts"`
	}
	if json.Unmarshal(j.Metadata, &m) != nil {
		return nil
	}
	return m.Parts
}

// Experimental reports metadata.experimental (Lifelike 5K-8K).
func (j *Job) Experimental() bool {
	if len(j.Metadata) == 0 {
		return false
	}
	var m struct {
		Experimental bool `json:"experimental"`
	}
	return json.Unmarshal(j.Metadata, &m) == nil && m.Experimental
}

// Scheduling is what a Lifelike job echoes of its scheduling inputs
// (metadata.priority, metadata.max_gpu_workers); zero values when absent.
func (j *Job) Scheduling() (priority string, gpus int) {
	if len(j.Metadata) == 0 {
		return "", 0
	}
	var m struct {
		Priority      string `json:"priority"`
		MaxGPUWorkers int    `json:"max_gpu_workers"`
	}
	if json.Unmarshal(j.Metadata, &m) != nil {
		return "", 0
	}
	return m.Priority, m.MaxGPUWorkers
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
		// The video stream's bit_rate, when the analyze job reports it.
		BitRate      int64 `json:"bit_rate"`
		VideoBitRate int64 `json:"video_bit_rate"`
	} `json:"probe"`
	Crop    string `json:"crop"`
	Preview struct {
		URL       string `json:"url"`
		ShortSide int    `json:"short_side"`
	} `json:"preview"`
	SceneCuts  []int `json:"scene_cuts"`
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
		// Poster: the project's picture, the first sampled frame that
		// isn't black or flat (else mid-video), h=480; absent before
		// 2026-11-05.
		Poster *struct {
			Frame int    `json:"frame"`
			URL   string `json:"url"`
		} `json:"poster"`
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
	// 16 MiB: a long video's job record (scene list, per-scene timings,
	// outputs) can pass 1 MiB, and a cut record decodes as a poll error
	// until processingTTL fails the conversion.
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &UpstreamError{StatusCode: resp.StatusCode, Body: string(raw)}
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}

// StageUSD is one cost_summary stage's total (0 when absent).
func (j *Job) StageUSD(stage string) float64 {
	var n float64
	for _, st := range j.CostSummary.Stages {
		if st.Stage == stage {
			n += st.TotalUSD
		}
	}
	return n
}

// IntroFacts is what a Lifelike job says of the brand intro and of the
// lengths: VideoFrames/VideoDurationS are the customer's video only (what
// is quoted and billed); OutputFrames/OutputDurationS include the intro
// and are never used for money.
type IntroFacts struct {
	IntroS          int
	IntroFrames     int
	IntroLanguage   string
	VideoFrames     int
	VideoDurationS  float64
	OutputFrames    int
	OutputDurationS float64
}

// SourceVFR is the pipeline's own read of the source (3DS VFR guard,
// 2026-11-04): whether it's variable-rate (resampled to a constant grid at
// its measured average rate) and the frames it counted. vfr is nil on
// jobs that don't report it.
func (j *Job) SourceVFR() (vfr *bool, counted int) {
	var m struct {
		SourceVFR           *bool `json:"source_vfr"`
		SourceCountedFrames int   `json:"source_counted_frames"`
	}
	if len(j.Metadata) == 0 || json.Unmarshal(j.Metadata, &m) != nil {
		return nil, 0
	}
	return m.SourceVFR, m.SourceCountedFrames
}

// CropBox is a picture area in displayed source pixels.
type CropBox struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

// CropFacts is what Lifelike recorded of a run's source_crop (BL-03):
// the crop applied (nil: none, or the whole frame), what was sent, and
// the displayed size of the source ([w, h]).
type CropFacts struct {
	Applied, Requested *CropBox
	DisplaySize        []int
}

// SourceCrop decodes them; zero values on jobs that don't say.
func (j *Job) SourceCrop() CropFacts {
	var m struct {
		SourceCrop          *CropBox `json:"source_crop"`
		SourceCropRequested *CropBox `json:"source_crop_requested"`
		SourceDisplaySize   []int    `json:"source_display_size"`
	}
	if len(j.Metadata) == 0 || json.Unmarshal(j.Metadata, &m) != nil {
		return CropFacts{}
	}
	return CropFacts{Applied: m.SourceCrop, Requested: m.SourceCropRequested, DisplaySize: m.SourceDisplaySize}
}

// Intro decodes them; zero values on older jobs.
func (j *Job) Intro() IntroFacts {
	var m struct {
		IntroS        int    `json:"intro_s"`
		IntroLanguage string `json:"intro_language"`
		Intro         *struct {
			Frames int `json:"frames"`
		} `json:"intro"`
		VideoFrames     int     `json:"video_frames"`
		VideoDurationS  float64 `json:"video_duration_s"`
		OutputFrames    int     `json:"output_frames"`
		OutputDurationS float64 `json:"output_duration_s"`
	}
	if len(j.Metadata) == 0 || json.Unmarshal(j.Metadata, &m) != nil {
		return IntroFacts{}
	}
	f := IntroFacts{IntroS: m.IntroS, IntroLanguage: m.IntroLanguage, VideoFrames: m.VideoFrames, VideoDurationS: m.VideoDurationS,
		OutputFrames: m.OutputFrames, OutputDurationS: m.OutputDurationS}
	if m.Intro != nil {
		f.IntroFrames = m.Intro.Frames
	}
	return f
}
