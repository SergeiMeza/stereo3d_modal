package httpx

import (
	"context"
	"crypto/subtle"
	"log/slog"
	"net"
	"net/http"
	"strings"
)

// The app's backend (svs-backend) calls some routes on its users' behalf
// (sign-in, linked sign-in methods, passkeys). Every such call would come
// from svs-backend's own address, so rate limits keyed on the address
// would put all app users in one bucket. svs-backend says whose request it
// is in X-SVS-Client-IP (and X-SVS-Client-Via: relay for a China request),
// trusted only with X-SVS-Proxy-Key equal to the shared secret
// (svs-gateway-proxy-key-{env}). Without the key, or with a wrong one,
// both headers are dropped and the normal caller address applies.
const (
	HeaderProxyKey  = "X-SVS-Proxy-Key"
	HeaderClientIP  = "X-SVS-Client-IP"
	HeaderClientVia = "X-SVS-Client-Via"
)

type trustedIPKey struct{}

type proxyAuthKey struct{}

// ProxyAuthenticated: the request carried svs-backend's proxy key (with
// or without a client address), for its server-to-server routes.
func ProxyAuthenticated(ctx context.Context) bool {
	ok, _ := ctx.Value(proxyAuthKey{}).(bool)
	return ok
}

type trustedIP struct {
	ip    string
	relay bool
}

// TrustedClientIP is the caller address svs-backend vouched for, and
// whether that caller came through the China relay.
func TrustedClientIP(ctx context.Context) (ip string, viaRelay bool, ok bool) {
	t, ok := ctx.Value(trustedIPKey{}).(trustedIP)
	if !ok {
		return "", false, false
	}
	return t.ip, t.relay, true
}

// WithTrustedProxy applies the rule above (key "" trusts nobody).
func WithTrustedProxy(key string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		given := r.Header.Get(HeaderProxyKey)
		ip := strings.TrimSpace(r.Header.Get(HeaderClientIP))
		via := strings.TrimSpace(r.Header.Get(HeaderClientVia))
		r.Header.Del(HeaderProxyKey)
		r.Header.Del(HeaderClientIP)
		r.Header.Del(HeaderClientVia)
		if given != "" {
			switch {
			case key == "" || subtle.ConstantTimeCompare([]byte(given), []byte(key)) != 1:
				slog.WarnContext(r.Context(), "proxy key refused: client address not trusted", "path", r.URL.Path)
			default:
				r = r.WithContext(context.WithValue(r.Context(), proxyAuthKey{}, true))
				if net.ParseIP(ip) != nil {
					r = r.WithContext(context.WithValue(r.Context(), trustedIPKey{}, trustedIP{ip: ip, relay: via == "relay"}))
				} else if ip != "" {
					slog.WarnContext(r.Context(), "proxy client address unreadable", "path", r.URL.Path)
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}
