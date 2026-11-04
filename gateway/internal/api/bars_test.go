package api

import (
	"context"
	"encoding/json"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func barsProject(w, h int, crop string) *store.Project {
	return &store.Project{Method: store.MethodLifelike, Probe: &store.Probe{Width: w, Height: h, FPS: 24, NumFrames: 240, DurationS: 10}, Crop: crop}
}

// BL-03: bars only when the picture inside is smaller than the frame
// turned to the crop's orientation (crop is displayed pixels, probe
// coded), beyond cropdetect's rounding.
func TestHasBars(t *testing.T) {
	for _, tc := range []struct {
		name       string
		w, h       int
		crop       string
		want       bool
		wantW, wid int
	}{
		{"none", 3840, 2160, "", false, 0, 0},
		{"full frame", 3840, 2160, "3840:2160:0:0", false, 0, 0},
		{"2-px rounding", 3840, 2160, "3840:2158:0:0", false, 0, 0},
		{"letterbox", 3840, 2160, "3840:1600:0:280", true, 3840, 1600},
		{"pillarbox", 1920, 1080, "1440:1080:240:0", true, 1440, 1080},
		{"rotated full frame", 1920, 1080, "1080:1920:0:0", false, 0, 0},
		{"rotated letterbox", 1920, 1080, "800:1920:140:0", true, 800, 1920},
		{"malformed", 3840, 2160, "not-a-crop", false, 0, 0},
	} {
		p := barsProject(tc.w, tc.h, tc.crop)
		c, ok := barsCrop(p)
		if ok != tc.want || hasBars(p) != tc.want || (ok && (c.W != tc.wantW || c.H != tc.wid)) {
			t.Errorf("%s: bars %v %+v", tc.name, ok, c)
		}
		if _, _, cropped := depthContentDims(p); cropped != tc.want {
			t.Errorf("%s: depthContentDims cropped %v", tc.name, cropped)
		}
		if removeBars(p) != tc.want {
			t.Errorf("%s: removeBars by default %v", tc.name, removeBars(p))
		}
	}
	p := barsProject(3840, 2160, "3840:1600:0:280")
	keep := false
	p.RemoveBars = &keep
	if removeBars(p) {
		t.Fatal("kept bars")
	}
	p.RemoveBars, p.BarsRemovalOff = nil, true
	if removeBars(p) {
		t.Fatal("switch off")
	}
}

// PATCH remove_bars; the project shows crop, has_bars, remove_bars and
// whether the gateway can take bars off.
func TestRemoveBarsSetting(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	c := projCaller{t, s, &AuthedUser{UID: uid}}
	p := barsProject(3840, 2160, "3840:1600:0:280")
	p.ID, p.UID = store.NewID(), uid
	s.Store.CreateProject(ctx, p)
	read := func(body string) map[string]any {
		var out map[string]any
		json.Unmarshal([]byte(body), &out)
		return out
	}
	code, body := c.do(s.HandleGetProject, p.ID, "")
	out := read(body)
	if code != 200 || out["crop"] != "3840:1600:0:280" || out["has_bars"] != true || out["remove_bars"] != true || out["bars_removal_available"] != true {
		t.Fatalf("get %d %s", code, body)
	}
	code, body = c.do(s.HandleUpdateProject, p.ID, `{"remove_bars":false}`)
	if out = read(body); code != 200 || out["remove_bars"] != false || out["has_bars"] != true {
		t.Fatalf("keep %d %s", code, body)
	}
	got, _ := s.Store.GetProject(ctx, p.ID)
	if got.RemoveBars == nil || *got.RemoveBars || removeBars(got) {
		t.Fatalf("stored %+v", got.RemoveBars)
	}
	c.do(s.HandleUpdateProject, p.ID, `{"remove_bars":true}`)
	if got, _ = s.Store.GetProject(ctx, p.ID); !removeBars(got) {
		t.Fatal("back on")
	}
	plain := barsProject(1920, 1080, "1080:1920:0:0")
	plain.ID, plain.UID = store.NewID(), uid
	s.Store.CreateProject(ctx, plain)
	_, body = c.do(s.HandleGetProject, plain.ID, "")
	if out = read(body); out["has_bars"] != false || out["remove_bars"] != false {
		t.Fatalf("portrait without bars %s", body)
	}
	s.Pricing = pricing.NewStatic(pricing.Defaults()) // prod default: off
	_, body = c.do(s.HandleGetProject, p.ID, "")
	if out = read(body); out["bars_removal_available"] != false {
		t.Fatalf("switch off %s", body)
	}
	if owned, _ := s.ownedProject(ctx, c.user, p.ID); removeBars(owned) {
		t.Fatal("runs keep bars while the switch is off")
	}
}
