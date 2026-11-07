package identity

import (
	"context"
	"net/url"
)

// OpLinkIdP links an Apple or Google sign-in onto a signed-in account.
const OpLinkIdP Op = "link_idp"

// LinkResult is a link's answer: the account the provider now signs into
// (the caller's when the link held) and fresh tokens for it.
type LinkResult struct {
	Session Session
	// NeedConfirmation: the provider's email belongs to another account
	// (one account per email), so Firebase linked nothing.
	NeedConfirmation bool
	Email            string
}

// ErrorCode is an error carrying Firebase's code (Code reads it back): for
// fakes of this client in other packages' tests.
func ErrorCode(op Op, code string) error { return &firebaseError{op: op, status: 400, code: code} }

// LinkWithIdP is signInWithIdp with the caller's ID token: Firebase links
// the provider's credential (an Apple or Google ID token, the raw nonce
// when the token carries one) onto that user, keeping its uid (an
// anonymous user stays the same uid). Errors keep Firebase's code (Code):
// FEDERATED_USER_ID_ALREADY_LINKED when another account holds the
// credential, EMAIL_EXISTS when its email does.
func (c *Client) LinkWithIdP(ctx context.Context, callerIDToken, providerID, idpToken, nonce string) (*LinkResult, error) {
	post := url.Values{"id_token": {idpToken}, "providerId": {providerID}}
	if nonce != "" {
		post.Set("nonce", nonce)
	}
	body, err := c.postJSON(ctx, OpLinkIdP, "accounts:signInWithIdp", map[string]any{
		"idToken": callerIDToken, "postBody": post.Encode(), "requestUri": "http://localhost",
		"returnSecureToken": true, "returnIdpCredential": true,
	})
	if err != nil {
		return nil, err
	}
	res := &LinkResult{Session: Session{UID: str(body["localId"]), Email: str(body["email"]),
		IDToken: str(body["idToken"]), RefreshToken: str(body["refreshToken"]), ExpiresIn: seconds(body["expiresIn"])},
		Email: str(body["email"])}
	if b, _ := body["needConfirmation"].(bool); b {
		res.NeedConfirmation = true
		return res, nil
	}
	if code := str(body["errorMessage"]); code != "" { // returnIdpCredential answers some refusals in the body
		return res, &firebaseError{op: OpLinkIdP, status: 400, code: code}
	}
	if res.Session.UID == "" {
		return nil, errIncomplete(OpLinkIdP)
	}
	return res, nil
}
