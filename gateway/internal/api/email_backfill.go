package api

import (
	"context"
	"errors"
	"fmt"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/auth"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// EM-01 (owner 2026-11-06): the email store's backfill. Every Firebase
// user's email becomes its main email as it is (verified or not: the
// password-only accounts keep an unverified main until a code proves it);
// a deleted account's customers.email becomes a released row; plan
// accounts get their Stripe customer email set to the main one (a Stripe
// write, only with Stripe). A dry run writes nothing and counts what a
// live run would do. Counts only: no uid or email leaves this function.

// EmailBackfill is what the backfill found (and did, on a live run).
type EmailBackfill struct {
	Live  bool `json:"live"`
	Users int  `json:"firebase_users"`
	// Firebase emails.
	WithEmail          int `json:"with_email"`
	NoEmail            int `json:"no_email"`
	Verified           int `json:"verified"`
	Unverified         int `json:"unverified"`
	PasswordUnverified int `json:"password_only_unverified"`
	Relay              int `json:"relay_addresses"`
	Disabled           int `json:"disabled"`
	// Against the store.
	AlreadyStored int `json:"already_in_store"`
	ToAdd         int `json:"to_add"`
	Added         int `json:"added"`
	AddedMain     int `json:"added_main"`
	AddedExtra    int `json:"added_additional"`
	Conflicts     int `json:"conflicts"` // the email is active on another account in the store
	// DuplicatePairs: emails two or more Firebase users share (from before
	// one account per email); a live run marks their row
	// support_case duplicate_email.
	DuplicatePairs  int `json:"duplicate_email_pairs"`
	DuplicateMarked int `json:"duplicate_email_marked"`
	// Customer records.
	Customers         int `json:"customers"`
	Deleted           int `json:"deleted_accounts"`
	DeletedWithEmail  int `json:"deleted_with_email"`
	ToRelease         int `json:"to_release"`
	Released          int `json:"released"`
	WithoutFirebase   int `json:"customers_without_firebase_user"`
	CustomerDiffers   int `json:"customers_email_differs_from_main"`
	PlanAccounts      int `json:"plan_accounts"`
	PlanRelayMain     int `json:"plan_accounts_relay_or_no_main"`
	StripeToResync    int `json:"stripe_customers_to_resync"`
	StripeResynced    int `json:"stripe_customers_resynced"`
	CustomersResynced int `json:"customers_email_resynced"`
	// EM-03 check: Business or Studio accounts whose main email is a
	// relay address (or missing) in the store, all shown
	// plan_email_needed.
	BusinessPlans        int `json:"business_studio_plans"`
	RelayMainOnPlan      int `json:"relay_main_on_business_studio"`
	PlanEmailNeededShown int `json:"plan_email_needed_shown"`
	Errors               int `json:"errors"`
}

// BackfillAccountEmails runs EM-01 over users (each Firebase user) and the
// customer records. live writes the store (and customers.email); stripe
// also sets plan accounts' Stripe customer email (live only).
func (s *Service) BackfillAccountEmails(ctx context.Context, users func(context.Context, func(*auth.Identity) error) error, live, stripe bool) (*EmailBackfill, error) {
	out := &EmailBackfill{Live: live}
	main := map[string]string{} // uid → its Firebase email (the main)
	sharing := map[string]int{} // email → Firebase users with it
	now := time.Now().UTC()
	err := users(ctx, func(id *auth.Identity) error {
		out.Users++
		if id.Disabled {
			out.Disabled++
		}
		email := normalEmail(id.Email)
		if email == "" {
			out.NoEmail++
			return nil
		}
		out.WithEmail++
		main[id.UID] = email
		sharing[email]++
		password := false
		for _, p := range id.Providers {
			password = password || p == providerPassword
		}
		switch {
		case id.EmailVerified:
			out.Verified++
		case password && len(signInMethods(id)) == 1:
			out.PasswordUnverified++
			out.Unverified++
		default:
			out.Unverified++
		}
		if store.IsRelayEmail(email) {
			out.Relay++
		}
		row, err := s.Store.GetAccountEmail(ctx, email)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			out.Errors++
			return nil
		}
		switch {
		case row != nil && row.State == store.EmailActive && row.UID == id.UID:
			out.AlreadyStored++
			return nil
		case row != nil && row.State == store.EmailActive:
			out.Conflicts++
			return nil
		}
		out.ToAdd++
		if !live {
			return nil
		}
		res, err := s.Store.AddAccountEmail(ctx, store.AddEmailSpec{UID: id.UID, Email: email, Source: "backfill",
			Verified: id.EmailVerified, MainIfNone: true, Claim: true, Who: "backfill", At: now})
		if err != nil {
			if _, taken := store.IsEmailTaken(err); taken {
				out.Conflicts++
			} else {
				out.Errors++
			}
			return nil
		}
		out.Added++
		if res.BecameMain {
			out.AddedMain++
		} else {
			out.AddedExtra++
		}
		return nil
	})
	if err != nil {
		return out, err
	}
	for email, n := range sharing {
		if n < 2 {
			continue
		}
		out.DuplicatePairs++
		if live {
			note := fmt.Sprintf("%d Firebase users share this email (EM-01 backfill); row on the first one met", n)
			if err := s.Store.MarkEmailSupportCase(ctx, email, "duplicate_email", note); err != nil {
				out.Errors++
			} else {
				out.DuplicateMarked++
			}
		}
	}
	err = s.Store.EachCustomer(ctx, func(uid string, c *store.Customer) error {
		out.Customers++
		email := normalEmail(c.Email)
		if c.AccountDeleted {
			out.Deleted++
			if email == "" {
				return nil
			}
			out.DeletedWithEmail++
			if row, err := s.Store.GetAccountEmail(ctx, email); err == nil && row != nil {
				return nil // already recorded (released, or someone's now)
			} else if !errors.Is(err, store.ErrNotFound) {
				out.Errors++
				return nil
			}
			out.ToRelease++
			if live {
				if ok, err := s.Store.PutReleasedEmail(ctx, uid, email, now); err != nil {
					out.Errors++
				} else if ok {
					out.Released++
				}
			}
			return nil
		}
		m, ok := main[uid]
		if !ok {
			out.WithoutFirebase++
		}
		if ok && email != m {
			out.CustomerDiffers++
		}
		if c.Plan == nil || !c.Plan.Active(now) || c.Plan.SubscriptionID == "" {
			if live && ok && email != m {
				if _, err := s.Store.UpdateCustomer(ctx, uid, func(x *store.Customer) error { x.Email = m; return nil }); err == nil {
					out.CustomersResynced++
				} else {
					out.Errors++
				}
			}
			return nil
		}
		out.PlanAccounts++
		if c.Plan.Tier == pricing.TierBusiness || c.Plan.Tier == pricing.TierStudio {
			out.BusinessPlans++
			list, err := s.Store.ListAccountEmails(ctx, uid)
			if err != nil {
				out.Errors++
			} else if m := mainOf(list); m == nil || m.Relay() {
				out.RelayMainOnPlan++
				if s.planEmailNeeded(ctx, uid, list) {
					out.PlanEmailNeededShown++
				}
			}
		}
		if !ok || store.IsRelayEmail(m) {
			out.PlanRelayMain++
		}
		if !ok || c.StripeCustomerID == "" {
			return nil
		}
		out.StripeToResync++
		if !live {
			return nil
		}
		if email != m {
			if _, err := s.Store.UpdateCustomer(ctx, uid, func(x *store.Customer) error { x.Email = m; return nil }); err == nil {
				out.CustomersResynced++
			} else {
				out.Errors++
			}
		}
		if stripe && s.Stripe != nil {
			if err := s.Stripe.SetCustomerEmail(c.StripeCustomerID, m); err != nil {
				out.Errors++
			} else {
				out.StripeResynced++
			}
		}
		return nil
	})
	return out, err
}
