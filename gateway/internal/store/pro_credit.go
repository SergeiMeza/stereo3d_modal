package store

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Pro's monthly usage credit (PRO-01..10, owner 2026-11-07). One grant per
// purchase and month in pro_credit_grants_{env}/{key hash}_m{k}: the
// purchase key follows the store purchase (renewals, product changes,
// transfers to another account), so a month is granted once whoever holds
// it. pro_credit_holders_{env}/{uid} is when to look again (the sweep).

const (
	ProCreditGranting = "granting" // claimed; the ledger entry is next
	ProCreditGranted  = "granted"
	ProCreditRemoved  = "removed" // its unspent part taken back on a refund
)

// ErrProCreditTaken: another account already holds that month's grant.
var ErrProCreditTaken = errors.New("pro credit month granted to another account")

// ProCreditGrant is one month's grant.
type ProCreditGrant struct {
	ID           string     `firestore:"-" json:"id"`
	UID          string     `firestore:"uid" json:"-"`
	KeyHash      string     `firestore:"key_hash" json:"-"`
	Month        int        `firestore:"month" json:"month"` // 0 = the first month from the anchor
	PeriodStart  time.Time  `firestore:"period_start" json:"period_start"`
	PeriodEnd    time.Time  `firestore:"period_end" json:"period_end"`
	Cents        int64      `firestore:"cents" json:"cents"`
	Kind         string     `firestore:"kind" json:"kind"`     // pro_weekly … pro_lifetime
	Source       string     `firestore:"source" json:"source"` // app_store | mac_app_store | rc_billing | web | …
	PeriodType   string     `firestore:"period_type,omitempty" json:"period_type,omitempty"`
	State        string     `firestore:"state" json:"state"`
	GrantedAt    time.Time  `firestore:"granted_at" json:"granted_at"`
	RemovedAt    *time.Time `firestore:"removed_at,omitempty" json:"removed_at,omitempty"`
	RemovedCents int64      `firestore:"removed_cents,omitempty" json:"removed_cents,omitempty"`
}

// ProCreditHolder is when the sweep looks at an account again.
type ProCreditHolder struct {
	NextCheckAt time.Time `firestore:"next_check_at"`
	Kind        string    `firestore:"kind"`
	UpdatedAt   time.Time `firestore:"updated_at"`
}

func proCreditGrantsCol(env string) string  { return "pro_credit_grants_" + env }
func proCreditHoldersCol(env string) string { return "pro_credit_holders_" + env }

// ProKeyHash hashes a purchase key (no store ids stored as they are).
func ProKeyHash(key string) string {
	sum := sha256.Sum256([]byte("pro-credit:" + key))
	return hex.EncodeToString(sum[:12])
}

// ProCreditGrantID is a purchase's month grant id.
func ProCreditGrantID(keyHash string, month int) string {
	return fmt.Sprintf("%s_m%03d", keyHash, month)
}

// ClaimProCreditGrant claims g for g.UID: a new month is created granting;
// one already claimed by g.UID answers it (a retry resumes); one held by
// another account is ErrProCreditTaken.
func (s *Store) ClaimProCreditGrant(ctx context.Context, g *ProCreditGrant) (*ProCreditGrant, error) {
	ref := s.fs.Collection(proCreditGrantsCol(s.env)).Doc(g.ID)
	var out *ProCreditGrant
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(ref)
		if err == nil {
			var cur ProCreditGrant
			if err := snap.DataTo(&cur); err != nil {
				return err
			}
			cur.ID = ref.ID
			out = &cur
			if cur.UID != g.UID {
				return ErrProCreditTaken
			}
			return nil
		}
		if status.Code(err) != codes.NotFound {
			return err
		}
		g.State = ProCreditGranting
		out = g
		return tx.Create(ref, g)
	})
	return out, err
}

// GetProCreditGrant reads one grant (ErrNotFound when there is none).
func (s *Store) GetProCreditGrant(ctx context.Context, id string) (*ProCreditGrant, error) {
	snap, err := s.fs.Collection(proCreditGrantsCol(s.env)).Doc(id).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var g ProCreditGrant
	if err := snap.DataTo(&g); err != nil {
		return nil, err
	}
	g.ID = snap.Ref.ID
	return &g, nil
}

// MarkProCreditGrant sets a grant's state (granted; removed with the cents
// taken back).
func (s *Store) MarkProCreditGrant(ctx context.Context, id, state string, removedCents int64, at time.Time) error {
	ups := []firestore.Update{{Path: "state", Value: state}}
	if state == ProCreditRemoved {
		ups = append(ups, firestore.Update{Path: "removed_at", Value: at}, firestore.Update{Path: "removed_cents", Value: removedCents})
	}
	_, err := s.fs.Collection(proCreditGrantsCol(s.env)).Doc(id).Update(ctx, ups)
	return err
}

// ListProCreditGrants is an account's grants, newest first (at most limit).
func (s *Store) ListProCreditGrants(ctx context.Context, uid string, limit int) ([]*ProCreditGrant, error) {
	snaps, err := s.fs.Collection(proCreditGrantsCol(s.env)).Where("uid", "==", uid).Limit(200).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]*ProCreditGrant, 0, len(snaps))
	for _, sn := range snaps {
		var g ProCreditGrant
		if sn.DataTo(&g) == nil {
			g.ID = sn.Ref.ID
			out = append(out, &g)
		}
	}
	for i := 1; i < len(out); i++ {
		for j := i; j > 0 && out[j].PeriodStart.After(out[j-1].PeriodStart); j-- {
			out[j], out[j-1] = out[j-1], out[j]
		}
	}
	if len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

// SetProCreditHolder records when to look at uid again.
func (s *Store) SetProCreditHolder(ctx context.Context, uid, kind string, next time.Time) error {
	_, err := s.fs.Collection(proCreditHoldersCol(s.env)).Doc(uid).Set(ctx, &ProCreditHolder{NextCheckAt: next, Kind: kind, UpdatedAt: time.Now().UTC()})
	return err
}

// DropProCreditHolder forgets uid (no paid Pro any more).
func (s *Store) DropProCreditHolder(ctx context.Context, uid string) error {
	_, err := s.fs.Collection(proCreditHoldersCol(s.env)).Doc(uid).Delete(ctx)
	return err
}

// DueProCreditHolders are the accounts to look at by now.
func (s *Store) DueProCreditHolders(ctx context.Context, now time.Time, limit int) ([]string, error) {
	snaps, err := s.fs.Collection(proCreditHoldersCol(s.env)).Where("next_check_at", "<=", now).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(snaps))
	for _, sn := range snaps {
		out = append(out, sn.Ref.ID)
	}
	return out, nil
}

// NoteProRefund counts a refunded purchase once on the account (PRO-07)
// and flags it from the second; it answers whether it was new.
func (s *Store) NoteProRefund(ctx context.Context, uid, keyHash string) (bool, *Customer, error) {
	isNew := false
	c, err := s.UpdateCustomer(ctx, uid, func(c *Customer) error {
		for _, k := range c.ProRefundedKeys {
			if k == keyHash {
				return nil
			}
		}
		isNew = true
		c.ProRefundedKeys = append(c.ProRefundedKeys, keyHash)
		c.ProRefunds++
		c.ProRefundFlag = c.ProRefunds >= 2
		return nil
	})
	return isNew, c, err
}

// ProCreditOnceID is the one-time grant's id for a purchase: one per
// original transaction, whichever account holds it.
func ProCreditOnceID(keyHash string) string { return "once_" + keyHash }

// IsProCreditOnce: a grant made by the one-time rule.
func IsProCreditOnce(id string) bool { return strings.HasPrefix(id, "once_") }
