package api

import (
	"strings"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The mobile one-shot surface (docs/MOBILE.md): every combination rule
// enforced at validate() so nothing contradictory reaches billing or Modal.
func TestCreateConversionReqValidate(t *testing.T) {
	video := func(mut func(*createConversionReq)) *createConversionReq {
		r := &createConversionReq{GCSKey: "stereo3d/test/users/u1/abc/in.mp4"}
		mut(r)
		return r
	}
	image := func(mut func(*createConversionReq)) *createConversionReq {
		r := &createConversionReq{GCSKey: "stereo3d/test/users/u1/abc/in.jpg"}
		mut(r)
		return r
	}
	ok := []*createConversionReq{
		video(func(r *createConversionReq) { r.DepthModel = "da2"; r.Warp = "backward" }),
		video(func(r *createConversionReq) { r.DepthModel = "vda"; r.Inpaint = "migan"; r.DepthRes = 980 }),
		video(func(r *createConversionReq) { r.Warp = "backward"; r.Inpaint = "none" }),
		image(func(r *createConversionReq) { r.Inpaint = "migan"; r.StereoMode = "left" }),
		image(func(r *createConversionReq) { r.Warp = "backward" }),
		video(func(r *createConversionReq) { r.Placement = []float64{-1, 0.3} }),
		image(func(r *createConversionReq) { r.Placement = []float64{-1.5, 1.5} }),
	}
	for i, r := range ok {
		if err := r.validate(); err != nil {
			t.Errorf("ok[%d]: unexpected %v", i, err)
		}
	}
	// backward + none is normalized, and backward implies none
	r := video(func(r *createConversionReq) { r.Warp = "backward" })
	_ = r.validate()
	if r.Inpaint != "none" {
		t.Errorf("backward must force inpaint none, got %q", r.Inpaint)
	}
	bad := map[string]*createConversionReq{
		"depth_model must":       video(func(r *createConversionReq) { r.DepthModel = "da3" }), // R&D-only
		"inpaint must":           video(func(r *createConversionReq) { r.Inpaint = "lama" }),
		"cannot be combined":     video(func(r *createConversionReq) { r.Warp = "backward"; r.Inpaint = "migan" }),
		"stereo_mode applies":    video(func(r *createConversionReq) { r.StereoMode = "left" }),
		"depth_res must":         video(func(r *createConversionReq) { r.DepthRes = 981 }),
		"video conversions only": image(func(r *createConversionReq) { r.DepthModel = "da2" }),
		"image inpaint":          image(func(r *createConversionReq) { r.Inpaint = "propainter" }),
		"an inpaint model":       image(func(r *createConversionReq) { r.Warp = "backward"; r.Inpaint = "migan" }),
		"warp must":              video(func(r *createConversionReq) { r.Warp = "gather" }),
	}
	for sub, r := range bad {
		err := r.validate()
		if err == nil || !strings.Contains(err.Error(), sub) {
			t.Errorf("want error containing %q, got %v", sub, err)
		}
	}
}

func mobileConv(kind string) *store.Conversion {
	if kind == "image" {
		return &store.Conversion{Kind: "image", Params: store.Params{
			Formats: []string{"lr"}, StereoMode: "both", Warp: "forward", Inpaint: "migan",
		}}
	}
	return &store.Conversion{Kind: "video", Params: store.Params{
		Preset: "1080p", Formats: []string{"mvhevc"},
		DepthModel: "da2", Warp: "backward", Inpaint: "none",
	}}
}

// The whitelisted Modal body carries the new mobile params — and nothing
// undeclared — for both kinds.
func TestModalBodyMobileParams(t *testing.T) {
	s := &Service{}
	vid := mobileConv("video")
	body := s.modalBody(vid, 0)
	for k, want := range map[string]any{"depth_model": "da2", "warp": "backward", "inpaint": "none"} {
		if body[k] != want {
			t.Errorf("video body[%s]: want %v, got %v", k, want, body[k])
		}
	}
	img := mobileConv("image")
	ib := s.modalBody(img, 0)
	for k, want := range map[string]any{"stereo_mode": "both", "warp": "forward", "inpaint": "migan"} {
		if ib[k] != want {
			t.Errorf("image body[%s]: want %v, got %v", k, want, ib[k])
		}
	}
	if got := ib["formats"].([]string); len(got) != 1 || got[0] != "lr" {
		t.Errorf("image formats: want [lr], got %v", got)
	}
}

func TestCreateConversionReqRejectsBadPlacement(t *testing.T) {
	bad := [][]float64{{0.3}, {-1, 0.3, 0}, {0.3, -1}, {0.5, 0.5}, {-1.6, 0}, {-1, 1.6}}
	for _, p := range bad {
		r := &createConversionReq{GCSKey: "stereo3d/test/users/u1/abc/in.mp4", Placement: p}
		if err := r.validate(); err == nil {
			t.Errorf("placement %v must be rejected", p)
		}
	}
}
