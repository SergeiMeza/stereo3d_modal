package api

import (
	"net/http"
	"testing"
)

// D6: "Make default" also makes the new default the method of every live
// web plan (Checkout had set the subscription's own method, which wins);
// canceled plans, other products and environments are left alone.
func TestMakeDefaultRepointsPlans(t *testing.T) {
	s, f := offService(t)
	uid, cus := offCustomer(t, s, f, [2]string{"pm_old", ""}, [2]string{"pm_new", ""})
	web := map[string]any{"product": "svs-web", "env": "test", "user_id": uid, "plan": "business"}
	f.subs["sub_live"] = map[string]any{"id": "sub_live", "object": "subscription", "customer": cus, "status": "active", "metadata": web, "default_payment_method": "pm_old"}
	f.subs["sub_due"] = map[string]any{"id": "sub_due", "object": "subscription", "customer": cus, "status": "past_due", "metadata": web, "default_payment_method": "pm_old"}
	f.subs["sub_gone"] = map[string]any{"id": "sub_gone", "object": "subscription", "customer": cus, "status": "canceled", "metadata": web, "default_payment_method": "pm_old"}
	f.subs["sub_other"] = map[string]any{"id": "sub_other", "object": "subscription", "customer": cus, "status": "active",
		"metadata": map[string]any{"product": "other"}, "default_payment_method": "pm_old"}
	callJSON(t, func(w http.ResponseWriter, r *http.Request) {
		s.HandleSetDefaultMethod(w, r, &AuthedUser{UID: uid}, "pm_new")
	}, "POST", "")
	for id, want := range map[string]string{"sub_live": "pm_new", "sub_due": "pm_new", "sub_gone": "pm_old", "sub_other": "pm_old"} {
		if got := f.subs[id]["default_payment_method"]; got != want {
			t.Errorf("%s charges %v, want %s", id, got, want)
		}
	}
	if len(f.subSets) != 2 {
		t.Fatalf("updates %v", f.subSets)
	}
}
