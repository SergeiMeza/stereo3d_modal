package api

import (
	"context"
	"net/http"
	"testing"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// The depth choice (owner 2026-11-10): standard 4% by default, sent as
// max_disparity_pct on every Lifelike run, no price change; Classic
// refuses it, and anything else is a 400.
func TestLifelikeDepthChoice(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	p := lifelikeProject()
	p.UID = uid

	var base int64
	for _, c := range []struct {
		depth, want string
		pct         float64
	}{{"", "standard", 4}, {"standard", "standard", 4}, {"comfortable", "comfortable", 3}, {"strong", "strong", 5}} {
		params, perr := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "4k", Depth: c.depth}, p)
		if perr != nil || params.Depth != c.want || params.MaxDisparityPct != c.pct {
			t.Fatalf("%q: %v %+v", c.depth, perr, params)
		}
		if b := lifelikeBody(&store.Conversion{Method: store.MethodLifelike, Params: params}, 4); b["max_disparity_pct"] != c.pct {
			t.Fatalf("%q body: %v", c.depth, b)
		}
		q, _, qerr := s.quoteStep(ctx, p, params, store.StepProduction, 0)
		if qerr != nil {
			t.Fatal(qerr)
		}
		if base == 0 {
			base = q.AmountCents
		} else if q.AmountCents != base {
			t.Fatalf("%q changes the price: %d vs %d", c.depth, q.AmountCents, base)
		}
	}
	if _, perr := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "4k", Depth: "huge"}, p); perr == nil || perr.Status != http.StatusBadRequest {
		t.Fatalf("bad value: %v", perr)
	}
	// a run from before keeps the worker's default: nothing sent
	if b := lifelikeBody(&store.Conversion{Method: store.MethodLifelike, Params: store.Params{Preset: "4k"}}, 4); b["max_disparity_pct"] != nil || b["stabilize"] != nil {
		t.Fatalf("old run body: %v", b)
	}
	classic := proProject()
	classic.UID = uid
	if _, cerr := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "1080p", Depth: "strong"}, classic); cerr == nil || cerr.Status != http.StatusBadRequest {
		t.Fatalf("classic: %v", cerr)
	}
}

// Smoother motion (owner 2026-11-10): recorded, sent as stabilize: true only
// when bought, +10%, a preview with it is never a free one, Classic refuses.
func TestStabilizeRun(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	p := lifelikeProject()
	p.UID = uid

	params, perr := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "4k", Stabilize: true}, p)
	if perr != nil || !params.Stabilize {
		t.Fatalf("resolve %v %+v", perr, params)
	}
	if b := lifelikeBody(&store.Conversion{Method: store.MethodLifelike, Params: params}, 4); b["stabilize"] != true {
		t.Fatalf("body: %v", b)
	}
	plain, _ := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "4k"}, p)
	if b := lifelikeBody(&store.Conversion{Method: store.MethodLifelike, Params: plain}, 4); b["stabilize"] != nil {
		t.Fatalf("not bought, not sent: %v", b)
	}
	q0, _, e0 := s.quoteStep(ctx, p, plain, store.StepProduction, 0)
	q1, _, e1 := s.quoteStep(ctx, p, params, store.StepProduction, 0)
	if e0 != nil || e1 != nil || q1.AmountCents != q0.AmountCents*11/10 || q1.Breakdown["stabilize_label"] != "Smoother motion +10%" {
		t.Fatalf("quotes %v %v %v %v", q0, q1, e0, e1)
	}
	pv, _ := s.resolveParams(ctx, &stepConvReq{Step: store.StepLifelikePreview, Preset: "4k", FromFrame: 0, ToFrame: 120, Stabilize: true}, p)
	qp, _, ep := s.quoteStep(ctx, p, pv, store.StepLifelikePreview, 0)
	if ep != nil || qp.AmountCents <= 0 || qp.Breakdown["free_preview"] == true {
		t.Fatalf("preview %v %v", qp, ep)
	}
	off := pricing.DefaultsFor("test")
	off.StabilizeOff = true
	s.Pricing = pricing.NewStatic(off)
	if _, oerr := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "4k", Stabilize: true}, p); oerr == nil || oerr.Status != http.StatusBadRequest {
		t.Fatalf("withdrawn: %v", oerr)
	}
	classic := proProject()
	classic.UID = uid
	if _, cerr := s.resolveParams(ctx, &stepConvReq{Step: store.StepProduction, Preset: "1080p", Stabilize: true}, classic); cerr == nil || cerr.Status != http.StatusBadRequest {
		t.Fatalf("classic: %v", cerr)
	}
}
