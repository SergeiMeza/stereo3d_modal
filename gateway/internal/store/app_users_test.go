package store

import (
	"context"
	"testing"
)

// A merged app account (mergedInto, the app's account switch) reads as no
// record: its answers live on the target.
func TestGetAppViewingSkipsMerged(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	live, merged := "u"+NewID(), "u"+NewID()
	s.fs.Collection("app_users").Doc(live).Set(ctx, map[string]any{"viewingDevice": "otherHeadset", "viewingDeviceAnswered": true, "usedDevices": []any{"iPhone17,1"}})
	s.fs.Collection("app_users").Doc(merged).Set(ctx, map[string]any{"viewingDevice": "appleVisionPro", "mergedInto": "u-target"})
	if av, err := s.GetAppViewing(ctx, live); err != nil || av == nil || av.ViewingDevice != "otherHeadset" || len(av.UsedDevices) != 1 {
		t.Fatalf("live %+v %v", av, err)
	}
	if av, err := s.GetAppViewing(ctx, merged); err != nil || av != nil {
		t.Fatalf("merged %+v %v", av, err)
	}
}
