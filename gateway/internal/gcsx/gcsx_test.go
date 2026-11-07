package gcsx

import (
	"context"
	"testing"
)

func testClient() *Client {
	return &Client{bucket: "spatial-video-studio-app", prefix: "stereo3d/test/"}
}

func TestKeyFromPublicURL(t *testing.T) {
	c := testClient()
	key, err := c.KeyFromPublicURL(
		"https://storage.googleapis.com/spatial-video-studio-app/stereo3d/test/outputs/abc123/final_sbs%20copy.mp4")
	if err != nil {
		t.Fatal(err)
	}
	want := "stereo3d/test/outputs/abc123/final_sbs copy.mp4"
	if key != want {
		t.Errorf("got %q want %q", key, want)
	}
}

func TestKeyFromPublicURLWrongBucket(t *testing.T) {
	c := testClient()
	if _, err := c.KeyFromPublicURL("https://storage.googleapis.com/other-bucket/foo.mp4"); err == nil {
		t.Error("want error for wrong bucket")
	}
}

func TestInPrefix(t *testing.T) {
	c := testClient()
	cases := map[string]bool{
		"stereo3d/test/users/u1/abc/source.mp4":    true,
		"stereo3d/prod/users/u1/abc/source.mp4":    false, // other env
		"stereo3d/test/../../secrets.txt":          false, // traversal
		"users/u1/abc/source.mp4":                  false, // bucket root (production user data)
		"stereo3d/test/users/u1/../../../root.mp4": false,
	}
	for key, want := range cases {
		if got := c.InPrefix(key); got != want {
			t.Errorf("InPrefix(%q) = %v, want %v", key, got, want)
		}
	}
}

func TestUploadKey(t *testing.T) {
	c := testClient()
	got := c.UploadKey("uid1", "abc123def456", ".mp4")
	want := "stereo3d/test/users/uid1/abc123def456/source.mp4"
	if got != want {
		t.Errorf("got %q want %q", got, want)
	}
}

// File keeping (S3D-24) may only list folders and delete keys inside
// this env's prefix.
func TestListDeleteStayInPrefix(t *testing.T) {
	var listed, deleted []string
	c := NewWithSigner("bucket", "stereo3d/test/", nil, nil).WithObjects(
		func(_ context.Context, p string) ([]string, error) { listed = append(listed, p); return nil, nil },
		func(_ context.Context, k string) error { deleted = append(deleted, k); return nil })
	ctx := context.Background()
	for _, bad := range []string{"stereo3d/test/", "stereo3d/prod/outputs/x/", "stereo3d/test/outputs/x", "stereo3d/test/../prod/"} {
		if _, err := c.List(ctx, bad); err == nil {
			t.Errorf("List(%q) allowed", bad)
		}
	}
	if _, err := c.List(ctx, "stereo3d/test/outputs/job1/"); err != nil {
		t.Error(err)
	}
	for _, bad := range []string{"stereo3d/prod/users/u/a/source.mp4", "stereo3d/test/../prod/x"} {
		if err := c.Delete(ctx, bad); err == nil {
			t.Errorf("Delete(%q) allowed", bad)
		}
	}
	if err := c.Delete(ctx, "stereo3d/test/outputs/job1/a.mov"); err != nil {
		t.Error(err)
	}
	if len(listed) != 1 || len(deleted) != 1 {
		t.Errorf("listed %v deleted %v", listed, deleted)
	}
}
