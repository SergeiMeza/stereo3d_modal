package probe

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
)

// Dynamic ranges a source can have (owner 2026-11-05, HDR output).
const (
	RangeSDR = "sdr"
	RangeHLG = "hlg"
	RangePQ  = "pq"
	// RangeDV8: Dolby Vision with a base layer players show on their own
	// (profile 8.x: an HLG, PQ or SDR base, in Base).
	RangeDV8 = "dv_8"
	// RangeDV5: Dolby Vision without a displayable base layer (profile 5,
	// or any profile whose compatibility id is 0): the picture is only
	// right after Dolby's own reshaping, so it can't be converted.
	RangeDV5 = "dv_5"
)

// DynamicRange is the first video stream's dynamic range.
type DynamicRange struct {
	Range string // sdr | hlg | pq | dv_8 | dv_5
	Base  string // dv_8: the base layer's range (hlg | pq | sdr)
	// What it was read from, for support.
	Transfer, Primaries, Profile string
	DVProfile, DVCompat          int
}

// HDR: the picture is high dynamic range (HLG, PQ, or Dolby Vision on an
// HLG/PQ base).
func (d *DynamicRange) HDR() bool {
	if d == nil {
		return false
	}
	switch d.Range {
	case RangeHLG, RangePQ:
		return true
	case RangeDV8:
		return d.Base == RangeHLG || d.Base == RangePQ
	}
	return false
}

// Dynamic reads the dynamic range of the object behind url: ffprobe's
// color_transfer (arib-std-b67 = HLG, smpte2084 = PQ) and the Dolby
// Vision configuration record (dv_profile, dv_bl_signal_compatibility_id).
func Dynamic(ctx context.Context, url string) (*DynamicRange, error) {
	if err := acquire(ctx); err != nil {
		return nil, err
	}
	defer release()
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := command(ctx, "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_streams", "-of", "json", url).Output()
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("ffprobe: %w", ctx.Err())
		}
		return nil, fmt.Errorf("ffprobe failed")
	}
	return ParseDynamic(out)
}

// ParseDynamic classifies ffprobe's -show_streams JSON.
func ParseDynamic(raw []byte) (*DynamicRange, error) {
	var parsed struct {
		Streams []struct {
			Profile       string `json:"profile"`
			ColorTransfer string `json:"color_transfer"`
			ColorPrim     string `json:"color_primaries"`
			SideData      []struct {
				Type      string `json:"side_data_type"`
				DVProfile *int   `json:"dv_profile"`
				DVCompat  *int   `json:"dv_bl_signal_compatibility_id"`
			} `json:"side_data_list"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil || len(parsed.Streams) == 0 {
		return nil, fmt.Errorf("ffprobe: no video stream")
	}
	st := parsed.Streams[0]
	d := &DynamicRange{Transfer: st.ColorTransfer, Primaries: st.ColorPrim, Profile: st.Profile, DVProfile: -1, DVCompat: -1}
	byTransfer := func(t string) string {
		switch t {
		case "arib-std-b67":
			return RangeHLG
		case "smpte2084":
			return RangePQ
		}
		return RangeSDR
	}
	d.Range = byTransfer(st.ColorTransfer)
	for _, sd := range st.SideData {
		if !strings.Contains(strings.ToLower(sd.Type), "dovi") && !strings.Contains(strings.ToLower(sd.Type), "dolby vision") {
			continue
		}
		if sd.DVProfile != nil {
			d.DVProfile = *sd.DVProfile
		}
		if sd.DVCompat != nil {
			d.DVCompat = *sd.DVCompat
		}
		switch {
		case d.DVProfile == 5 || d.DVCompat == 0:
			d.Range = RangeDV5
		default:
			// the base layer's range: the compatibility id when it says,
			// else the stream's own transfer
			base := map[int]string{1: RangePQ, 2: RangeSDR, 4: RangeHLG, 6: RangePQ}[d.DVCompat]
			if base == "" {
				base = byTransfer(st.ColorTransfer)
			}
			if d.DVProfile == 8 {
				d.Range, d.Base = RangeDV8, base
			} else {
				d.Range = base // other profiles: the base as it plays (7: PQ; 9: SDR)
			}
		}
		break
	}
	return d, nil
}
