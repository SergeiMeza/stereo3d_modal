package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"

	fbauth "firebase.google.com/go/v4/auth"
)

// ErrUserDisabled: the account with that email is disabled.
var ErrUserDisabled = errors.New("user disabled")

// EnsureEmailUser answers the uid of the account with email, creating it
// (email verified, no password) when there is none (S3D-70). The caller has
// just proved the person owns the address with a one-time code, so:
//   - the email is marked verified;
//   - an unverified account that has a password loses that password and its
//     sessions: whoever set it never proved the address, and the owner signs
//     in with codes from now on (Firebase does the same when Google signs in
//     over an unverified password account).
//
// One account per email is the project's setting, so the lookup is exact.
func (v *Verifier) EnsureEmailUser(ctx context.Context, email string) (uid string, created bool, err error) {
	u, err := v.client.GetUserByEmail(ctx, email)
	if err == nil {
		return v.adopt(ctx, u)
	}
	if !fbauth.IsUserNotFound(err) {
		return "", false, err
	}
	rec, err := v.client.CreateUser(ctx, (&fbauth.UserToCreate{}).Email(email).EmailVerified(true))
	if fbauth.IsEmailAlreadyExists(err) {
		// Created by a parallel request (a double tap): use that one.
		if u, err = v.client.GetUserByEmail(ctx, email); err == nil {
			return v.adopt(ctx, u)
		}
	}
	if err != nil {
		return "", false, err
	}
	return rec.UID, true, nil
}

func (v *Verifier) adopt(ctx context.Context, u *fbauth.UserRecord) (string, bool, error) {
	if u.Disabled {
		return "", false, ErrUserDisabled
	}
	if u.EmailVerified {
		return u.UID, false, nil
	}
	hasPassword := false
	for _, p := range u.ProviderUserInfo {
		if p != nil && p.ProviderID == "password" {
			hasPassword = true
		}
	}
	upd := (&fbauth.UserToUpdate{}).EmailVerified(true)
	if !hasPassword {
		if _, err := v.client.UpdateUser(ctx, u.UID, upd); err != nil {
			return "", false, err
		}
		return u.UID, false, nil
	}
	if _, err := v.client.UpdateUser(ctx, u.UID, upd.ProvidersToDelete([]string{"password"})); err != nil {
		// Unlinking refused: replace the unproven password instead.
		slog.WarnContext(ctx, "email code: password unlink refused, replacing it", "uid", u.UID, "err", err)
		if _, err := v.client.UpdateUser(ctx, u.UID, (&fbauth.UserToUpdate{}).EmailVerified(true).Password(randomPassword())); err != nil {
			return "", false, err
		}
	}
	if err := v.client.RevokeRefreshTokens(ctx, u.UID); err != nil {
		return "", false, err
	}
	return u.UID, false, nil
}

// CustomToken mints a Firebase custom token for uid (the browser signs in
// with it). Signing goes through IAM signBlob with the service account
// (iam.serviceAccountTokenCreator on itself, deploy.sh).
func (v *Verifier) CustomToken(ctx context.Context, uid string) (string, error) {
	return v.client.CustomToken(ctx, uid)
}

func randomPassword() string {
	b := make([]byte, 32)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
