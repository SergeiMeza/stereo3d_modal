package identity

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// Limiter is a fixed-window counter per key, in memory. Each Cloud Run
// instance counts on its own, so the effective ceiling is limit × instances:
// a brake on scripts, not an exact quota.
type Limiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	now    func() time.Time
	hits   map[string]*window
}

type window struct {
	start time.Time
	n     int
}

// pruneAt is the map size at which expired windows are swept.
const pruneAt = 4096

func NewLimiter(limit int, per time.Duration) *Limiter {
	return &Limiter{limit: limit, window: per, now: time.Now, hits: map[string]*window{}}
}

// Allow counts one request for key. When the window is full it says no and
// how long until the window resets.
func (l *Limiter) Allow(key string) (bool, time.Duration) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	if len(l.hits) >= pruneAt {
		for k, w := range l.hits {
			if now.Sub(w.start) >= l.window {
				delete(l.hits, k)
			}
		}
	}
	w, ok := l.hits[key]
	if !ok || now.Sub(w.start) >= l.window {
		l.hits[key] = &window{start: now, n: 1}
		return true, 0
	}
	if w.n >= l.limit {
		return false, w.start.Add(l.window).Sub(now)
	}
	w.n++
	return true, 0
}

// ---------------------------------------------------------------- caller IP

// Defaults: the global load balancer in front of api.stereo3d.studio and
// the shared relay that serves cn.api.stereo3d.studio.
const (
	DefaultLBIPs    = "34.117.11.37"
	DefaultRelayIPs = "101.47.76.86"
)

// IPPolicy says which caller address to trust (Spatial Video Studio's
// geo.ts rules):
//   - through the relay, then the load balancer: X-Forwarded-For is
//     "<caller>, <relay>, <lb>" and the relay also sends X-Client-IP.
//     Trusted only when the hop that connected to the load balancer is the
//     relay's own address, so a client can't claim to be the relay;
//   - through the load balancer: the caller is the hop before the LB;
//   - straight to run.app: Google's front end appends the caller last.
type IPPolicy struct {
	LBIPs    map[string]bool
	RelayIPs map[string]bool
}

// NewIPPolicy takes comma-separated address lists; empty means the default.
func NewIPPolicy(lbIPs, relayIPs string) IPPolicy {
	set := func(list, fallback string) map[string]bool {
		if strings.TrimSpace(list) == "" {
			list = fallback
		}
		m := map[string]bool{}
		for _, s := range strings.Split(list, ",") {
			if s = strings.TrimSpace(s); s != "" {
				m[s] = true
			}
		}
		return m
	}
	return IPPolicy{LBIPs: set(lbIPs, DefaultLBIPs), RelayIPs: set(relayIPs, DefaultRelayIPs)}
}

// ClientIP is the address to key the rate limit on, and whether the request
// came through the relay.
func (p IPPolicy) ClientIP(r *http.Request) (ip string, viaRelay bool) {
	var chain []string
	for _, h := range strings.Split(r.Header.Get("X-Forwarded-For"), ",") {
		if h = strings.TrimSpace(h); net.ParseIP(h) != nil {
			chain = append(chain, h)
		}
	}
	if len(chain) == 0 {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			host = r.RemoteAddr
		}
		return host, false
	}
	connecting := len(chain) - 1
	if p.LBIPs[chain[connecting]] {
		connecting--
	}
	if connecting < 0 {
		return chain[0], false
	}
	if p.RelayIPs[chain[connecting]] {
		if claimed := strings.TrimSpace(r.Header.Get("X-Client-IP")); net.ParseIP(claimed) != nil {
			return claimed, true
		}
		if connecting > 0 {
			return chain[connecting-1], true
		}
		return chain[connecting], true
	}
	return chain[connecting], false
}
