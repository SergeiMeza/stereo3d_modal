package store

import (
	"context"
	"errors"
	"testing"
)

func testEmail(tag string) string { return tag + "-" + NewID() + "@example.com" }

// One account per email, exactly one main, at most five.
func TestAccountEmailsOneOwnerOneMain(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	a, b := "u"+NewID(), "u"+NewID()
	first, second := testEmail("first"), testEmail("second")

	r, err := s.AddAccountEmail(ctx, AddEmailSpec{UID: a, Email: first, Source: "code", Verified: true})
	if err != nil || !r.BecameMain || r.SyncID == "" {
		t.Fatalf("first email is main: %+v %v", r, err)
	}
	r, err = s.AddAccountEmail(ctx, AddEmailSpec{UID: a, Email: second, Source: "code", Verified: true})
	if err != nil || r.BecameMain || r.SyncID != "" {
		t.Fatalf("second is additional: %+v %v", r, err)
	}
	if _, err := s.AddAccountEmail(ctx, AddEmailSpec{UID: b, Email: "  " + first + " "}); err == nil {
		t.Fatal("an email on two accounts")
	} else if owner, ok := IsEmailTaken(err); !ok || owner != a {
		t.Fatalf("taken: %v %q", err, owner)
	}
	// Same email again on the same account is a no-op.
	if r, err := s.AddAccountEmail(ctx, AddEmailSpec{UID: a, Email: second}); err != nil || !r.Existed || r.BecameMain {
		t.Fatalf("again: %+v %v", r, err)
	}
	list, _ := s.ListAccountEmails(ctx, a)
	if len(list) != 2 || !list[0].Main || list[0].Email != first || list[1].Main {
		t.Fatalf("list %+v", list)
	}
	// Make the second main: the first loses it, a sync row is queued.
	r, err = s.SetMainEmail(ctx, a, list[1].ID, "test", false)
	if err != nil || !r.BecameMain || r.PreviousMain != first || r.SyncID == "" {
		t.Fatalf("switch %+v %v", r, err)
	}
	list, _ = s.ListAccountEmails(ctx, a)
	mains := 0
	for _, e := range list {
		if e.Main {
			mains++
		}
	}
	if mains != 1 || list[0].Email != second {
		t.Fatalf("one main %+v", list)
	}
	// Making the main main again changes nothing.
	if r, err := s.SetMainEmail(ctx, a, list[0].ID, "test", false); err != nil || r.BecameMain {
		t.Fatalf("again main %+v %v", r, err)
	}
	// Five at most.
	for i := 0; i < 3; i++ {
		if _, err := s.AddAccountEmail(ctx, AddEmailSpec{UID: a, Email: testEmail("more")}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := s.AddAccountEmail(ctx, AddEmailSpec{UID: a, Email: testEmail("sixth")}); !errors.Is(err, ErrTooManyEmails) {
		t.Fatalf("sixth: %v", err)
	}
	// Another account's email can't be made main here.
	if _, err := s.SetMainEmail(ctx, b, list[0].ID, "test", false); !errors.Is(err, ErrEmailNotOnAccount) {
		t.Fatalf("foreign id: %v", err)
	}
}

func TestAccountEmailsRemoveAndRelease(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	a, b := "u"+NewID(), "u"+NewID()
	main, extra := testEmail("main"), testEmail("extra")
	s.AddAccountEmail(ctx, AddEmailSpec{UID: a, Email: main})
	s.AddAccountEmail(ctx, AddEmailSpec{UID: a, Email: extra})
	list, _ := s.ListAccountEmails(ctx, a)
	if err := s.ReleaseAccountEmail(ctx, a, list[0].ID, "test"); !errors.Is(err, ErrMainNotRemovable) {
		t.Fatalf("main removed: %v", err)
	}
	if err := s.ReleaseAccountEmail(ctx, a, list[1].ID, "test"); err != nil {
		t.Fatal(err)
	}
	if owner, _ := s.EmailOwner(ctx, extra); owner != "" {
		t.Fatalf("released still owned by %q", owner)
	}
	// A released email can go to another account; the row keeps the new uid.
	if _, err := s.AddAccountEmail(ctx, AddEmailSpec{UID: b, Email: extra}); err != nil {
		t.Fatal(err)
	}
	if owner, _ := s.EmailOwner(ctx, extra); owner != b {
		t.Fatalf("owner %q", owner)
	}
	// Deletion releases everything; history keeps the rows.
	if n, err := s.ReleaseAllAccountEmails(ctx, a, "delete"); err != nil || n != 1 {
		t.Fatalf("release all %d %v", n, err)
	}
	if list, _ := s.ListAccountEmails(ctx, a); len(list) != 0 {
		t.Fatalf("left %+v", list)
	}
	if h, _ := s.ListEmailHistory(ctx, a); len(h) != 1 || h[0].State != EmailReleased {
		t.Fatalf("history %+v", h)
	}
}

// EM-03: a relay address may be an additional email, never main when the
// caller asks for the rule.
func TestAccountEmailsRelayNotMain(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	a := "u" + NewID()
	relay := NewID() + "@privaterelay.appleid.com"
	if _, err := s.AddAccountEmail(ctx, AddEmailSpec{UID: a, Email: relay, RelayNotMain: true}); !errors.Is(err, ErrEmailRelayNotMain) {
		t.Fatalf("relay as first main: %v", err)
	}
	real := testEmail("real")
	s.AddAccountEmail(ctx, AddEmailSpec{UID: a, Email: real})
	r, err := s.AddAccountEmail(ctx, AddEmailSpec{UID: a, Email: relay, RelayNotMain: true, Verified: true})
	if err != nil || r.BecameMain || !r.Email.Relay() {
		t.Fatalf("relay additional: %+v %v", r, err)
	}
	if _, err := s.SetMainEmail(ctx, a, r.Email.ID, "test", true); !errors.Is(err, ErrEmailRelayNotMain) {
		t.Fatalf("relay main: %v", err)
	}
	if _, err := s.SetMainEmail(ctx, a, r.Email.ID, "test", false); err != nil {
		t.Fatalf("relay main without the rule: %v", err)
	}
}

// A claim (the Firebase email as it is) queues no sync; an unverified
// email can't be made main.
func TestAccountEmailsClaimAndUnverified(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	a := "u" + NewID()
	r, err := s.AddAccountEmail(ctx, AddEmailSpec{UID: a, Email: testEmail("claim"), Claim: true, MainIfNone: true})
	if err != nil || !r.BecameMain || r.SyncID != "" {
		t.Fatalf("claim %+v %v", r, err)
	}
	r, _ = s.AddAccountEmail(ctx, AddEmailSpec{UID: a, Email: testEmail("unverified")})
	if _, err := s.SetMainEmail(ctx, a, r.Email.ID, "test", false); !errors.Is(err, ErrEmailUnverified) {
		t.Fatalf("unverified main: %v", err)
	}
	// Proving it later (the same email with a code) makes it verified.
	if r2, err := s.AddAccountEmail(ctx, AddEmailSpec{UID: a, Email: r.Email.Email, Verified: true, Main: true}); err != nil || !r2.BecameMain || !r2.Email.Verified {
		t.Fatalf("proved %+v %v", r2, err)
	}
}

func TestEmailSyncDriftAfterTries(t *testing.T) {
	s := settleStore(t)
	ctx := context.Background()
	r, err := s.AddAccountEmail(ctx, AddEmailSpec{UID: "u" + NewID(), Email: testEmail("sync")})
	if err != nil {
		t.Fatal(err)
	}
	for i := 1; i < emailSyncMaxTries; i++ {
		if st, err := s.FinishEmailSync(ctx, r.SyncID, "boom"); err != nil || st != EmailSyncPending {
			t.Fatalf("try %d: %s %v", i, st, err)
		}
	}
	if st, _ := s.FinishEmailSync(ctx, r.SyncID, "boom"); st != EmailSyncDrift {
		t.Fatalf("drift: %s", st)
	}
	r2, _ := s.AddAccountEmail(ctx, AddEmailSpec{UID: "u" + NewID(), Email: testEmail("sync2")})
	if st, _ := s.FinishEmailSync(ctx, r2.SyncID, ""); st != EmailSyncDone {
		t.Fatalf("done: %s", st)
	}
}
