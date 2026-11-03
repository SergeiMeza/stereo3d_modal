package identity

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
)

// OpCustomToken trades a custom token (minted by the gateway after an
// email code, emailcode package) for the ID and refresh tokens.
const OpCustomToken Op = "custom_token"

// SignInWithCustomToken is signInWithCustomToken, for browsers that can't
// load the SDK (China mode): the gateway makes the exchange and answers the
// Session the SDK would have held.
func (c *Client) SignInWithCustomToken(ctx context.Context, token string) (*Session, error) {
	body, err := c.postJSON(ctx, OpCustomToken, "accounts:signInWithCustomToken", map[string]any{
		"token": token, "returnSecureToken": true,
	})
	if err != nil {
		return nil, err
	}
	s := &Session{
		UID:          str(body["localId"]),
		IDToken:      str(body["idToken"]),
		RefreshToken: str(body["refreshToken"]),
		ExpiresIn:    seconds(body["expiresIn"]),
	}
	if s.IDToken == "" || s.RefreshToken == "" {
		return nil, errIncomplete(OpCustomToken)
	}
	// The answer carries no profile; the new ID token's claims do.
	s.Email, s.DisplayName = tokenClaims(s.IDToken)
	if s.UID == "" {
		s.UID = tokenSubject(s.IDToken)
	}
	if s.UID == "" {
		return nil, errIncomplete(OpCustomToken)
	}
	return s, nil
}

// tokenSubject reads the uid ("sub", or Firebase's "user_id") from a JWT
// payload without verifying it.
func tokenSubject(idToken string) string {
	claims := tokenPayload(idToken)
	if uid := str(claims["user_id"]); uid != "" {
		return uid
	}
	return str(claims["sub"])
}

// tokenPayload decodes a JWT payload without verifying it (nil if unreadable).
func tokenPayload(idToken string) map[string]any {
	parts := strings.Split(idToken, ".")
	if len(parts) != 3 {
		return nil
	}
	raw, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(parts[1], "="))
	if err != nil {
		return nil
	}
	var claims map[string]any
	if json.Unmarshal(raw, &claims) != nil {
		return nil
	}
	return claims
}
