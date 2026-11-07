package api

import (
	"context"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// An admin's usage credit is plan-kind credit: spent like it, never cash,
// 30 days, its own ref (it doesn't replace a plan's or Pro's credit).
func TestAdminGrantCredit(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	a := &AdminUser{UID: "admin", Email: "owner@x", Method: "cli"}
	if err := s.adminGrantCredit(ctx, a, uid, 10000, "", ""); err == nil {
		t.Fatal("no reason")
	}
	exp := time.Now().Add(31 * 24 * time.Hour)
	if _, _, err := s.Store.BalanceTx(ctx, uid, func(*store.Balance) ([]store.BalanceOp, error) { // a Pro credit already there
		return []store.BalanceOp{{Kind: store.EntryPlanCredit, Cents: 2000, EntryID: "procredit_x", Ref: "pro:x", ExpiresAt: &exp}}, nil
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.adminGrantCredit(ctx, a, uid, 10000, "", "owner test credit"); err != nil {
		t.Fatal(err)
	}
	b, _ := s.Store.GetBalance(ctx, uid)
	if b.PlanCreditCents() != 12000 || b.CashCents() != 0 || b.Available() != 12000 {
		t.Fatalf("credit %d cash %d available %d", b.PlanCreditCents(), b.CashCents(), b.Available())
	}
	for _, it := range b.Fifo {
		if !it.PlanCredit || it.ExpiresAt == nil || it.ExpiresAt.Sub(time.Now()) < 29*24*time.Hour || !(strings.HasPrefix(it.Ref, "admin:") || it.Ref == "pro:x") {
			t.Fatalf("item %+v", it)
		}
	}
}
