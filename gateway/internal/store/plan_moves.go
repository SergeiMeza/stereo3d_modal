package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Support moves a plan off a live account (RP-05, owner 2026-11-06): an
// admin offers it on a case; the receiving account accepts. One record
// per subscription in plan_moves_{env}/{sub}; an offer or accept checks
// plan_restores_{env}/{sub} in the same transaction, so a subscription is
// never moved and restored at once.

const (
	PlanMoveOffered   = "offered"
	PlanMoveAccepted  = "accepted" // in progress (a retried accept resumes)
	PlanMoveDone      = "done"
	PlanMoveExpired   = "expired"
	PlanMoveCancelled = "cancelled"
	PlanMoveTTL       = 7 * 24 * time.Hour
)

var (
	ErrMoveBusy    = errors.New("a move of this plan is open")
	ErrMoveInvalid = errors.New("no such move for this account")
	ErrMoveExpired = errors.New("the move offer has expired")
)

// CasePlanMove is the move on its case.
type CasePlanMove struct {
	FromUID        string     `firestore:"from_uid" json:"from_uid"`
	ToUID          string     `firestore:"to_uid" json:"to_uid"`
	SubscriptionID string     `firestore:"subscription_id" json:"subscription_id"`
	Plan           string     `firestore:"plan" json:"plan"`
	PeriodEnd      time.Time  `firestore:"period_end" json:"period_end"`
	State          string     `firestore:"state" json:"state"`
	TokenHash      string     `firestore:"token_hash" json:"-"`
	OfferedBy      string     `firestore:"offered_by" json:"offered_by"`
	OfferedAt      time.Time  `firestore:"offered_at" json:"offered_at"`
	ExpiresAt      time.Time  `firestore:"expires_at" json:"expires_at"`
	AcceptedAt     *time.Time `firestore:"accepted_at,omitempty" json:"accepted_at,omitempty"`
	AuthTime       *time.Time `firestore:"auth_time,omitempty" json:"auth_time,omitempty"`
	DoneAt         *time.Time `firestore:"done_at,omitempty" json:"done_at,omitempty"`
}

// PlanMove is plan_moves_{env}/{sub}.
type PlanMove struct {
	ID             string     `firestore:"-"` // the subscription id
	MoveID         string     `firestore:"move_id"`
	TokenHash      string     `firestore:"token_hash"`
	CaseID         string     `firestore:"case_id"`
	FromUID        string     `firestore:"from_uid"`
	ToUID          string     `firestore:"to_uid"`
	Plan           string     `firestore:"plan"`
	PlanID         string     `firestore:"plan_id,omitempty"`
	PeriodEnd      time.Time  `firestore:"period_end"`
	State          string     `firestore:"state"`
	OfferedBy      string     `firestore:"offered_by"`
	OfferedAt      time.Time  `firestore:"offered_at"`
	ExpiresAt      time.Time  `firestore:"expires_at"`
	AcceptedAt     *time.Time `firestore:"accepted_at,omitempty"`
	AuthTime       *time.Time `firestore:"auth_time,omitempty"`
	DoneAt         *time.Time `firestore:"done_at,omitempty"`
	CarryPlanned   bool       `firestore:"carry_planned"`
	CarryRemoved   bool       `firestore:"carry_removed"`
	CarryCents     int64      `firestore:"carry_cents"`
	CarryExpiresAt *time.Time `firestore:"carry_expires_at,omitempty"`
}

func planMovesCol(env string) string { return "plan_moves_" + env }

// MoveTokenHash is a move id's hash (the case keeps only this).
func MoveTokenHash(moveID string) string {
	sum := sha256.Sum256([]byte("plan-move:" + moveID))
	return hex.EncodeToString(sum[:16])
}

func moveOf(snap *firestore.DocumentSnapshot) (*PlanMove, error) {
	var m PlanMove
	if err := snap.DataTo(&m); err != nil {
		return nil, err
	}
	m.ID = snap.Ref.ID
	return &m, nil
}

// OfferPlanMove writes an offer: refused while another offer is live, a
// move is under way, or the subscription is being restored.
func (s *Store) OfferPlanMove(ctx context.Context, m *PlanMove, now time.Time) error {
	ref := s.fs.Collection(planMovesCol(s.env)).Doc(m.ID)
	rref := s.fs.Collection(planRestoresCol(s.env)).Doc(m.ID)
	return s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		if snap, err := tx.Get(rref); err == nil {
			if st, _ := snap.Data()["state"].(string); st != PlanRestoreAvailable {
				return ErrRestoredElsewhere
			}
		} else if status.Code(err) != codes.NotFound {
			return err
		}
		snap, err := tx.Get(ref)
		if err == nil {
			old, err := moveOf(snap)
			if err != nil {
				return err
			}
			if old.State == PlanMoveAccepted || (old.State == PlanMoveOffered && now.Before(old.ExpiresAt)) {
				return ErrMoveBusy
			}
		} else if status.Code(err) != codes.NotFound {
			return err
		}
		return tx.Set(ref, m)
	})
}

// GetPlanMove is a subscription's move (ErrNotFound when none).
func (s *Store) GetPlanMove(ctx context.Context, subID string) (*PlanMove, error) {
	snap, err := s.fs.Collection(planMovesCol(s.env)).Doc(subID).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return moveOf(snap)
}

// ListPlanMovesTo is the offers waiting for uid (not expired).
func (s *Store) ListPlanMovesTo(ctx context.Context, uid string, now time.Time) ([]*PlanMove, error) {
	snaps, err := s.fs.Collection(planMovesCol(s.env)).Where("to_uid", "==", uid).Where("state", "==", PlanMoveOffered).Limit(20).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := []*PlanMove{}
	for _, sn := range snaps {
		if m, err := moveOf(sn); err == nil && now.Before(m.ExpiresAt) {
			out = append(out, m)
		}
	}
	return out, nil
}

// planMoveByID finds a move by its id (the accept's path).
func (s *Store) planMoveByID(ctx context.Context, moveID string) (*firestore.DocumentRef, error) {
	snaps, err := s.fs.Collection(planMovesCol(s.env)).Where("token_hash", "==", MoveTokenHash(moveID)).Limit(1).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	if len(snaps) == 0 {
		return nil, ErrMoveInvalid
	}
	return snaps[0].Ref, nil
}

// ClaimPlanMove starts uid's accept: an offer for uid becomes accepted;
// accepted or done for uid answers as it is (a retry resumes); an
// expired offer is marked so (ErrMoveExpired); anything else is
// ErrMoveInvalid. The move id is single use: it opens one accept only.
func (s *Store) ClaimPlanMove(ctx context.Context, moveID, uid string, authTime, now time.Time) (*PlanMove, error) {
	if moveID == "" {
		return nil, ErrMoveInvalid
	}
	ref, err := s.planMoveByID(ctx, moveID)
	if err != nil {
		return nil, err
	}
	rref := s.fs.Collection(planRestoresCol(s.env)).Doc(ref.ID)
	var out *PlanMove
	err = s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(ref)
		if err != nil {
			return err
		}
		m, err := moveOf(snap)
		if err != nil {
			return err
		}
		out = m
		if m.ToUID != uid || m.MoveID != moveID {
			return ErrMoveInvalid
		}
		switch m.State {
		case PlanMoveAccepted, PlanMoveDone:
			return nil
		case PlanMoveOffered:
		default:
			return ErrMoveInvalid
		}
		if !now.Before(m.ExpiresAt) {
			m.State = PlanMoveExpired
			return tx.Update(ref, []firestore.Update{{Path: "state", Value: PlanMoveExpired}})
		}
		if rs, err := tx.Get(rref); err == nil {
			if st, _ := rs.Data()["state"].(string); st != PlanRestoreAvailable {
				return ErrRestoredElsewhere
			}
		} else if status.Code(err) != codes.NotFound {
			return err
		}
		m.State, m.AcceptedAt, m.AuthTime = PlanMoveAccepted, &now, &authTime
		return tx.Update(ref, []firestore.Update{{Path: "state", Value: PlanMoveAccepted}, {Path: "accepted_at", Value: now}, {Path: "auth_time", Value: authTime}})
	})
	if err == nil && out != nil && out.State == PlanMoveExpired {
		return out, ErrMoveExpired
	}
	return out, err
}

// UpdatePlanMove changes a move record.
func (s *Store) UpdatePlanMove(ctx context.Context, subID string, ups []firestore.Update) error {
	_, err := s.fs.Collection(planMovesCol(s.env)).Doc(subID).Update(ctx, ups)
	return err
}

// SetPlanMoveCarry records the credit a move carries (before it is taken
// off the old account), then that it was taken.
func (s *Store) SetPlanMoveCarry(ctx context.Context, subID string, cents int64, expires *time.Time) error {
	return s.UpdatePlanMove(ctx, subID, []firestore.Update{{Path: "carry_planned", Value: true}, {Path: "carry_cents", Value: cents},
		{Path: "carry_expires_at", Value: expires}})
}

// CancelPlanMove withdraws a live offer (ErrMoveInvalid when there's none).
func (s *Store) CancelPlanMove(ctx context.Context, subID string) error {
	ref := s.fs.Collection(planMovesCol(s.env)).Doc(subID)
	return s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(ref)
		if status.Code(err) == codes.NotFound {
			return ErrMoveInvalid
		}
		if err != nil {
			return err
		}
		if st, _ := snap.Data()["state"].(string); st != PlanMoveOffered {
			return ErrMoveInvalid
		}
		return tx.Update(ref, []firestore.Update{{Path: "state", Value: PlanMoveCancelled}})
	})
}

// MovePlanBetween puts next on to and takes the plan off from, in one
// transaction (from keeps plan_moved_to). Already moved: no-op.
func (s *Store) MovePlanBetween(ctx context.Context, from, to, subID string, next *Plan, now time.Time) error {
	fref, tref := s.fs.Collection(customersCol(s.env)).Doc(from), s.fs.Collection(customersCol(s.env)).Doc(to)
	return s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		fs, err := tx.Get(fref)
		if err != nil {
			return err
		}
		var fc Customer
		if err := fs.DataTo(&fc); err != nil {
			return err
		}
		var tc Customer
		ts, err := tx.Get(tref)
		toExists := err == nil
		if toExists {
			if err := ts.DataTo(&tc); err != nil {
				return err
			}
		} else if status.Code(err) != codes.NotFound {
			return err
		}
		if fc.PlanMovedTo == to && tc.Plan != nil && tc.Plan.SubscriptionID == subID {
			return nil
		}
		if fc.Plan == nil || fc.Plan.SubscriptionID != subID {
			return ErrMoveInvalid
		}
		data, paths := map[string]any{"plan": next}, []firestore.FieldPath{{"plan"}} // the plan field only: the rest of the record stays
		if !toExists {
			data["created_at"], paths = now, append(paths, firestore.FieldPath{"created_at"})
		}
		if err := tx.Set(tref, data, firestore.Merge(paths...)); err != nil {
			return err
		}
		return tx.Update(fref, []firestore.Update{{Path: "plan", Value: firestore.Delete}, {Path: "plan_moved_to", Value: to},
			{Path: "plan_moved_at", Value: now}})
	})
}
