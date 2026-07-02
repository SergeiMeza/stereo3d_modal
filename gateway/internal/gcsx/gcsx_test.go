package gcsx

import "testing"

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
		"stereo3d/test/users/u1/abc/source.mp4":       true,
		"stereo3d/prod/users/u1/abc/source.mp4":       false, // other env
		"stereo3d/test/../../secrets.txt":             false, // traversal
		"users/u1/abc/source.mp4":                     false, // bucket root (production user data)
		"stereo3d/test/users/u1/../../../root.mp4":    false,
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
