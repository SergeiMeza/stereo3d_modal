package store

import (
	"context"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Customer passkeys (ADR 0136): customer_passkeys_{env}/{credId} and
// customer_passkey_challenges_{env}/{challenge} (a sign-in challenge has
// no uid: sign-in is usernameless), apart from the admins' store.

func (s *Store) CreateCustomerPasskey(ctx context.Context, p *Passkey) error {
	_, err := s.kindCol(PasskeysCustomer).Doc(p.ID).Create(ctx, p)
	if status.Code(err) == codes.AlreadyExists {
		return ErrAlreadyExists
	}
	return err
}

func passkeysOf(snaps []*firestore.DocumentSnapshot) []*Passkey {
	out := make([]*Passkey, 0, len(snaps))
	for _, sn := range snaps {
		var p Passkey
		if sn.DataTo(&p) == nil {
			p.ID = sn.Ref.ID
			out = append(out, &p)
		}
	}
	return out
}

func (s *Store) ListCustomerPasskeys(ctx context.Context, uid string) ([]*Passkey, error) {
	snaps, err := s.kindCol(PasskeysCustomer).Where("uid", "==", uid).Limit(100).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	return passkeysOf(snaps), nil
}

// ListAllCustomerPasskeys: every customer passkey, for adoption counts.
func (s *Store) ListAllCustomerPasskeys(ctx context.Context, limit int) ([]*Passkey, error) {
	snaps, err := s.kindCol(PasskeysCustomer).Limit(limit).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	return passkeysOf(snaps), nil
}

func (s *Store) GetCustomerPasskey(ctx context.Context, id string) (*Passkey, error) {
	if id == "" || len(id) > 1400 {
		return nil, ErrNotFound
	}
	snap, err := s.kindCol(PasskeysCustomer).Doc(id).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	var p Passkey
	if err := snap.DataTo(&p); err != nil {
		return nil, err
	}
	p.ID = id
	return &p, nil
}

// UseCustomerPasskey records a sign-in when the stored count is still prev.
func (s *Store) UseCustomerPasskey(ctx context.Context, id string, prev, next int64, credential string, at time.Time) error {
	doc := s.kindCol(PasskeysCustomer).Doc(id)
	return s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(doc)
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		var p Passkey
		if err := snap.DataTo(&p); err != nil {
			return err
		}
		if p.SignCount != prev {
			return ErrSignCountMoved
		}
		return tx.Update(doc, []firestore.Update{{Path: "sign_count", Value: next}, {Path: "credential", Value: credential}, {Path: "last_used_at", Value: at}})
	})
}

func (s *Store) RenameCustomerPasskey(ctx context.Context, id, name string) error {
	_, err := s.kindCol(PasskeysCustomer).Doc(id).Update(ctx, []firestore.Update{{Path: "name", Value: name}})
	return err
}

func (s *Store) DeleteCustomerPasskey(ctx context.Context, id string) error {
	_, err := s.kindCol(PasskeysCustomer).Doc(id).Delete(ctx)
	return err
}

// DeleteUserCustomerPasskeys removes every passkey of uid (account
// deletion); the count removed.
func (s *Store) DeleteUserCustomerPasskeys(ctx context.Context, uid string) (int, error) {
	ps, err := s.ListCustomerPasskeys(ctx, uid)
	if err != nil {
		return 0, err
	}
	for _, p := range ps {
		if err := s.DeleteCustomerPasskey(ctx, p.ID); err != nil {
			return 0, err
		}
	}
	return len(ps), nil
}

func (s *Store) PutCustomerPasskeyChallenge(ctx context.Context, challenge string, c *PasskeyChallenge) error {
	if snaps, err := s.kindChallenges(PasskeysCustomer).Where("uid", "==", c.UID).Limit(50).Documents(ctx).GetAll(); err == nil {
		now := time.Now()
		for _, sn := range snaps {
			if t, err := sn.DataAt("expires_at"); err == nil {
				if et, ok := t.(time.Time); ok && et.Before(now) {
					_, _ = sn.Ref.Delete(ctx)
				}
			}
		}
	}
	_, err := s.kindChallenges(PasskeysCustomer).Doc(challenge).Create(ctx, c)
	return err
}

func (s *Store) ConsumeCustomerPasskeyChallenge(ctx context.Context, challenge string) (*PasskeyChallenge, error) {
	if challenge == "" || len(challenge) > 256 {
		return nil, ErrNotFound
	}
	doc := s.kindChallenges(PasskeysCustomer).Doc(challenge)
	var out *PasskeyChallenge
	err := s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(doc)
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		var c PasskeyChallenge
		if err := snap.DataTo(&c); err != nil {
			return err
		}
		out = &c
		return tx.Delete(doc)
	})
	return out, err
}

// ListEventsByName: events of one name since t (equality on name, time
// filtered here: no composite index).
func (s *Store) ListEventsByName(ctx context.Context, name string, since time.Time, limit int) ([]Event, error) {
	snaps, err := s.fs.Collection(eventsCol(s.env)).Where("name", "==", name).Limit(limit).Documents(ctx).GetAll()
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
