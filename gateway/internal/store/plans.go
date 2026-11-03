package store

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Web plans (Business, Studio — pricing 2026-11): a Stripe Billing
// subscription on the web's own product. Customer.Plan mirrors it from
// customer.subscription.* events.
type Plan struct {
	Tier               string     `firestore:"tier" json:"tier"` // business | studio
	SubscriptionID     string     `firestore:"subscription_id" json:"-"`
	Status             string     `firestore:"status" json:"status"` // Stripe's: active, past_due, canceled, …
	CurrentPeriodStart *time.Time `firestore:"current_period_start,omitempty" json:"current_period_start,omitempty"`
	CurrentPeriodEnd   *time.Time `firestore:"current_period_end,omitempty" json:"current_period_end,omitempty"`
	CancelAtPeriodEnd  bool       `firestore:"cancel_at_period_end" json:"cancel_at_period_end"`
	UpdatedAt          time.Time  `firestore:"updated_at" json:"-"`
}

// Active: the plan's prices and allowances apply.
func (p *Plan) Active(now time.Time) bool {
	if p == nil || p.Tier == "" {
		return false
	}
	switch p.Status {
	case "active", "trialing", "past_due":
		return p.CurrentPeriodEnd == nil || p.CurrentPeriodEnd.After(now.Add(-24*time.Hour))
	}
	return false
}

// FreePreview is a run paid with free previews.
type FreePreview struct {
	Units     int    `firestore:"units"`
	PeriodKey string `firestore:"period_key"`
	DayKey    string `firestore:"day_key"`
	Returned  bool   `firestore:"returned,omitempty"`
}

// PreviewUsage is previews_{env}/{uid}: free previews used this period
// and today (no rollover: a new period key starts at zero).
type PreviewUsage struct {
	PeriodKey string    `firestore:"period_key"`
	Used      int       `firestore:"used"`
	DayKey    string    `firestore:"day_key"`
	DayUsed   int       `firestore:"day_used"`
	IntroUsed bool      `firestore:"intro_used"`
	UpdatedAt time.Time `firestore:"updated_at"`
}

func previewsCol(env string) string { return "previews_" + env }

func (s *Store) previewDoc(uid string) *firestore.DocumentRef {
	return s.fs.Collection(previewsCol(s.env)).Doc(uid)
}

func snapToUsage(snap *firestore.DocumentSnapshot) (*PreviewUsage, error) {
	var u PreviewUsage
	if snap == nil || !snap.Exists() {
		return &u, nil
	}
	if err := snap.DataTo(&u); err != nil {
		return nil, err
	}
	return &u, nil
}

// GetPreviewUsage reads the usage as of periodKey/dayKey (a new period or
// day reads zero).
func (s *Store) GetPreviewUsage(ctx context.Context, uid, periodKey, dayKey string) (*PreviewUsage, error) {
	snap, err := s.previewDoc(uid).Get(ctx)
	if err != nil && status.Code(err) != codes.NotFound {
		return nil, err
	}
	u, err := snapToUsage(snap)
	if err != nil {
		return nil, err
	}
	if u.PeriodKey != periodKey {
		u.Used = 0
	}
	if u.DayKey != dayKey {
		u.DayUsed = 0
	}
	return u, nil
}

// ConsumeFreePreviews takes units free previews if the period allowance
// and the day cap both have room; intro=true takes the one-time intro
// preview instead. false when there is no room.
func (s *Store) ConsumeFreePreviews(ctx context.Context, uid, periodKey, dayKey string, units, allowance, dayCap int, intro bool) (bool, error) {
	ok := false
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		ok = false
		snap, err := tx.Get(s.previewDoc(uid))
		if err != nil && status.Code(err) != codes.NotFound {
			return err
		}
		u, err := snapToUsage(snap)
		if err != nil {
			return err
		}
		if u.PeriodKey != periodKey {
			u.PeriodKey, u.Used = periodKey, 0
		}
		if u.DayKey != dayKey {
			u.DayKey, u.DayUsed = dayKey, 0
		}
		if intro {
			if u.IntroUsed {
				return nil
			}
			u.IntroUsed = true
		} else {
			if u.Used+units > allowance || u.DayUsed+units > dayCap {
				return nil
			}
			u.Used += units
		}
		u.DayUsed += units
		u.UpdatedAt = time.Now().UTC()
		ok = true
		return tx.Set(s.previewDoc(uid), u)
	})
	return ok, err
}

// returnFreePreview gives a run's free previews back inside its terminal
// transition when it delivered nothing.
func (s *Store) returnFreePreview(tx *firestore.Transaction, c *Conversion) (func() error, error) {
	fp := c.FreePreview
	if fp == nil || fp.Returned || !IsTerminal(c.State) || c.State == StateSucceeded {
		return nil, nil
	}
	snap, err := tx.Get(s.previewDoc(c.UID))
	if err != nil && status.Code(err) != codes.NotFound {
		return nil, err
	}
	u, err := snapToUsage(snap)
	if err != nil {
		return nil, err
	}
	switch {
	case fp.PeriodKey == "intro":
		u.IntroUsed = false
	case u.PeriodKey == fp.PeriodKey:
		u.Used = max(u.Used-fp.Units, 0)
	}
	if u.DayKey == fp.DayKey {
		u.DayUsed = max(u.DayUsed-fp.Units, 0)
	}
	u.UpdatedAt = time.Now().UTC()
	fp.Returned = true
	return func() error { return tx.Set(s.previewDoc(c.UID), u) }, nil
}

// Free previews (pricing 2026-11): a run paid with them.
const (
	FlowFreePreview        = "free_preview"
	BillingModeFreePreview = "free_preview"
)

// GiveBackFreePreview returns a preview's units when its run was never
// written.
func (s *Store) GiveBackFreePreview(ctx context.Context, uid string, fp *FreePreview) {
	if fp == nil {
		return
	}
	_ = s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		c := &Conversion{UID: uid, State: StateFailed, FreePreview: &FreePreview{Units: fp.Units, PeriodKey: fp.PeriodKey, DayKey: fp.DayKey}}
		commit, err := s.returnFreePreview(tx, c)
		if err != nil || commit == nil {
			return err
		}
		return commit()
	})
}
