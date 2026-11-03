package mail

import (
	"strings"
	"testing"
)

func TestSignInCode(t *testing.T) {
	m := SignInCode("a@example.com", "042817")
	if m.Subject != "Spatial Video Studio: your sign-in code" || m.To != "a@example.com" {
		t.Fatalf("%+v", m)
	}
	for _, body := range []string{m.Text, m.HTML} {
		if !strings.Contains(body, "042817") || !strings.Contains(body, "10 minutes") {
			t.Fatalf("body: %q", body)
		}
		if strings.Contains(strings.ToLower(body), "firebase") || strings.Contains(strings.ToLower(body), "google") {
			t.Fatalf("names the provider: %q", body)
		}
	}
}
