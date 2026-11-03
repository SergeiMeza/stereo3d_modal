package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/store"
	"spatial-ai-labs/stereo3d-gateway/internal/stripex"
)

// fakeInvoices answers the invoice job's calls: invoices, items, lines,
// finalize, attach_payment, refunds and credit notes; one PaymentIntent
// pi_inv with amount_received 4972 and refunded cents set by the test.
type fakeInvoices struct {
	mu         sync.Mutex
	invoices   map[string]map[string]any
	lines      map[string][]map[string]any
	keys       map[string]string // idempotency key → invoice id
	refunded   int64
	refunds    []map[string]any
	notes      int
	creates    int
	failAttach bool
}

func (f *fakeInvoices) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_ = r.ParseForm()
	p := r.URL.Path
	write := func(v any) { _ = json.NewEncoder(w).Encode(v) }
	inv := func(id string) map[string]any {
		x := f.invoices[id]
		var total int64
		for _, l := range f.lines[id] {
			total += l["amount"].(int64)
		}
		x["total"] = total
		return x
	}
	switch {
	case p == "/v1/payment_intents/pi_inv":
		write(map[string]any{"id": "pi_inv", "amount_received": 4972, "latest_charge": map[string]any{"amount_refunded": f.refunded}})
	case p == "/v1/invoices" && r.Method == "POST":
		if id, ok := f.keys[r.Header.Get("Idempotency-Key")]; ok {
			write(inv(id))
			return
		}
		f.creates++
		id := fmt.Sprintf("in_%d", f.creates)
		f.keys[r.Header.Get("Idempotency-Key")] = id
		f.invoices[id] = map[string]any{"id": id, "status": "draft", "currency": r.Form.Get("currency"),
			"metadata": map[string]any{"charge_id": r.Form.Get("metadata[charge_id]"), "env": r.Form.Get("metadata[env]"), "product": "svs-web"}}
		write(inv(id))
	case p == "/v1/invoiceitems":
		id := r.Form.Get("invoice")
		amt, _ := strconv.ParseInt(r.Form.Get("amount"), 10, 64)
		f.lines[id] = append(f.lines[id], map[string]any{"amount": amt, "metadata": map[string]any{"conversion_id": r.Form.Get("metadata[conversion_id]")}})
		write(map[string]any{"id": "ii"})
	case strings.HasSuffix(p, "/lines"):
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/v1/invoices/"), "/lines")
		write(map[string]any{"data": f.lines[id]})
	case strings.HasSuffix(p, "/finalize"):
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/v1/invoices/"), "/finalize")
		f.invoices[id]["status"], f.invoices[id]["number"] = "open", "S3D-"+id
		write(inv(id))
	case strings.HasSuffix(p, "/attach_payment"):
		id := strings.TrimSuffix(strings.TrimPrefix(p, "/v1/invoices/"), "/attach_payment")
		if f.failAttach {
			w.WriteHeader(500)
			write(map[string]any{"error": map[string]any{"type": "api_error", "message": "boom"}})
			return
		}
		f.invoices[id]["status"] = "paid"
		f.invoices[id]["hosted_invoice_url"], f.invoices[id]["invoice_pdf"] = "https://inv/"+id, "https://pdf/"+id
		write(inv(id))
	case strings.HasPrefix(p, "/v1/invoices/"):
		write(inv(strings.TrimPrefix(p, "/v1/invoices/")))
	case p == "/v1/refunds":
		write(map[string]any{"data": f.refunds})
	case p == "/v1/credit_notes":
		f.notes++
		amt, _ := strconv.ParseInt(r.Form.Get("amount"), 10, 64)
		write(map[string]any{"id": fmt.Sprintf("cn_%d", f.notes), "total": amt, "pdf": "https://cn"})
	default:
		w.WriteHeader(404)
		write(map[string]any{"error": map[string]any{"type": "invalid_request_error", "message": "unhandled " + p}})
	}
}

func invoiceService(t *testing.T) (*Service, *fakeInvoices) {
	s, _ := e0Service(t)
	f := &fakeInvoices{invoices: map[string]map[string]any{}, lines: map[string][]map[string]any{}, keys: map[string]string{}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	stripex.UseTestServer(srv.URL)
	return s, f
}

func recordTestCharge(t *testing.T, s *Service, lines ...int64) *store.Charge {
	t.Helper()
	ch := &store.Charge{UID: "u1", Kind: store.ChargeGroup, SourceID: store.NewID(), CustomerID: "cus_1",
		PaymentIntentID: "pi_inv", Currency: "usd", PaidAt: time.Now()}
	for i, amt := range lines {
		ch.AmountCents += amt
		ch.Lines = append(ch.Lines, store.ChargeLine{ConversionID: fmt.Sprintf("c%d", i), AmountCents: amt, Description: "Kyoto walk · 3D video"})
	}
	if err := s.Store.RecordCharge(context.Background(), ch); err != nil {
		t.Fatal(err)
	}
	return ch
}

// C6: the job makes the invoice, resumes after a failed step without a
// second invoice or duplicate lines, and credits a refund made before.
func TestInvoiceJobResumesAndCredits(t *testing.T) {
	s, f := invoiceService(t)
	ctx := context.Background()
	ch := recordTestCharge(t, s, 4000, 972)
	f.refunded = 972
	f.refunds = []map[string]any{{"id": "re_1", "amount": 972, "status": "succeeded"}}
	f.failAttach = true
	if s.runInvoiceJob(ctx, ch.ID) {
		t.Fatal("attach failed; must not be done")
	}
	mid, _ := s.Store.GetCharge(ctx, ch.ID)
	if mid.InvoiceState != store.InvoiceInvoicing || mid.InvoiceID != "in_1" || mid.Lease != nil || mid.InvoiceTries != 1 {
		t.Fatalf("after a failed step: %+v", mid)
	}
	f.failAttach = false
	if !s.runInvoiceJob(ctx, ch.ID) {
		t.Fatal("resume not done")
	}
	done, _ := s.Store.GetCharge(ctx, ch.ID)
	if done.InvoiceState != store.InvoiceDone || done.HostedInvoiceURL != "https://inv/in_1" || len(done.CreditNotes) != 1 {
		t.Fatalf("done: %+v", done)
	}
	if f.creates != 1 || len(f.lines["in_1"]) != 2 || f.notes != 1 {
		t.Fatalf("creates %d lines %d notes %d", f.creates, len(f.lines["in_1"]), f.notes)
	}
	if s.runInvoiceJob(ctx, ch.ID) {
		t.Fatal("a done job ran again")
	}
}

func TestInvoiceJobSkipsRefundedAndStopsOnMismatch(t *testing.T) {
	s, f := invoiceService(t)
	ctx := context.Background()
	f.refunded = 4972
	ch := recordTestCharge(t, s, 4972)
	s.runInvoiceJob(ctx, ch.ID)
	if got, _ := s.Store.GetCharge(ctx, ch.ID); got.InvoiceState != store.InvoiceSkipped || f.creates != 0 {
		t.Fatalf("refunded in full: %s, creates %d", got.InvoiceState, f.creates)
	}
	f.refunded = 0
	bad := recordTestCharge(t, s, 4000) // lines don't add up to what was taken
	s.runInvoiceJob(ctx, bad.ID)
	if got, _ := s.Store.GetCharge(ctx, bad.ID); got.InvoiceState != store.InvoiceFailed {
		t.Fatalf("mismatch: %s", got.InvoiceState)
	}
	if f.invoices["in_1"]["status"] != "draft" {
		t.Fatal("a mismatched invoice must stay a draft")
	}
}
