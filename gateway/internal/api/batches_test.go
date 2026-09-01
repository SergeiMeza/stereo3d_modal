package api

import (
	"strings"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func TestBatchDescriptionGroupsRepeats(t *testing.T) {
	b := &store.Batch{Items: []store.BatchItem{
		{ConversionID: "a", Description: "Stereo preview"},
		{ConversionID: "b", Description: "Stereo preview"},
		{ConversionID: "c", Description: "Production 3D render"},
	}}
	if got := batchDescription(b); got != "Stereo preview ×2, Production 3D render" {
		t.Errorf("got %q", got)
	}
	long := &store.Batch{}
	for i := 0; i < 40; i++ {
		long.Items = append(long.Items, store.BatchItem{ConversionID: strings.Repeat("x", 12) + string(rune('a'+i%26)), Description: "Stereo preview with inpainting " + string(rune('a'+i))})
	}
	if d := batchDescription(long); len(d) > 200 {
		t.Errorf("description not capped: %d chars", len(d))
	}
	meta := batchMetadata(long)
	if len(meta["conversion_ids"]) > 500 {
		t.Errorf("metadata value over Stripe's 500-char cap: %d", len(meta["conversion_ids"]))
	}
	if meta["items"] != "40" {
		t.Errorf("items metadata %q", meta["items"])
	}
}

func TestBatchDescriptionCapsAtStripeLimit(t *testing.T) {
	b := &store.Batch{Items: []store.BatchItem{{Description: strings.Repeat("y", 300)}}}
	if d := batchDescription(b); len(d) > 200 {
		t.Errorf("description %d chars", len(d))
	}
}
