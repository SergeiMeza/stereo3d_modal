package store

import (
	"context"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// AppViewing is what the Spatial Video Studio app knows of where someone
// watches, from the SVS backend's app_users/{uid} (read only; the app
// writes it): the onboarding answer viewingDevice (appleVisionPro |
// otherHeadset | screenOnly) and the hardware it ran on (usedDevices,
// model ids such as RealityDevice14,1).
type AppViewing struct {
	ViewingDevice string
	Answered      bool
	UsedDevices   []string
}

// GetAppViewing reads app_users/{uid}; nil when the app has no record (or
// merged it into another account: mergedInto).
func (s *Store) GetAppViewing(ctx context.Context, uid string) (*AppViewing, error) {
	snap, err := s.fs.Collection("app_users").Doc(uid).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var d struct {
		ViewingDevice         string   `firestore:"viewingDevice"`
		ViewingDeviceAnswered bool     `firestore:"viewingDeviceAnswered"`
		UsedDevices           []string `firestore:"usedDevices"`
	}
	data := snap.Data()
	// An account the app merged into another (account switch, phase 2):
	// its answers live on the target now; this one reads as no record.
	if v, _ := data["mergedInto"].(string); v != "" {
		return nil, nil
	}
	if v, ok := data["viewingDevice"].(string); ok {
		d.ViewingDevice = v
	}
	if v, ok := data["viewingDeviceAnswered"].(bool); ok {
		d.ViewingDeviceAnswered = v
	}
	if v, ok := data["usedDevices"].([]any); ok {
		for _, x := range v {
			if str, ok := x.(string); ok {
				d.UsedDevices = append(d.UsedDevices, str)
			}
		}
	}
	return &AppViewing{ViewingDevice: d.ViewingDevice, Answered: d.ViewingDeviceAnswered, UsedDevices: d.UsedDevices}, nil
}
