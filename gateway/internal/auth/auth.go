// Package auth verifies Firebase ID tokens (the app's existing sign-in flow,
// anonymous accounts included).
package auth

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"

	firebase "firebase.google.com/go/v4"
	fbauth "firebase.google.com/go/v4/auth"
)

type User struct {
	UID   string
	Email string // empty for anonymous users
}

type Verifier struct {
	client *fbauth.Client
}

func New(ctx context.Context, projectID string) (*Verifier, error) {
	app, err := firebase.NewApp(ctx, &firebase.Config{ProjectID: projectID})
	if err != nil {
		return nil, err
	}
	client, err := app.Auth(ctx)
	if err != nil {
		return nil, err
	}
	return &Verifier{client: client}, nil
}

// FromRequest validates the Authorization: Bearer <firebase-id-token> header.
func (v *Verifier) FromRequest(r *http.Request) (*User, error) {
	header := r.Header.Get("Authorization")
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || parts[1] == "" {
		return nil, errUnauthorized
	}
	token, err := v.client.VerifyIDToken(r.Context(), parts[1])
	if err != nil {
		return nil, errUnauthorized
	}
	user := &User{UID: token.UID}
	if email, ok := token.Claims["email"].(string); ok {
		user.Email = email
	}
	return user, nil
}

// DeleteUser removes the user's sign-in. An already-deleted user is not
// an error.
func (v *Verifier) DeleteUser(ctx context.Context, uid string) error {
	if err := v.client.DeleteUser(ctx, uid); err != nil && !fbauth.IsUserNotFound(err) {
		return err
	}
	return nil
}

// PasswordResetCode generates a password-reset code for email (the
// oobCode of the Admin SDK's reset link; the link itself is not used, so
// the project's action URL and templates stay as they are). found is false,
// with no error, when no account has that email.
func (v *Verifier) PasswordResetCode(ctx context.Context, email string) (code string, found bool, err error) {
	link, err := v.client.PasswordResetLink(ctx, email)
	if fbauth.IsUserNotFound(err) || fbauth.IsEmailNotFound(err) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	code, err = OOBCode(link)
	if err != nil {
		return "", false, err
	}
	return code, true, nil
}

// OOBCode reads the oobCode parameter of an email action link.
func OOBCode(link string) (string, error) {
	u, err := url.Parse(link)
	if err != nil {
		return "", errors.New("unreadable action link")
	}
	code := u.Query().Get("oobCode")
	if code == "" {
		return "", errors.New("action link without a code")
	}
	return code, nil
}

var errUnauthorized = errUnauthorizedType{}

type errUnauthorizedType struct{}

func (errUnauthorizedType) Error() string { return "unauthorized" }

func IsUnauthorized(err error) bool { return err == errUnauthorized }
