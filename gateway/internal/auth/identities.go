package auth

import (
	"context"
	"time"

	fbauth "firebase.google.com/go/v4/auth"
	"google.golang.org/api/iterator"
)

// Identity is how an account signs in: its provider ids (apple.com,
// google.com, password, …) and its email.
type Identity struct {
	UID           string
	Email         string
	EmailVerified bool
	Providers     []string
	Disabled      bool
	// Subjects: each linked provider's own user id (apple.com → Apple's
	// sub), for Restore Purchases' match (RP-04). Never shown or logged.
	Subjects map[string]string
	// LastSignIn: the latest sign-in or token refresh (zero when unknown).
	LastSignIn time.Time
	// CreatedAt: the account's creation; DisplayName its profile name.
	CreatedAt   time.Time
	DisplayName string
}

func identityOf(u *fbauth.UserRecord) *Identity {
	id := &Identity{UID: u.UID, Email: u.Email, EmailVerified: u.EmailVerified, Disabled: u.Disabled}
	if u.UserInfo != nil {
		id.DisplayName = u.DisplayName
	}
	if m := u.UserMetadata; m != nil {
		if m.CreationTimestamp > 0 {
			id.CreatedAt = time.UnixMilli(m.CreationTimestamp).UTC()
		}
		if ms := max(m.LastLogInTimestamp, m.LastRefreshTimestamp); ms > 0 {
			id.LastSignIn = time.UnixMilli(ms).UTC()
		}
	}
	for _, p := range u.ProviderUserInfo {
		if p != nil && p.ProviderID != "" {
			id.Providers = append(id.Providers, p.ProviderID)
			if p.UID != "" {
				if id.Subjects == nil {
					id.Subjects = map[string]string{}
				}
				id.Subjects[p.ProviderID] = p.UID
			}
		}
	}
	return id
}

// IdentityOf reads uid's sign-in methods.
func (v *Verifier) IdentityOf(ctx context.Context, uid string) (*Identity, error) {
	u, err := v.client.GetUser(ctx, uid)
	if err != nil {
		return nil, err
	}
	return identityOf(u), nil
}

// IdentityByEmail is the account with that email (nil, nil when none).
func (v *Verifier) IdentityByEmail(ctx context.Context, email string) (*Identity, error) {
	u, err := v.client.GetUserByEmail(ctx, email)
	if fbauth.IsUserNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return identityOf(u), nil
}

// IdentityByProvider is the account holding a provider's user id (nil,
// nil when none).
func (v *Verifier) IdentityByProvider(ctx context.Context, providerID, providerUID string) (*Identity, error) {
	u, err := v.client.GetUserByProviderUID(ctx, providerID, providerUID)
	if fbauth.IsUserNotFound(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return identityOf(u), nil
}

// SetVerifiedEmail puts email on uid, verified (an email code proved it).
func (v *Verifier) SetVerifiedEmail(ctx context.Context, uid, email string) error {
	_, err := v.client.UpdateUser(ctx, uid, (&fbauth.UserToUpdate{}).Email(email).EmailVerified(true))
	return err
}

// RemoveProviders unlinks provider ids from uid.
func (v *Verifier) RemoveProviders(ctx context.Context, uid string, providers []string) error {
	_, err := v.client.UpdateUser(ctx, uid, (&fbauth.UserToUpdate{}).ProvidersToDelete(providers))
	return err
}

// IsEmailInUse: an update refused because another account has the email.
func IsEmailInUse(err error) bool { return fbauth.IsEmailAlreadyExists(err) }

// IsUserNotFound: the Firebase user is gone.
func IsUserNotFound(err error) bool { return fbauth.IsUserNotFound(err) }

// UserExists: the Firebase user is still there.
func (v *Verifier) UserExists(ctx context.Context, uid string) (bool, error) {
	_, err := v.client.GetUser(ctx, uid)
	if fbauth.IsUserNotFound(err) {
		return false, nil
	}
	return err == nil, err
}

// EachUser calls fn with every Firebase user's identity, a page at a time
// (the EM-01 backfill); fn's error stops it.
func (v *Verifier) EachUser(ctx context.Context, fn func(*Identity) error) error {
	it := v.client.Users(ctx, "")
	for {
		u, err := it.Next()
		if err == iterator.Done {
			return nil
		}
		if err != nil {
			return err
		}
		if err := fn(identityOf(u.UserRecord)); err != nil {
			return err
		}
	}
}
