package api

import (
	"context"
	"fmt"
	"slices"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Black bars (BL-03, owner 2026-11-03): analysis finds letterbox or
// pillarbox bars (project.crop, "W:H:X:Y" from cropdetect); Lifelike runs
// take them off by default (source_crop on /convert) and the user can
// keep them (PATCH remove_bars false).
//
// project.crop is in displayed pixels (cropdetect reads auto-rotated
// frames) while project.probe is coded pixels, before rotation: a
// portrait phone clip without bars is crop 1080:1920:0:0 on a 1920x1080
// probe. So bars are judged on the probe turned to the crop's
// orientation, with a tolerance so cropdetect's rounding isn't bars.

const (
	barsMinSidePx   = 8    // a side at least this much shorter is bars
	barsMinAreaLoss = 0.02 // or at least this share of the picture
	barsMinKeep     = 0.20 // Lifelike's MIN_CROP_SHARE: a crop keeps at least this of each side
	barsMinPx       = 256  // Lifelike's smallest crop side
)

// evenCrop makes a crop Lifelike takes (yuv420: x, y, w, h even): x and
// y up to even, w and h down to even, so it stays inside the picture.
func evenCrop(c store.Crop) store.Crop {
	dx, dy := c.X%2, c.Y%2
	c.X, c.Y = c.X+dx, c.Y+dy
	c.W, c.H = (c.W-dx)&^1, (c.H-dy)&^1
	return c
}

// parseCrop reads project.crop; ok false when absent or malformed.
func parseCrop(crop string) (c store.Crop, ok bool) {
	if crop == "" {
		return c, false
	}
	if n, err := fmt.Sscanf(crop, "%d:%d:%d:%d", &c.W, &c.H, &c.X, &c.Y); n != 4 || err != nil || c.W <= 0 || c.H <= 0 || c.X < 0 || c.Y < 0 {
		return store.Crop{}, false
	}
	return c, true
}

// displayedFrame is the probe's size in displayed orientation: turned to
// match the crop when the crop is the other way round (a rotated file).
func displayedFrame(p *store.Project) (w, h int) {
	if p.Probe == nil || p.Probe.Width <= 0 || p.Probe.Height <= 0 {
		return 0, 0
	}
	w, h = p.Probe.Width, p.Probe.Height
	if c, ok := parseCrop(p.Crop); ok && (c.W > c.H) != (w > h) && c.W != c.H && w != h {
		w, h = h, w
	}
	return w, h
}

// barsCrop is the crop when analysis found bars (the picture inside is
// smaller than the frame by more than the tolerance).
func barsCrop(p *store.Project) (store.Crop, bool) {
	c, ok := parseCrop(p.Crop)
	fw, fh := displayedFrame(p)
	if !ok || fw == 0 || c.W > fw || c.H > fh {
		return store.Crop{}, false
	}
	c = evenCrop(c)
	if c.W < barsMinPx || c.H < barsMinPx { // Lifelike's floor: not worth converting
		return store.Crop{}, false
	}
	// Lifelike refuses a crop off the frame or keeping under 20% of a side
	// (MIN_CROP_SHARE): cropdetect on a dark video, not bars.
	if c.X+c.W > fw || c.Y+c.H > fh || float64(c.W) < barsMinKeep*float64(fw) || float64(c.H) < barsMinKeep*float64(fh) {
		return store.Crop{}, false
	}
	area, full := float64(c.W)*float64(c.H), float64(fw)*float64(fh)
	if fw-c.W >= barsMinSidePx || fh-c.H >= barsMinSidePx || area <= full*(1-barsMinAreaLoss) {
		return c, true
	}
	return store.Crop{}, false
}

// hasBars: analysis found black bars on the project's video.
func hasBars(p *store.Project) bool {
	_, ok := barsCrop(p)
	return ok
}

// removeBars: a Lifelike run of this project takes the bars off: there
// are bars, the user hasn't kept them, and the gateway sends source_crop.
func removeBars(p *store.Project) bool {
	if p.BarsRemovalOff || !hasBars(p) {
		return false
	}
	return p.RemoveBars == nil || *p.RemoveBars
}

// sourceCropOn: the gateway sends source_crop (lifelike_source_crop_enabled);
// the cached config, bounded so a cold read can't hang a response.
func (s *Service) sourceCropOn(ctx context.Context) bool {
	if s.Pricing == nil {
		return false
	}
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return s.Pricing.Rates(ctx).LifelikeSourceCropEnabled
}

// markBarsRemoval notes on a read project whether runs may take the bars
// off yet (removeBars then says no while the switch is off).
func (s *Service) markBarsRemoval(ctx context.Context, p *store.Project) {
	p.BarsRemovalOff = !s.sourceCropOn(ctx)
}

// runBarsJSON: the crop a run took off (displayed source pixels), for
// the admin views; nil when it kept the whole frame.
func runBarsJSON(c *store.Conversion) any {
	if !c.Params.RemoveBars || c.Params.SourceCrop == nil {
		return nil
	}
	return c.Params.SourceCrop
}

// croppedFormats drops full-width SBS from a size the cropped picture
// makes too big for it (fullSBSRefused), as 6K/8K never list it.
func croppedFormats(p *store.Project, q quality) quality {
	c, ok := barsCrop(p)
	if !ok || !removeBars(p) || !slices.Contains(q.Formats, "sbs") {
		return q
	}
	w, h := cropOutputSize(c.W, c.H, presetOutputHeight[q.Preset])
	if !fullSBSFits(w, h) {
		q.Formats = slices.DeleteFunc(slices.Clone(q.Formats), func(f string) bool { return f == "sbs" })
	}
	return q
}
