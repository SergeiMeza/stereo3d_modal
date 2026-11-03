package api

import (
	"os"
	"strings"
	"testing"
)

// S3D-22 (the App Store way): downloads never lock for payment reasons —
// a failed charge refuses new paid runs instead (stepBillingError). Guard
// against the old 402 gate coming back.
func TestDownloadsNeverPaymentGated(t *testing.T) {
	src := readSource(t, "handlers.go")
	i := strings.Index(src, "func (s *Service) HandleDownloads(")
	if i < 0 {
		t.Fatal("HandleDownloads not found")
	}
	body := src[i:]
	body = body[:strings.Index(body, "\n}\n")]
	for _, banned := range []string{"PIChargeFailed", "billing_overdue", "StatusPaymentRequired"} {
		if strings.Contains(body, banned) {
			t.Errorf("downloads must not check %s", banned)
		}
	}
}

func readSource(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}
