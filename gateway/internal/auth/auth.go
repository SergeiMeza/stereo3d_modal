// Package auth verifies Firebase ID tokens (the app's existing sign-in flow,
// anonymous accounts included).
package auth

import (
	"context"
	"net/http"
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

var errUnauthorized = errUnauthorizedType{}

type errUnauthorizedType struct{}

func (errUnauthorizedType) Error() string { return "unauthorized" }

func IsUnauthorized(err error) bool { return err == errUnauthorized }
