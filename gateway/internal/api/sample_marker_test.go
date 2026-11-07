package api

import (
	"context"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Every account gets the sample exactly once (owner 2026-11-07): a new
// one; an old one that never had it (its age doesn't matter); concurrent
// lists make one; an account that already has one gets no second (and is
// marked); one marked with none left gets none; pending deletion gets none.
func TestSampleOncePerAccount(t *testing.T) {
	s, _ := e0Service(t)
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	ctx := context.Background()
	samples := func(uid string) int {
		ps, _ := s.Store.ListUserSamples(ctx, uid)
		n := 0
		for _, p := range ps {
			if !p.Deleted {
				n++
			}
		}
		return n
	}
	marked := func(uid string) bool {
		c, err := s.Store.GetCustomer(ctx, uid)
		return err == nil && c.SampleCreatedAt != nil
	}

	// a new account (no customer record yet)
	fresh := "u" + store.NewID()
	if _, added := s.ensureSample(ctx, fresh, nil); !added || samples(fresh) != 1 || !marked(fresh) {
		t.Fatalf("new account: samples %d marked %v", samples(fresh), marked(fresh))
	}
	if _, added := s.ensureSample(ctx, fresh, nil); added || samples(fresh) != 1 {
		t.Fatal("twice")
	}

	// an old account, onboarded, never had one (the owner's case): gets it once
	old := "u" + store.NewID()
	done := true
	s.Store.PutCustomer(ctx, old, &store.Customer{StripeCustomerID: "cus_o", CreatedAt: time.Date(2026, 11, 3, 16, 0, 15, 0, time.UTC),
		Onboarding: &store.Onboarding{WelcomeDone: &done}})
	if _, added := s.ensureSample(ctx, old, nil); !added || samples(old) != 1 || !marked(old) {
		t.Fatalf("old account: samples %d marked %v", samples(old), marked(old))
	}
	if c, _ := s.Store.GetCustomer(ctx, old); c.StripeCustomerID != "cus_o" || c.Onboarding == nil {
		t.Fatal("the marker overwrote the account")
	}

	// concurrent first lists: one sample
	race := "u" + store.NewID()
	var wg sync.WaitGroup
	adds := make(chan bool, 8)
	for range 8 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, added := s.ensureSample(context.Background(), race, nil)
			adds <- added
		}()
	}
	wg.Wait()
	close(adds)
	n := 0
	for a := range adds {
		if a {
			n++
		}
	}
	if n != 1 || samples(race) != 1 {
		t.Fatalf("concurrent: %d added, %d samples", n, samples(race))
	}

	// already has one (from before the marker): no second, marked now
	has := "u" + store.NewID()
	s.createSample(ctx, has, false)
	s.Store.PutCustomer(ctx, has, &store.Customer{StripeCustomerID: "cus_h"}) // no marker
	sampleMarked.Delete(has)
	p, _ := s.Store.GetProject(ctx, sampleProjectID(has))
	if _, added := s.ensureSample(ctx, has, []*store.Project{p}); added || samples(has) != 1 || !marked(has) {
		t.Fatalf("has one: samples %d marked %v", samples(has), marked(has))
	}

	// marked, none left (deleted for good): never twice
	gone := "u" + store.NewID()
	at := time.Now().UTC()
	s.Store.PutCustomer(ctx, gone, &store.Customer{StripeCustomerID: "cus_g", SampleCreatedAt: &at})
	if _, added := s.ensureSample(ctx, gone, nil); added || samples(gone) != 0 {
		t.Fatal("recreated")
	}

	// pending deletion (the 48-hour wait, and a closure case): none
	pend := "u" + store.NewID()
	if _, _, err := s.Store.ScheduleAccountDeletion(ctx, &store.AccountDeletion{UID: pend, State: store.DeletionStatePending,
		RequestedAt: at, DeleteAfter: at.Add(48 * time.Hour)}); err != nil {
		t.Fatal(err)
	}
	if _, added := s.ensureSample(ctx, pend, nil); added || samples(pend) != 0 {
		t.Fatal("pending deletion got one")
	}
	closing := "u" + store.NewID()
	s.Store.PutCustomer(ctx, closing, &store.Customer{StripeCustomerID: "cus_c", DeletionPending: true})
	if _, added := s.ensureSample(ctx, closing, nil); added {
		t.Fatal("closure-case deletion got one")
	}
}
