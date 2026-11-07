package stripex

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestPresentmentValue(t *testing.T) {
	cases := []struct {
		d    *presentmentDetails
		cur  string
		want *Presentment
	}{
		{nil, "usd", nil},
		{&presentmentDetails{1648, "JPY"}, "usd", &Presentment{1648, "jpy"}},
		{&presentmentDetails{1648, "jpy"}, "", &Presentment{1648, "jpy"}}, // an empty currency is usd
		{&presentmentDetails{3000, "usd"}, "usd", nil},                    // presented in USD: none
		{&presentmentDetails{0, "jpy"}, "usd", nil},
		{&presentmentDetails{1648, ""}, "usd", nil},
	}
	for i, c := range cases {
		got := c.d.value(c.cur)
		if (got == nil) != (c.want == nil) || got != nil && *got != *c.want {
			t.Fatalf("%d: %+v", i, got)
		}
	}
}

// PaymentPresentment reads the PaymentIntent at WebAPIVersion.
func TestPaymentPresentment(t *testing.T) {
	var version string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		version = r.Header.Get("Stripe-Version")
		if r.URL.Path == "/v1/payment_intents/pi_usd" {
			w.Write([]byte(`{"id":"pi_usd","currency":"usd","presentment_details":null}`))
			return
		}
		w.Write([]byte(`{"id":"pi_kr","currency":"usd","amount":499,"presentment_details":{"presentment_amount":7077,"presentment_currency":"krw"}}`))
	}))
	defer srv.Close()
	UseTestServer(srv.URL)
	c := &Client{env: "test"}
	if p, err := c.PaymentPresentment("pi_kr"); err != nil || p == nil || *p != (Presentment{7077, "krw"}) || version != WebAPIVersion {
		t.Fatalf("%+v %v %s", p, err, version)
	}
	if p, err := c.PaymentPresentment("pi_usd"); err != nil || p != nil {
		t.Fatalf("usd %+v %v", p, err)
	}
}
