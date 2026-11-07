package api

import (
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// S3D-34: who waits past a minute, and how busy each pipeline looks.
func TestGPULineSnapshotAndMail(t *testing.T) {
	now := time.Date(2026, 11, 3, 12, 0, 0, 0, time.UTC)
	ago := func(d time.Duration) *time.Time { v := now.Add(-d); return &v }
	run := func(id, method, step string, waitingFor time.Duration) *store.Conversion {
		c := &store.Conversion{ID: id, UID: "u-" + id, State: store.StateProcessing, Method: method, Step: step,
			Params: store.Params{Preset: "4k"}, Source: store.Source{Frames: 1440, FPS: 24}}
		if waitingFor > 0 {
			c.Modal.WaitingForGPU, c.Modal.WaitingSince = true, ago(waitingFor)
		}
		return c
	}
	convs := []*store.Conversion{
		run("w1", store.MethodLifelike, store.StepProduction, 90*time.Second),
		run("w2", store.MethodClassic, store.StepProduction, 5*time.Minute),
		run("short", store.MethodLifelike, store.StepProduction, 30*time.Second), // under a minute
		run("ll", store.MethodLifelike, store.StepProduction, 0),
		run("llp", store.MethodLifelike, store.StepLifelikePreview, 0),
		run("cl1", store.MethodClassic, store.StepProduction, 0),
		run("cl2", store.MethodClassic, store.StepProduction, 0),
	}
	convs = append(convs, run("other", store.MethodClassic, store.StepProduction, 0))
	convs[len(convs)-1].Workspace = "ws-2"
	rates := pricing.Defaults()
	rates.GPUCapPerWorkspace = map[string]int{"ws-2": 16}
	s := &Service{DefaultWorkspaceID: "ws-1"}
	waiting, use := s.gpuLineSnapshot(convs, now, rates)
	if len(waiting) != 2 || waiting[0].Conv.ID != "w2" || waiting[1].Conv.ID != "w1" {
		t.Fatalf("waiting: %+v", waiting)
	}
	// lifelike: 4 (production) + 1 (preview); classic: 8 + 8 held to the cap 8
	if len(use) != 2 || use[0].Workspace != "ws-1" || use[0].Busy[store.MethodLifelike] != 5 || use[0].Busy[store.MethodClassic] != 8 || use[0].Cap != 8 ||
		use[1].Workspace != "ws-2" || use[1].Busy[store.MethodClassic] != 8 || use[1].Cap != 16 {
		t.Errorf("use: %+v", use)
	}
	m := gpuLineMail(waiting, use, map[string]string{"u-w2": "a@example.com"})
	for _, want := range []string{"Spatial Video Studio", "2 runs", "longest 5m 0s"} {
		if !strings.Contains(m.Subject, want) {
			t.Errorf("subject %q lacks %q", m.Subject, want)
		}
	}
	for _, want := range []string{"a@example.com — classic production, 4K, 1m 0s of video, waiting 5m 0s (conversion w2, workspace ws-1)", "uid u-w1", "- ws-1: Classic 8 of 8, Lifelike 5 of 8", "- ws-2: Classic 8 of 16, Lifelike 0 of 16", "Oldest wait: 5m 0s"} {
		if !strings.Contains(m.Text, want) {
			t.Errorf("body lacks %q:\n%s", want, m.Text)
		}
	}
	started := now.Add(-20 * time.Minute)
	c := gpuLineClearedMail(store.GPULine{Active: true, StartedAt: &started, LongestWaitS: 362}, now)
	if !strings.Contains(c.Subject, "Spatial Video Studio: GPU line cleared (longest wait 6m 2s)") || !strings.Contains(c.Text, "after 20m 0s") {
		t.Errorf("cleared: %+v", c)
	}
}
