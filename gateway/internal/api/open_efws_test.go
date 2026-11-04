package api

import (
	"context"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// open_efws: open efw cases and caseless fraud-warning holds.
func TestOpenEFWs(t *testing.T) {
	s := pkService(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	if _, _, err := s.Store.CreateCase(ctx, &store.Case{UID: uid, Type: store.CaseEFW, Reason: ReasonEFW, Mode: "manual", Status: store.CaseOpen, DedupeKey: "efw:a" + uid}, "system", "x"); err != nil {
		t.Fatal(err)
	}
	closed, _, _ := s.Store.CreateCase(ctx, &store.Case{UID: uid, Type: store.CaseEFW, Reason: ReasonEFW, Mode: "manual", Status: store.CaseOpen, DedupeKey: "efw:b" + uid}, "system", "x")
	s.closeCase(ctx, closed.ID, "owner", store.CaseDenied, "")
	s.Store.CreatePromoRegrant(ctx, "efw:w"+uid, &store.PromoRegrant{UID: uid, Policy: promoPolicyAll, Status: "held"})
	s.Store.CreatePromoRegrant(ctx, "dispute:d"+uid, &store.PromoRegrant{UID: uid, Policy: promoPolicyAll, Status: "held"})
	if n := s.openEFWs(ctx); n != 2 {
		t.Fatalf("open efws %d", n)
	}
}
