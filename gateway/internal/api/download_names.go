package api

import (
	"fmt"
	"path"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Download file names (S3D-31): every output downloads as
// "<original stem>_<resolution>[_partN]_<layout>.<ext>", with the layout
// markers the iPhone/Mac app uses — spatial (.mov), SBS, HSBS, TB, HTB
// (.mp4) — and the resolution as customers see it (1080p, 1440p, 3K, 4K,
// 5K…; a full-resolution run shows its real size, "1606p"). The name rides
// the signed URL as Content-Disposition, so the browser saves it under
// that name. Within a project the same name made twice becomes
// "name (2).ext", oldest run first.

// layoutMarkers maps an output format to its file-name marker.
var layoutMarkers = map[string]string{
	"mvhevc":    "spatial",
	"sbs":       "SBS",
	"half_sbs":  "HSBS",
	"tb":        "TB",
	"half_tb":   "HTB",
	"anaglyph":  "anaglyph",
	"depth_vis": "depth",
	"depth":     "depth",
}

// resolutionLabels: presets as customers see them.
var resolutionLabels = map[string]string{
	"draft": "1080p", "1080p": "1080p", "qhd": "1440p", "3k": "3K", "4k": "4K",
	"5k": "5K", "6k": "6K", "8k": "8K",
}

const maxStemBytes = 200

// downloadStem is the original's name without its extension, cleaned of
// path and control characters and cut to 200 bytes at a character
// boundary; "video" when there is none.
func downloadStem(name string) string {
	name = strings.TrimSpace(name)
	if ext := strings.ToLower(path.Ext(name)); slices.Contains(videoExts, ext) {
		name = strings.TrimSpace(name[:len(name)-len(ext)])
	}
	name = strings.Map(func(r rune) rune {
		switch {
		case r == '/' || r == '\\' || r == ':':
			return '-'
		case unicode.IsControl(r) || r == '"':
			return -1
		}
		return r
	}, name)
	if len(name) > maxStemBytes {
		cut := maxStemBytes
		for cut > 0 && !utf8.RuneStart(name[cut]) {
			cut--
		}
		name = strings.TrimSpace(name[:cut])
	}
	if name == "" {
		return "video"
	}
	return name
}

// resolutionLabel is a run's output size as customers see it.
func resolutionLabel(c *store.Conversion, p *store.Project) string {
	if c.Params.Quality == qualityFull && p != nil {
		if short := outputShortSide(p, c.Params); short > 0 {
			return fmt.Sprintf("%dp", short)
		}
	}
	if l, ok := resolutionLabels[c.Params.Preset]; ok {
		return l
	}
	return c.Params.Preset
}

// baseDownloadName is one output's name before de-duplication.
func baseDownloadName(stem, resolution, outputName, ext string) string {
	format, part := splitOutputName(outputName)
	marker, ok := layoutMarkers[format]
	if !ok {
		marker = format
	}
	name := stem + "_" + resolution
	if part > 0 {
		name += fmt.Sprintf("_part%d", part) // before the layout marker (web contract)
	}
	return name + "_" + marker + ext
}

// projectDownloadNames names every output of a project's succeeded runs
// (oldest first), numbering repeats "name (2).ext". Keyed by conversion
// id, then output name.
func projectDownloadNames(p *store.Project, convs []*store.Conversion) map[string]map[string]string {
	ordered := slices.Clone(convs)
	slices.SortStableFunc(ordered, func(a, b *store.Conversion) int {
		if c := a.CreatedAt.Compare(b.CreatedAt); c != 0 {
			return c
		}
		return strings.Compare(a.ID, b.ID)
	})
	stem := "video"
	if p != nil {
		stem = downloadStem(p.Name)
	}
	seen := map[string]int{}
	out := map[string]map[string]string{}
	for _, c := range ordered {
		if c.State != store.StateSucceeded {
			continue
		}
		outputs := make([]string, 0, len(c.Outputs))
		for name := range c.Outputs {
			outputs = append(outputs, name)
		}
		slices.Sort(outputs)
		res := resolutionLabel(c, p)
		names := map[string]string{}
		for _, o := range outputs {
			base := baseDownloadName(stem, res, o, path.Ext(c.Outputs[o]))
			seen[base]++
			if n := seen[base]; n > 1 {
				ext := path.Ext(base)
				base = fmt.Sprintf("%s (%d)%s", strings.TrimSuffix(base, ext), n, ext)
			}
			names[o] = base
		}
		out[c.ID] = names
	}
	return out
}

// contentDisposition: attachment with an ASCII fallback filename and the
// exact UTF-8 name in filename* (RFC 6266 / 5987).
func contentDisposition(name string) string {
	ascii := strings.Map(func(r rune) rune {
		if r > 0x7e || r < 0x20 || r == '"' || r == '\\' || r == '%' {
			return '_'
		}
		return r
	}, name)
	return fmt.Sprintf(`attachment; filename="%s"; filename*=UTF-8''%s`, ascii, rfc5987(name))
}

// rfc5987 percent-encodes every byte that isn't an attr-char.
func rfc5987(s string) string {
	const attr = "!#$&+-.^_`|~"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < 0x80 && (c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte(attr, c) >= 0) {
			b.WriteByte(c)
			continue
		}
		fmt.Fprintf(&b, "%%%02X", c)
	}
	return b.String()
}
