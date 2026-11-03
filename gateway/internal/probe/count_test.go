package probe

import (
	"context"
	"os/exec"
	"path/filepath"
	"testing"
)

// ffmpeg-made fixtures: a variable-rate source (30 fps with a 120 fps
// burst) in MP4 (index count) and Matroska (packet count), and a 150 fps
// source whose rate only shows in the count.
func TestCountFrames(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("needs ffmpeg")
	}
	dir := t.TempDir()
	mk := func(name string, args ...string) string {
		out := filepath.Join(dir, name)
		cmd := exec.Command("ffmpeg", append(append([]string{"-v", "error", "-y"}, args...), out)...)
		if b, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%s: %v %s", name, err, b)
		}
		return out
	}
	src := []string{"-f", "lavfi", "-i", "testsrc=rate=120:size=64x64:duration=3",
		"-vf", `select='not(mod(n\,4))+between(t\,1\,1.5)'`, "-fps_mode", "vfr", "-c:v", "libx264", "-preset", "ultrafast"}
	vfrMP4 := mk("vfr.mp4", src...)
	vfrMKV := mk("vfr.mkv", "-i", vfrMP4, "-c", "copy")
	fast := mk("fast.mkv", "-f", "lavfi", "-i", "testsrc=rate=150:size=64x64:duration=2", "-c:v", "libx264", "-preset", "ultrafast")

	for _, tc := range []struct {
		path, method string
		frames       int
	}{{vfrMP4, "index", 135}, {vfrMKV, "packets", 135}, {fast, "packets", 300}} {
		c, err := Count(context.Background(), tc.path)
		if err != nil || c.Frames != tc.frames || c.Method != tc.method || c.DurationS <= 0 {
			t.Fatalf("%s: %+v %v", filepath.Base(tc.path), c, err)
		}
	}
	c, _ := Count(context.Background(), fast)
	if f := c.FPS(); f < 149 || f > 151 {
		t.Fatalf("fast fps %v", f)
	}
}
