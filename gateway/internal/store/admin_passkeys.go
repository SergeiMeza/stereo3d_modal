package store

import (
	"context"
	"errors"
	"time"

	"cloud.google.com/go/firestore"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Admin passkeys (ADR 0135): the admin console's second factor.
// admin_passkeys_{env}/{credId} holds each WebAuthn credential;
// admin_passkey_challenges_{env}/{challenge} the single-use ceremony
// challenges (5 minutes, bound to the uid and the purpose);
// admin_session_epochs_{env}/{uid} the session epoch a break-glass reset
// bumps to revoke every session of that uid.

// AdminPasskey is one admin's WebAuthn credential.
type AdminPasskey struct {
	ID         string     `firestore:"-" json:"id"` // the credential id, base64url
	UID        string     `firestore:"uid" json:"-"`
	Name       string     `firestore:"name" json:"name"`
	PublicKey  []byte     `firestore:"public_key" json:"-"`
	SignCount  int64      `firestore:"sign_count" json:"-"`
	AAGUID     string     `firestore:"aaguid,omitempty" json:"-"`
	Transports []string   `firestore:"transports,omitempty" json:"-"`
	RPID       string     `firestore:"rp_id" json:"-"`
	CreatedAt  time.Time  `firestore:"created_at" json:"created_at"`
	LastUsedAt *time.Time `firestore:"last_used_at,omitempty" json:"last_used_at"`
	// Credential: the library's whole credential record (flags, the
	// attestation format) as JSON, for the next assertion's checks.
	Credential string `firestore:"credential" json:"-"`
	// DeviceHint: customers' passkeys (ADR 0136) name where it lives
	// (the authenticator by AAGUID, else the browser and system).
	DeviceHint string `firestore:"device_hint,omitempty" json:"device_hint,omitempty"`
}

// Passkey is the record both stores keep (admin: ADR 0135; customers:
// ADR 0136, customer_passkeys_{env}).
type Passkey = AdminPasskey

// PasskeyKind picks a store: admin passkeys or customer passkeys.
type PasskeyKind string

const (
	PasskeysAdmin    PasskeyKind = "admin"
	PasskeysCustomer PasskeyKind = "customer"
)

// PasskeyChallenge is one pending ceremony.
type PasskeyChallenge struct {
	UID       string    `firestore:"uid"`
	Purpose   string    `firestore:"purpose"` // register | session
	RPID      string    `firestore:"rp_id"`
	Origin    string    `firestore:"origin"`
	Session   string    `firestore:"session"` // webauthn.SessionData as JSON
	Name      string    `firestore:"name,omitempty"`
	ExpiresAt time.Time `firestore:"expires_at"`
}

// ErrSignCountMoved: the passkey was used meanwhile (a concurrent or
// replayed assertion).
var ErrSignCountMoved = errors.New("passkey sign count moved")

func passkeyCol(s *Store) *firestore.CollectionRef   { return s.kindCol(PasskeysAdmin) }
func challengeCol(s *Store) *firestore.CollectionRef { return s.kindChallenges(PasskeysAdmin) }

func (s *Store) kindCol(k PasskeyKind) *firestore.CollectionRef {
	return s.fs.Collection(string(k) + "_passkeys_" + s.env)
}

func (s *Store) kindChallenges(k PasskeyKind) *firestore.CollectionRef {
	return s.fs.Collection(string(k) + "_passkey_challenges_" + s.env)
}
func epochDoc(s *Store, uid string) *firestore.DocumentRef {
	return s.fs.Collection("admin_session_epochs_" + s.env).Doc(uid)
}

func (s *Store) CreateAdminPasskey(ctx context.Context, p *AdminPasskey) error {
	_, err := passkeyCol(s).Doc(p.ID).Create(ctx, p)
	if status.Code(err) == codes.AlreadyExists {
		return ErrAlreadyExists
	}
	return err
}

func (s *Store) ListAdminPasskeys(ctx context.Context, uid string) ([]*AdminPasskey, error) {
	snaps, err := passkeyCol(s).Where("uid", "==", uid).Limit(100).Documents(ctx).GetAll()
	if err != nil {
		return nil, err
	}
	out := make([]*AdminPasskey, 0, len(snaps))
	for _, sn := range snaps {
		var p AdminPasskey
		if sn.DataTo(&p) == nil {
			p.ID = sn.Ref.ID
			out = append(out, &p)
		}
	}
	return out, nil
}

// UseAdminPasskey records an assertion: the new sign count and the
// credential record, only if the stored count is still prev.
func (s *Store) UseAdminPasskey(ctx context.Context, id string, prev, next int64, credential string, at time.Time) error {
	doc := passkeyCol(s).Doc(id)
	return s.fs.RunTransaction(ctx, func(ctx context.Context, tx *firestore.Transaction) error {
		snap, err := tx.Get(doc)
		if status.Code(err) == codes.NotFound {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		var p AdminPasskey
		if err := snap.DataTo(&p); err != nil {
			return err
		}
		if p.SignCount != prev {
			return ErrSignCountMoved
		}
		return tx.Update(doc, []firestore.Update{{Path: "sign_count", Value: next}, {Path: "credential", Value: credential}, {Path: "last_used_at", Value: at}})
	})
}

func (s *Store) DeleteAdminPasskey(ctx context.Context, id string) error {
	_, err := passkeyCol(s).Doc(id).Delete(ctx)
	return err
}

// PutPasskeyChallenge stores a challenge and drops the uid's expired ones.
func (s *Store) PutPasskeyChallenge(ctx context.Context, challenge string, c *PasskeyChallenge) error {
	if snaps, err := challengeCol(s).Where("uid", "==", c.UID).Limit(50).Documents(ctx).GetAll(); err == nil {
		now := time.Now()
		for _, sn := range snaps {
			if t, err := sn.DataAt("expires_at"); err == nil {
				if et, ok := t.(time.Time); ok && et.Before(now) {
					_, _ = sn.Ref.Delete(ctx)
				}
			}
		}
	}
	_, err := challengeCol(s).Doc(challenge).Create(ctx, c)
	return err
}

// ConsumePasskeyChallenge takes a challenge once: it is deleted whatever
// the caller then decides.
func (s *Store) ConsumePasskeyChallenge(ctx context.Context, challenge string) (*PasskeyChallenge, error) {
	if challenge == "" || len(challenge) > 256 {
		return nil, ErrNotFound
	}
	doc := challengeCol(s).Doc(challenge)
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

// SessionEpoch is the uid's session epoch (0 when never bumped).
func (s *Store) SessionEpoch(ctx context.Context, uid string) (int64, error) {
	snap, err := epochDoc(s, uid).Get(ctx)
	if status.Code(err) == codes.NotFound {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	v, _ := snap.DataAt("epoch")
	n, _ := v.(int64)
	return n, nil
}

// BumpSessionEpoch revokes every session of uid.
func (s *Store) BumpSessionEpoch(ctx context.Context, uid string) error {
	_, err := epochDoc(s, uid).Set(ctx, map[string]any{"epoch": firestore.Increment(1), "updated_at": time.Now().UTC()}, firestore.MergeAll)
	return err
}
