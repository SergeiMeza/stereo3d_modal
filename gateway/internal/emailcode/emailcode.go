// Package emailcode signs people in with a one-time 6-digit code sent to
// their email (S3D-70): no password, no link.
//
//   - POST /v1/auth/email/start {email} mails a code. It lasts 10 minutes and
//     takes 5 wrong tries; a new code needs 30 s since the last one, and an
//     address gets at most 5 codes an hour. The answer never says whether an
//     account exists.
//   - POST /v1/auth/email/verify {email, code[, session]} checks it and signs
//     the person into the account with that email, creating it when there is
//     none. One account per email (S3D-69): an address that already signs in
//     with Google or Apple lands on that same account. The answer is a
//     Firebase custom token for the JS SDK, or with session:true (China mode,
//     no SDK) the ID and refresh tokens the identity package hands out.
//
// Codes are stored hashed (salted SHA-256) in Firestore, keyed by a hash of
// the address, so they hold across Cloud Run instances. Codes, tokens and
// addresses are never logged.
package emailcode

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/auth"
	"spatial-ai-labs/stereo3d-gateway/internal/identity"
	"spatial-ai-labs/stereo3d-gateway/internal/mail"
)

const (
	CodeDigits      = 6
	CodeTTL         = 10 * time.Minute
	MaxAttempts     = 5
	ResendGap       = 30 * time.Second
	SendsPerWindow  = 5
	SendWindow      = time.Hour
	maxEmailLength  = 320
	saltBytes       = 16
	recordKeyPrefix = "email:"
)

// Record is one address's code state.
type Record struct {
	CodeHash  string    `firestore:"code_hash"` // "" when no code is live
	Salt      string    `firestore:"salt"`
	ExpiresAt time.Time `firestore:"expires_at"`
	Attempts  int       `firestore:"attempts"`
	SentAt    time.Time `firestore:"sent_at"`
	// The send window: codes sent since WindowStart.
	WindowStart time.Time `firestore:"window_start"`
	WindowSends int       `firestore:"window_sends"`
	// DeleteAfter is for a Firestore TTL policy (optional).
	DeleteAfter time.Time `firestore:"delete_after"`
}

// Store keeps Records. Update runs fn on the current record (nil when
// there is none) atomically and saves what fn returns; fn's error aborts
// without saving.
type Store interface {
	Update(ctx context.Context, key string, fn func(*Record) (*Record, error)) error
}

// Users finds or creates the account for an address (auth.Verifier).
type Users interface {
	EnsureEmailUser(ctx context.Context, email string) (uid string, created bool, err error)
	CustomToken(ctx context.Context, uid string) (string, error)
}

// Sessions trades a custom token for ID/refresh tokens (identity.Client).
type Sessions interface {
	Configured() bool
	SignInWithCustomToken(ctx context.Context, token string) (*identity.Session, error)
}

// Mailer sends one email (mail.Resend).
type Mailer interface {
	Configured() bool
	Send(ctx context.Context, m mail.Message) error
}

// Service runs the code flow.
type Service struct {
	Store    Store
	Users    Users
	Sessions Sessions
	Mail     Mailer
	Now      func() time.Time
	// NewCode makes a code (tests pin it); default crypto/rand.
	NewCode func() (string, error)
}

func (s *Service) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Service) configured() bool {
	return s != nil && s.Store != nil && s.Users != nil && s.Mail != nil && s.Mail.Configured()
}

// Errors the handlers map to the API's codes.
var (
	ErrInvalidEmail = errors.New("invalid email")
	ErrNoCode       = errors.New("no live code")
	ErrDisabled     = errors.New("account disabled")
	ErrUnavailable  = errors.New("unavailable")
)

// WaitError: not now; try again after Wait (resend gap or hourly cap).
type WaitError struct {
	Reason string // "resend_too_soon" | "too_many_codes"
	Wait   time.Duration
}

func (e *WaitError) Error() string { return fmt.Sprintf("%s: wait %s", e.Reason, e.Wait) }

// WrongCodeError: the code didn't match; AttemptsLeft more tries (0: the
// code is spent and a new one is needed).
type WrongCodeError struct{ AttemptsLeft int }

func (e *WrongCodeError) Error() string { return fmt.Sprintf("wrong code, %d left", e.AttemptsLeft) }

// NormalizeEmail trims and lower-cases an address and checks its shape.
func NormalizeEmail(raw string) (string, error) {
	e := strings.ToLower(strings.TrimSpace(raw))
	at := strings.IndexByte(e, '@')
	if len(e) > maxEmailLength || at <= 0 || at >= len(e)-1 || strings.ContainsAny(e, " \t\r\n,;<>\"") ||
		!strings.Contains(e[at+1:], ".") || strings.Count(e, "@") != 1 {
		return "", ErrInvalidEmail
	}
	return e, nil
}

// Key is the Firestore document id for an address (its hash, so ids don't
// carry addresses).
func Key(email string) string {
	sum := sha256.Sum256([]byte(recordKeyPrefix + email))
	return hex.EncodeToString(sum[:])
}

func hashCode(salt, email, code string) string {
	sum := sha256.Sum256([]byte(salt + "\x00" + email + "\x00" + code))
	return hex.EncodeToString(sum[:])
}

// RandomCode is a uniform 6-digit code from crypto/rand.
func RandomCode() (string, error) {
	const limit = 1_000_000
	// Reject the top of the uint32 range so every code is equally likely.
	const ceiling = (1 << 32) / limit * limit
	var b [4]byte
	for {
		if _, err := rand.Read(b[:]); err != nil {
			return "", err
		}
		if n := binary.BigEndian.Uint32(b[:]); n < ceiling {
			return fmt.Sprintf("%06d", n%limit), nil
		}
	}
}

func randomSalt() (string, error) {
	b := make([]byte, saltBytes)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// Start mails a fresh code to email (already normalized). It answers how
// long until another code may be asked for.
func (s *Service) Start(ctx context.Context, email string) (time.Duration, error) {
	if !s.configured() {
		return 0, ErrUnavailable
	}
	newCode := s.NewCode
	if newCode == nil {
		newCode = RandomCode
	}
	code, err := newCode()
	if err != nil {
		return 0, err
	}
	salt, err := randomSalt()
	if err != nil {
		return 0, err
	}
	now := s.now()
	err = s.Store.Update(ctx, Key(email), func(r *Record) (*Record, error) {
		next := Record{WindowStart: now}
		if r != nil {
			if wait := r.SentAt.Add(ResendGap).Sub(now); wait > 0 {
				return nil, &WaitError{Reason: "resend_too_soon", Wait: wait}
			}
			if now.Sub(r.WindowStart) < SendWindow {
				next.WindowStart, next.WindowSends = r.WindowStart, r.WindowSends
			}
		}
		if next.WindowSends >= SendsPerWindow {
			return nil, &WaitError{Reason: "too_many_codes", Wait: next.WindowStart.Add(SendWindow).Sub(now)}
		}
		next.WindowSends++
		next.CodeHash = hashCode(salt, email, code)
		next.Salt = salt
		next.ExpiresAt = now.Add(CodeTTL)
		next.SentAt = now
		next.DeleteAfter = now.Add(SendWindow + CodeTTL)
		return &next, nil
	})
	if err != nil {
		return 0, err
	}
	if err := s.Mail.Send(ctx, mail.SignInCode(email, code)); err != nil {
		return 0, fmt.Errorf("%w: mail: %v", ErrUnavailable, err)
	}
	return ResendGap, nil
}

// Result is a successful verify.
type Result struct {
	UID         string
	IsNewUser   bool
	CustomToken string
	// Session is set when asked for (China mode).
	Session *identity.Session
}

// Verify checks code for email (normalized) and signs the person in.
func (s *Service) Verify(ctx context.Context, email, code string, wantSession bool) (*Result, error) {
	if !s.configured() {
		return nil, ErrUnavailable
	}
	code = strings.TrimSpace(code)
	if len(code) != CodeDigits || strings.Trim(code, "0123456789") != "" {
		// Malformed input doesn't spend an attempt: it never reached the hash.
		return nil, &WrongCodeError{AttemptsLeft: -1}
	}
	now := s.now()
	var outcome error
	err := s.Store.Update(ctx, Key(email), func(r *Record) (*Record, error) {
		if r == nil || r.CodeHash == "" {
			return nil, ErrNoCode
		}
		next := *r
		if !now.Before(r.ExpiresAt) || r.Attempts >= MaxAttempts {
			next.CodeHash, next.Salt = "", ""
			outcome = ErrNoCode
			return &next, nil
		}
		if subtle.ConstantTimeCompare([]byte(hashCode(r.Salt, email, code)), []byte(r.CodeHash)) != 1 {
			next.Attempts++
			left := MaxAttempts - next.Attempts
			if left <= 0 {
				next.CodeHash, next.Salt = "", ""
				left = 0
			}
			outcome = &WrongCodeError{AttemptsLeft: left}
			return &next, nil
		}
		// Used: a code signs in once.
		next.CodeHash, next.Salt, next.Attempts = "", "", 0
		return &next, nil
	})
	if err != nil {
		return nil, err
	}
	if outcome != nil {
		return nil, outcome
	}

	uid, created, err := s.Users.EnsureEmailUser(ctx, email)
	if err != nil {
		if errors.Is(err, auth.ErrUserDisabled) {
			return nil, ErrDisabled
		}
		return nil, fmt.Errorf("%w: account: %v", ErrUnavailable, err)
	}
	token, err := s.Users.CustomToken(ctx, uid)
	if err != nil {
		return nil, fmt.Errorf("%w: custom token: %v", ErrUnavailable, err)
	}
	res := &Result{UID: uid, IsNewUser: created, CustomToken: token}
	if wantSession {
		if s.Sessions == nil || !s.Sessions.Configured() {
			return nil, ErrUnavailable
		}
		sess, err := s.Sessions.SignInWithCustomToken(ctx, token)
		if err != nil {
			return nil, fmt.Errorf("%w: session: %v", ErrUnavailable, err)
		}
		res.Session = sess
		res.CustomToken = ""
	}
	return res, nil
}
