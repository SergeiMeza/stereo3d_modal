package api

import (
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Every id the store hands out passes the routes' check: plain ids and
// the runs started with an Idempotency-Key (the web's starts), whose
// status polls 404ed before the check took the "k" form.
func TestValidResourceIDTakesEveryStoreID(t *testing.T) {
	for _, id := range []string{store.NewID(), store.IdemConversionID("test", "uid", "key")} {
		if !ValidResourceID(id) {
			t.Fatalf("the routes refuse store id %q", id)
		}
	}
	for _, id := range []string{"", "smp123", "k12345678901234", "K0123456789abcde", "kabc03e7d96c8e9g", "abc03e7d96c8e9f0", "ABC03E7D96C8"} {
		if ValidResourceID(id) {
			t.Fatalf("the routes take %q", id)
		}
	}
}
