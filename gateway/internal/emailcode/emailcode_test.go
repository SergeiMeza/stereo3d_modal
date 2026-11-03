package emailcode

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/auth"
	"spatial-ai-labs/stereo3d-gateway/internal/identity"
	"spatial-ai-labs/stereo3d-gateway/internal/mail"
)

type fakeMail struct {
	sent []mail.Message
	err  error
}

func (f *fakeMail) Configured() bool { return true }
func (f *fakeMail) Send(_ context.Context, m mail.Message) error {
	if f.err != nil {
		return f.err
	}
	f.sent = append(f.sent, m)
	return nil
}

type fakeUsers struct {
	byEmail  map[string]string
	disabled map[string]bool
	created  int
}

func (f *fakeUsers) EnsureEmailUser(_ context.Context, email string) (string, bool, error) {
	if f.disabled[email] {
		return "", false, auth.ErrUserDisabled
	}
	if uid, ok := f.byEmail[email]; ok {
		return uid, false, nil
	}
	f.created++
	uid := "new-uid"
	f.byEmail[email] = uid
	return uid, true, nil
}

func (f *fakeUsers) CustomToken(_ context.Context, uid string) (string, error) {
	return "custom-" + uid, nil
}

type fakeSessions struct{}

func (fakeSessions) Configured() bool { return true }
func (fakeSessions) SignInWithCustomToken(_ context.Context, token string) (*identity.Session, error) {
	return &identity.Session{UID: strings.TrimPrefix(token, "custom-"), IDToken: "id", RefreshToken: "rt", ExpiresIn: 3600}, nil
}

type rig struct {
	svc   *Service
	store *MemoryStore
	mail  *fakeMail
	users *fakeUsers
	now   time.Time
	code  string
}

func newRig() *rig {
	r := &rig{
		store: NewMemoryStore(),
		mail:  &fakeMail{},
		users: &fakeUsers{byEmail: map[string]string{"old@example.com": "old-uid"}, disabled: map[string]bool{}},
		now:   time.Date(2026, 11, 3, 10, 0, 0, 0, time.UTC),
		code:  "123456",
	}
	r.svc = &Service{
		Store: r.store, Users: r.users, Sessions: fakeSessions{}, Mail: r.mail,
		Now:     func() time.Time { return r.now },
		NewCode: func() (string, error) { return r.code, nil },
	}
	return r
}

func TestNormalizeEmail(t *testing.T) {
	good := map[string]string{" A@Example.COM ": "a@example.com", "x.y+z@sub.example.co": "x.y+z@sub.example.co"}
	for in, want := range good {
		if got, err := NormalizeEmail(in); err != nil || got != want {
			t.Errorf("%q: got %q, %v", in, got, err)
		}
	}
	for _, bad := range []string{"", "a", "a@", "@b.c", "a@b", "a b@c.d", "a@b@c.d", "a@b.c,d@e.f", strings.Repeat("a", 320) + "@b.c"} {
		if _, err := NormalizeEmail(bad); !errors.Is(err, ErrInvalidEmail) {
			t.Errorf("%q: want ErrInvalidEmail, got %v", bad, err)
		}
	}
}

func TestRandomCodeShape(t *testing.T) {
	seen := map[string]bool{}
	for i := 0; i < 200; i++ {
		c, err := RandomCode()
		if err != nil || len(c) != 6 || strings.Trim(c, "0123456789") != "" {
			t.Fatalf("bad code %q (%v)", c, err)
		}
		seen[c] = true
	}
	if len(seen) < 190 {
		t.Fatalf("codes repeat too often: %d distinct of 200", len(seen))
	}
}

func TestStartMailsAHashedCode(t *testing.T) {
	r := newRig()
	wait, err := r.svc.Start(context.Background(), "a@example.com")
	if err != nil || wait != ResendGap {
		t.Fatalf("start: %v %v", wait, err)
	}
	if len(r.mail.sent) != 1 {
		t.Fatalf("mails: %d", len(r.mail.sent))
	}
	m := r.mail.sent[0]
	if m.Subject != "Spatial Video Studio: your sign-in code" || m.To != "a@example.com" || !strings.Contains(m.Text, "123456") {
		t.Fatalf("mail: %+v", m)
	}
	rec, ok := r.store.Get(Key("a@example.com"))
	if !ok || rec.CodeHash == "" || strings.Contains(rec.CodeHash, "123456") || rec.Salt == "" {
		t.Fatalf("record: %+v", rec)
	}
	if !rec.ExpiresAt.Equal(r.now.Add(10 * time.Minute)) {
		t.Fatalf("expiry %v", rec.ExpiresAt)
	}
	if strings.Contains(Key("a@example.com"), "example") {
		t.Fatal("key carries the address")
	}
}

func TestStartResendGapAndHourlyCap(t *testing.T) {
	r := newRig()
	ctx := context.Background()
	if _, err := r.svc.Start(ctx, "a@example.com"); err != nil {
		t.Fatal(err)
	}
	r.now = r.now.Add(10 * time.Second)
	var w *WaitError
	if _, err := r.svc.Start(ctx, "a@example.com"); !errors.As(err, &w) || w.Reason != "resend_too_soon" || w.Wait != 20*time.Second {
		t.Fatalf("want resend_too_soon 20s, got %v", err)
	}
	for i := 0; i < 4; i++ {
		r.now = r.now.Add(31 * time.Second)
		if _, err := r.svc.Start(ctx, "a@example.com"); err != nil {
			t.Fatalf("send %d: %v", i+2, err)
		}
	}
	r.now = r.now.Add(31 * time.Second)
	if _, err := r.svc.Start(ctx, "a@example.com"); !errors.As(err, &w) || w.Reason != "too_many_codes" {
		t.Fatalf("want too_many_codes, got %v", err)
	}
	if len(r.mail.sent) != 5 {
		t.Fatalf("mails: %d", len(r.mail.sent))
	}
	// Another address is unaffected; an hour later this one works again.
	if _, err := r.svc.Start(ctx, "b@example.com"); err != nil {
		t.Fatal(err)
	}
	r.now = r.now.Add(time.Hour)
	if _, err := r.svc.Start(ctx, "a@example.com"); err != nil {
		t.Fatalf("after the window: %v", err)
	}
}

func TestVerifySignsInExistingAndNewAccounts(t *testing.T) {
	r := newRig()
	ctx := context.Background()
	if _, err := r.svc.Start(ctx, "old@example.com"); err != nil {
		t.Fatal(err)
	}
	res, err := r.svc.Verify(ctx, "old@example.com", "123456", false)
	if err != nil || res.UID != "old-uid" || res.IsNewUser || res.CustomToken != "custom-old-uid" {
		t.Fatalf("existing: %+v %v", res, err)
	}
	// The code works once.
	if _, err := r.svc.Verify(ctx, "old@example.com", "123456", false); !errors.Is(err, ErrNoCode) {
		t.Fatalf("reuse: %v", err)
	}

	if _, err := r.svc.Start(ctx, "new@example.com"); err != nil {
		t.Fatal(err)
	}
	res, err = r.svc.Verify(ctx, "new@example.com", " 123456 ", true)
	if err != nil || !res.IsNewUser || res.Session == nil || res.Session.IDToken != "id" || res.CustomToken != "" {
		t.Fatalf("new with session: %+v %v", res, err)
	}
	if r.users.created != 1 {
		t.Fatalf("created %d", r.users.created)
	}
}

func TestVerifyAttemptsAndExpiry(t *testing.T) {
	r := newRig()
	ctx := context.Background()
	if _, err := r.svc.Start(ctx, "a@example.com"); err != nil {
		t.Fatal(err)
	}
	var wrong *WrongCodeError
	// Malformed input doesn't count.
	if _, err := r.svc.Verify(ctx, "a@example.com", "12a456", false); !errors.As(err, &wrong) || wrong.AttemptsLeft != -1 {
		t.Fatalf("malformed: %v", err)
	}
	for i := 1; i <= 4; i++ {
		if _, err := r.svc.Verify(ctx, "a@example.com", "000000", false); !errors.As(err, &wrong) || wrong.AttemptsLeft != 5-i {
			t.Fatalf("try %d: %v", i, err)
		}
	}
	if _, err := r.svc.Verify(ctx, "a@example.com", "000000", false); !errors.As(err, &wrong) || wrong.AttemptsLeft != 0 {
		t.Fatalf("fifth: %v", err)
	}
	// Spent: even the right code fails now.
	if _, err := r.svc.Verify(ctx, "a@example.com", "123456", false); !errors.Is(err, ErrNoCode) {
		t.Fatalf("after five: %v", err)
	}

	// A new code after the gap works; past 10 minutes it doesn't.
	r.now = r.now.Add(time.Minute)
	if _, err := r.svc.Start(ctx, "a@example.com"); err != nil {
		t.Fatal(err)
	}
	r.now = r.now.Add(10 * time.Minute)
	if _, err := r.svc.Verify(ctx, "a@example.com", "123456", false); !errors.Is(err, ErrNoCode) {
		t.Fatalf("expired: %v", err)
	}
}

func TestVerifyDisabledAccount(t *testing.T) {
	r := newRig()
	r.users.disabled["old@example.com"] = true
	if _, err := r.svc.Start(context.Background(), "old@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := r.svc.Verify(context.Background(), "old@example.com", "123456", false); !errors.Is(err, ErrDisabled) {
		t.Fatalf("got %v", err)
	}
}

func TestMailFailureIsUnavailable(t *testing.T) {
	r := newRig()
	r.mail.err = errors.New("status 500")
	if _, err := r.svc.Start(context.Background(), "a@example.com"); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("got %v", err)
	}
}

func post(h http.HandlerFunc, body string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
	req.RemoteAddr = "203.0.113.9:1234"
	w := httptest.NewRecorder()
	h(w, req)
	return w
}

func TestHandlers(t *testing.T) {
	r := newRig()
	h := NewHandlers(r.svc, identity.NewIPPolicy("", ""))

	w := post(h.Start, `{"email":"Old@Example.com"}`)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"resend_after":30`) {
		t.Fatalf("start: %d %s", w.Code, w.Body)
	}
	w = post(h.Start, `{"email":"old@example.com"}`)
	if w.Code != 429 || !strings.Contains(w.Body.String(), "resend_too_soon") {
		t.Fatalf("resend: %d %s", w.Code, w.Body)
	}
	w = post(h.Start, `{"email":"nope"}`)
	if w.Code != 400 || !strings.Contains(w.Body.String(), "invalid_email") {
		t.Fatalf("bad email: %d %s", w.Code, w.Body)
	}

	w = post(h.Verify, `{"email":"old@example.com","code":"999999"}`)
	if w.Code != 400 || !strings.Contains(w.Body.String(), `"code_invalid"`) || !strings.Contains(w.Body.String(), `"attempts_left":4`) {
		t.Fatalf("wrong: %d %s", w.Code, w.Body)
	}
	w = post(h.Verify, `{"email":"old@example.com","code":"123456"}`)
	var ans map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &ans)
	if w.Code != 200 || ans["custom_token"] != "custom-old-uid" || ans["uid"] != "old-uid" || ans["is_new_user"] != false {
		t.Fatalf("verify: %d %s", w.Code, w.Body)
	}
	if strings.Contains(w.Body.String(), "123456") {
		t.Fatal("answer echoes the code")
	}

	// Session mode answers the identity Session fields.
	r.now = r.now.Add(time.Minute)
	post(h.Start, `{"email":"cn@example.com"}`)
	w = post(h.Verify, `{"email":"cn@example.com","code":"123456","session":true}`)
	ans = nil
	_ = json.Unmarshal(w.Body.Bytes(), &ans)
	if w.Code != 200 || ans["id_token"] != "id" || ans["refresh_token"] != "rt" || ans["is_new_user"] != true || ans["custom_token"] != nil {
		t.Fatalf("session verify: %d %s", w.Code, w.Body)
	}
}

func TestStartPerIPLimit(t *testing.T) {
	r := newRig()
	h := NewHandlers(r.svc, identity.NewIPPolicy("", ""))
	var last *httptest.ResponseRecorder
	for i := 0; i < startPerMinute+1; i++ {
		last = post(h.Start, `{"email":"user`+string(rune('a'+i))+`@example.com"}`)
	}
	if last.Code != 429 || !strings.Contains(last.Body.String(), "rate_limited") {
		t.Fatalf("got %d %s", last.Code, last.Body)
	}
}

func TestUnconfiguredIsUnavailable(t *testing.T) {
	h := NewHandlers(&Service{}, identity.NewIPPolicy("", ""))
	w := post(h.Start, `{"email":"a@example.com"}`)
	if w.Code != 502 || !strings.Contains(w.Body.String(), "auth_unavailable") {
		t.Fatalf("got %d %s", w.Code, w.Body)
	}
}
