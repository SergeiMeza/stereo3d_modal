package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// Commercial use (owner 2026-11-09): the run records it, has no brand
// intro whatever the flag says, costs +50% (a preview too: never a free
// one), and Classic refuses it.
func TestCommercialRun(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	rates := pricing.DefaultsFor("test")
	rates.LifelikeIntroEnabled = true
	s.Pricing = pricing.NewStatic(rates)
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	p := lifelikeProject()
	p.UID = uid

	params, perr := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "4k", Commercial: true}, p)
	if perr != nil || !params.Commercial {
		t.Fatalf("resolve %v %+v", perr, params)
	}
	s.applyIntro(ctx, httptest.NewRequest("POST", "/", nil), uid, store.StepProduction, &params)
	if params.IntroS == nil || *params.IntroS != 0 {
		t.Fatalf("intro %v", params.IntroS)
	}
	if b := lifelikeBody(&store.Conversion{Method: store.MethodLifelike, Params: params}, 4); b["intro_s"] != nil || b["intro_language"] != nil {
		t.Fatalf("a commercial run has no intro: %v", b)
	}

	plain, _ := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "4k"}, p)
	q0, _, e0 := s.quoteStep(ctx, p, plain, store.StepProduction, 0)
	q1, _, e1 := s.quoteStep(ctx, p, params, store.StepProduction, 0)
	if e0 != nil || e1 != nil || q1.AmountCents != q0.AmountCents*3/2 || q1.Breakdown["commercial_label"] != "Commercial use +50%" {
		t.Fatalf("quotes %v %v %v %v", q0, q1, e0, e1)
	}

	// a commercial preview isn't free, even with the intro preview unused
	pv, _ := s.resolveParams(ctx, &stepConvReq{Step: store.StepLifelikePreview, Preset: "4k", FromFrame: 0, ToFrame: 120, Commercial: true}, p)
	qp, _, ep := s.quoteStep(ctx, p, pv, store.StepLifelikePreview, 0)
	if ep != nil || qp.AmountCents <= 0 || qp.Breakdown["free_preview"] == true {
		t.Fatalf("preview %v %v", qp, ep)
	}

	classic := proProject()
	classic.UID = uid
	if _, cerr := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "1080p", Commercial: true}, classic); cerr == nil || cerr.Status != http.StatusBadRequest {
		t.Fatalf("classic: %v", cerr)
	}
}

// A Business/Studio plan active at the change keeps Commercial use until
// its next renewal: svs-admin marks it once; its quotes include it at no
// charge; a plan not marked pays; the date ends it.
func TestCommercialGrandfather(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	end := time.Now().Add(20 * 24 * time.Hour)
	biz, pro, later := "u"+store.NewID(), "u"+store.NewID(), "u"+store.NewID()
	s.Store.PutCustomer(ctx, biz, &store.Customer{StripeCustomerID: "cus_1",
		Plan: &store.Plan{Tier: "business", SubscriptionID: "sub_b", Status: "active", CurrentPeriodEnd: &end}})
	s.Store.PutCustomer(ctx, pro, &store.Customer{StripeCustomerID: "cus_2",
		Plan: &store.Plan{Tier: "pro", PlanID: "pro_monthly", SubscriptionID: "sub_p", Status: "active", CurrentPeriodEnd: &end}})

	// a deleted account's plan waiting for Restore Purchases is marked too
	gone := "u" + store.NewID()
	s.Store.PutCustomer(ctx, gone, &store.Customer{StripeCustomerID: "cus_4", AccountDeleted: true,
		Plan: &store.Plan{Tier: "studio", SubscriptionID: "sub_g", Status: "active", CurrentPeriodEnd: &end}})

	dry, err := s.GrandfatherCommercial(ctx, false)
	if err != nil || dry.Written != 0 || len(dry.UIDs) < 1 {
		t.Fatalf("dry run %+v %v", dry, err)
	}
	res, err := s.GrandfatherCommercial(ctx, true)
	if err != nil || res.Written < 1 {
		t.Fatalf("apply %+v %v", res, err)
	}
	b, _ := s.Store.GetCustomer(ctx, biz)
	pc, _ := s.Store.GetCustomer(ctx, pro)
	if b.Plan.CommercialUntil == nil || !b.Plan.CommercialUntil.Equal(end) || pc.Plan.CommercialUntil != nil {
		t.Fatalf("marks: business %v pro %v", b.Plan.CommercialUntil, pc.Plan.CommercialUntil)
	}
	if g, _ := s.Store.GetCustomer(ctx, gone); g.Plan.CommercialUntil == nil {
		t.Fatal("the deleted account's plan isn't marked")
	}
	if again, _ := s.GrandfatherCommercial(ctx, true); again.Written != 0 {
		t.Fatalf("second run writes nothing: %+v", again)
	}
	if j := s.planJSON(ctx, biz); j["commercial_included_until"] == nil {
		t.Fatalf("plan json %v", j)
	}

	// a Business plan that started after the change pays
	s.Store.PutCustomer(ctx, later, &store.Customer{StripeCustomerID: "cus_3",
		Plan: &store.Plan{Tier: "business", SubscriptionID: "sub_l", Status: "active", CurrentPeriodEnd: &end}})

	quote := func(uid string, commercial bool) *store.Quote {
		p := lifelikeProject()
		p.UID = uid
		params, _ := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "4k", Commercial: commercial}, p)
		q, _, qerr := s.quoteStep(ctx, p, params, store.StepProduction, 0)
		if qerr != nil {
			t.Fatal(qerr)
		}
		return q
	}
	gf, gfAsk, paid, base := quote(biz, false), quote(biz, true), quote(later, true), quote(later, false)
	if gf.Breakdown["commercial"] != true || gf.Breakdown["commercial_included"] != true || gf.AmountCents != base.AmountCents || gfAsk.AmountCents != base.AmountCents {
		t.Fatalf("grandfathered: %d %d base %d %v", gf.AmountCents, gfAsk.AmountCents, base.AmountCents, gf.Breakdown)
	}
	if paid.AmountCents != base.AmountCents*3/2 || paid.Breakdown["commercial_included"] != false {
		t.Fatalf("not grandfathered: %d base %d", paid.AmountCents, base.AmountCents)
	}

	// the renewal: the date passed
	past := time.Now().Add(-time.Hour)
	s.Store.UpdateCustomer(ctx, biz, func(c *store.Customer) error { c.Plan.CommercialUntil = &past; return nil })
	if q := quote(biz, false); q.Breakdown["commercial"] != false {
		t.Fatalf("after renewal: %v", q.Breakdown)
	}
	if j := s.planJSON(ctx, biz); j["commercial_included_until"] != nil {
		t.Fatalf("plan json after renewal %v", j)
	}
}
