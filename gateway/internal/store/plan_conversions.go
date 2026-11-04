package store

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// PlanConversion is someone starting Pro, Business or Studio, with the
// plans surface they last clicked in the 7 days before (owner
// 2026-11-04): plan_conversions_{env}/{key}, key once per start
// (plan:{subscription} | pro:{uid}:{day}).
type PlanConversion struct {
	UID       string     `firestore:"uid" json:"-"`
	Product   string     `firestore:"product" json:"product"` // pro | business | studio
	Source    string     `firestore:"source" json:"source"`   // checkout | revenuecat
	At        time.Time  `firestore:"at" json:"at"`
	Placement string     `firestore:"placement,omitempty" json:"placement,omitempty"` // "" = no click in the window
	Variant   string     `firestore:"variant,omitempty" json:"variant,omitempty"`
	ClickPlan string     `firestore:"click_plan,omitempty" json:"click_plan,omitempty"`
	Reason    string     `firestore:"reason,omitempty" json:"reason,omitempty"`
	ClickAt   *time.Time `firestore:"click_at,omitempty" json:"click_at,omitempty"`
}

func planConvCol(env string) string { return "plan_conversions_" + env }

// AddPlanConversion stores it once per key (false when it was there).
func (s *Store) AddPlanConversion(ctx context.Context, key string, c PlanConversion) (bool, error) {
	_, err := s.fs.Collection(planConvCol(s.env)).Doc(key).Create(ctx, c)
	if status.Code(err) == codes.AlreadyExists {
		return false, nil
	}
	return err == nil, err
}

// ListPlanConversionsSince is every start since t.
func (s *Store) ListPlanConversionsSince(ctx context.Context, since time.Time, limit int) ([]PlanConversion, error) {
	snaps, err := s.fs.Collection(planConvCol(s.env)).Where("at", ">=", since).OrderBy("at", firestore.Asc).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]PlanConversion, 0, len(snaps))
	for _, sn := range snaps {
		var c PlanConversion
		if sn.DataTo(&c) == nil {
			out = append(out, c)
		}
	}
	return out, nil
}

// ListUserEvents is an account's events since t (by uid alone, no
// composite index; filtered here).
func (s *Store) ListUserEvents(ctx context.Context, uid string, since time.Time, limit int) ([]Event, error) {
	snaps, err := s.fs.Collection(eventsCol(s.env)).Where("uid", "==", uid).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]Event, 0, len(snaps))
	for _, sn := range snaps {
		var e Event
		if sn.DataTo(&e) == nil && !e.At.Before(since) {
			out = append(out, e)
		}
	}
	return out, nil
}

// ProState is the Pro status the gateway last saw for an account
// (pro_state_{env}/{uid}), so a start of Pro is seen as a change.
type ProState struct {
	Pro bool      `firestore:"pro"`
	At  time.Time `firestore:"at"`
}

func proStateDoc(s *Store, uid string) *firestore.DocumentRef {
	return s.fs.Collection("pro_state_" + s.env).Doc(uid)
}

// SwapProState records pro and returns what was there before (nil = never
// seen).
func (s *Store) SwapProState(ctx context.Context, uid string, pro bool, now time.Time) (*ProState, error) {
	var prev *ProState
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		prev = nil
		snap, err := tx.Get(proStateDoc(s, uid))
		if err == nil {
			var p ProState
			if snap.DataTo(&p) == nil {
				prev = &p
			}
		} else if status.Code(err) != codes.NotFound {
			return err
		}
		if prev != nil && prev.Pro == pro {
			return nil
		}
		return tx.Set(proStateDoc(s, uid), ProState{Pro: pro, At: now})
	})
	return prev, err
}
