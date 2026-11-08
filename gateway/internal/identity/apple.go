package identity

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
)

// OpSignInIdP signs in with an Apple ID token (BL-34 item B): China mode
// can't reach the SDK's signInWithCredential, so the gateway makes the same
// signInWithIdp call and answers the same apple.com user (same sub as the
// app and the global web, so Pro carries over).
const OpSignInIdP Op = "signin_idp"

const providerApple = "apple.com"

// IdPResult is a provider sign-in's answer.
type IdPResult struct {
	Session   Session
	IsNewUser bool
	// NeedConfirmation: the provider's email belongs to another account
	// (one account per email), so Firebase signed nobody in.
	NeedConfirmation bool
	Email            string
}

// SignInWithIdP is signInWithIdp without a caller: the provider's ID token
// (and the raw nonce whose SHA-256 it carries) signs in to, or creates, the
// account that holds it.
func (c *Client) SignInWithIdP(ctx context.Context, providerID, idpToken, nonce string) (*IdPResult, error) {
	post := url.Values{"id_token": {idpToken}, "providerId": {providerID}}
	if nonce != "" {
		post.Set("nonce", nonce)
	}
	body, err := c.postJSON(ctx, OpSignInIdP, "accounts:signInWithIdp", map[string]any{
		"postBody": post.Encode(), "requestUri": "http://localhost",
		"returnSecureToken": true, "returnIdpCredential": true,
	})
	if err != nil {
		return nil, err
	}
	res := &IdPResult{Email: str(body["email"])}
	if b, _ := body["needConfirmation"].(bool); b {
		res.NeedConfirmation = true
		return res, nil
	}
	if code := str(body["errorMessage"]); code != "" { // returnIdpCredential answers some refusals in the body
		return nil, &firebaseError{op: OpSignInIdP, status: 400, code: code}
	}
	s, err := sessionFromSignIn(body)
	if err != nil {
		return nil, errIncomplete(OpSignInIdP)
	}
	res.Session = *s
	res.IsNewUser, _ = body["isNewUser"].(bool)
	return res, nil
}

type appleAnswer struct {
	Session
	IsNewUser bool `json:"is_new_user"`
}

// Apple: POST /v1/auth/apple {id_token, nonce} → Session + is_new_user.
// 409 account_exists {details.email}: the address already has an account;
// the web confirms it with an email code, then links Apple onto it
// (/v1/account/identities/link).
func (h *Handlers) Apple(w http.ResponseWriter, r *http.Request) {
	if !h.admit(w, r, h.signIn) {
		return
	}
	var req struct {
		IDToken string `json:"id_token"`
		Nonce   string `json:"nonce"`
	}
	if !decode(w, r, &req) {
		return
	}
	req.IDToken, req.Nonce = strings.TrimSpace(req.IDToken), strings.TrimSpace(req.Nonce)
	if req.IDToken == "" || len(req.IDToken) > maxTokenLen || len(req.Nonce) > maxTokenLen {
		httpx.WriteErr(r.Context(), w, httpx.ErrInvalid("id_token is required"))
		return
	}
	res, err := h.Client.SignInWithIdP(r.Context(), providerApple, req.IDToken, req.Nonce)
	if err != nil {
		h.fail(w, r, OpSignInIdP, err)
		return
	}
	if res.NeedConfirmation {
		e := httpx.Err(http.StatusConflict, "account_exists", "this address already has an account; confirm it with an email code")
		e.Details = map[string]any{"email": res.Email}
		httpx.WriteErr(r.Context(), w, e)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteOK(w, appleAnswer{Session: res.Session, IsNewUser: res.IsNewUser})
}
