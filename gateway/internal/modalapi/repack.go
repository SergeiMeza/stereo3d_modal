package modalapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
)

// Repack (ADR 0137): the Lifelike service re-packs a finished run's stored
// output into another format (spatial MV-HEVC, full or half side-by-side)
// with the pipeline's own encoding. The gateway hands it a signed GET of
// the source and a signed PUT for the new file.

// RepackRequest is POST /repack's body.
type RepackRequest struct {
	JobID           string       `json:"job_id"`
	Source          RepackSource `json:"source"`
	TargetFormat    string       `json:"target_format"`
	OutputUploadURL string       `json:"output_upload_url"`
	Preset          string       `json:"preset,omitempty"`
	FPS             float64      `json:"fps,omitempty"`
	// OutputBitrateBps: the run's own target (Master or an explicit
	// choice); 0 leaves the pipeline's default.
	OutputBitrateBps int64 `json:"output_bitrate_bps,omitempty"`
	// MaxBitrateBps: Standard's CRF cap (lifelike3d v27; ignored when
	// OutputBitrateBps is set). OutputBitDepth: 10 for Master (Main 10 on
	// an mvhevc target; SBS stays 8-bit).
	MaxBitrateBps  int64 `json:"max_bitrate_bps,omitempty"`
	OutputBitDepth int   `json:"output_bit_depth,omitempty"`
}

// RepackSource is the stored output the repack reads.
type RepackSource struct {
	URL    string `json:"url"`
	Format string `json:"format"` // mvhevc | sbs | half_sbs
}

// RepackStatus is GET /repack/{id}.
type RepackStatus struct {
	Status    string        `json:"status"` // queued | running | done | failed
	Error     string        `json:"error,omitempty"`
	Output    *RepackOutput `json:"output,omitempty"`
	CostStage string        `json:"cost_stage,omitempty"`
	// Progress: 0-1 (download 0.05, encode to 0.9, upload, 1); nil when
	// the record doesn't say.
	Progress *float64 `json:"progress,omitempty"`
	// Metadata: metadata.outputs_media.<target_format> = the new file's
	// measured {video_kbps, audio_codec, audio_kbps} (only when done).
	Metadata json.RawMessage `json:"metadata,omitempty"`
}

// RepackOutput describes the new file.
type RepackOutput struct {
	Bytes  int64  `json:"bytes"`
	Width  int    `json:"width"`
	Height int    `json:"height"`
	Frames int    `json:"frames"`
	Level  string `json:"level,omitempty"`
}

// Done and Failed read the repack's status words (3DS: queued | running |
// done | failed; completed is kept as an alias of done, and error or
// cancelled count as failed). Anything else is still in progress.
func (r *RepackStatus) Done() bool { return r.Status == "done" || r.Status == "completed" }
func (r *RepackStatus) Failed() bool {
	return r.Status == "failed" || r.Status == "error" || r.Status == "cancelled"
}

// SubmitRepack posts POST /repack → {repack_id}.
func (c *Client) SubmitRepack(ctx context.Context, req RepackRequest) (string, error) {
	body := map[string]any{"job_id": req.JobID, "source": map[string]any{"url": req.Source.URL, "format": req.Source.Format},
		"target_format": req.TargetFormat, "output_upload_url": req.OutputUploadURL}
	if req.Preset != "" {
		body["preset"] = req.Preset
	}
	if req.FPS > 0 {
		body["fps"] = req.FPS
	}
	if req.OutputBitrateBps > 0 {
		body["output_bitrate_bps"] = req.OutputBitrateBps
	}
	if req.MaxBitrateBps > 0 && req.OutputBitrateBps <= 0 {
		body["max_bitrate_bps"] = req.MaxBitrateBps
	}
	if req.OutputBitDepth > 0 {
		body["output_bit_depth"] = req.OutputBitDepth
	}
	var out struct {
		RepackID string `json:"repack_id"`
	}
	if err := c.do(ctx, http.MethodPost, "/repack", body, &out); err != nil {
		return "", err
	}
	if out.RepackID == "" {
		return "", &UpstreamError{StatusCode: http.StatusBadGateway, Body: "no repack_id"}
	}
	return out.RepackID, nil
}

// GetRepack reads GET /repack/{id}.
func (c *Client) GetRepack(ctx context.Context, id string) (*RepackStatus, error) {
	var out RepackStatus
	if err := c.do(ctx, http.MethodGet, "/repack/"+url.PathEscape(id), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
