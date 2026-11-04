package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

type projCaller struct {
	t    *testing.T
	s    *Service
	user *AuthedUser
}

func (c projCaller) do(h func(http.ResponseWriter, *http.Request, *AuthedUser, string), id, body string) (int, string) {
	c.t.Helper()
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest("POST", "/", strings.NewReader(body)), c.user, id)
	return rec.Code, rec.Body.String()
}

func (c projCaller) list(q string) []map[string]any {
	c.t.Helper()
	rec := httptest.NewRecorder()
	c.s.HandleListProjects(rec, httptest.NewRequest("GET", "/v1/projects"+q, nil), c.user)
	var out struct {
		Projects []map[string]any `json:"projects"`
	}
	json.Unmarshal(rec.Body.Bytes(), &out)
	return out.Projects
}

// Delete only after archive; never mid-run.
func TestDeleteNeedsArchive(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	c := projCaller{t, s, &AuthedUser{UID: uid}}
	busy, idle := &store.Project{ID: store.NewID(), UID: uid}, &store.Project{ID: store.NewID(), UID: uid}
	s.Store.CreateProject(ctx, busy)
	s.Store.CreateProject(ctx, idle)
	s.Store.CreateConversion(ctx, &store.Conversion{ID: store.NewID(), UID: uid, ProjectID: busy.ID, Kind: "video", State: store.StateProcessing})

	if code, body := c.do(s.HandleDeleteProject, busy.ID, ""); code != 409 || !strings.Contains(body, "project_not_archived") ||
		!strings.Contains(body, "Archive the project first, then delete it.") {
		t.Fatalf("delete active %d %s", code, body)
	}
	if code, body := c.do(s.HandleArchiveProject, busy.ID, ""); code != 409 || !strings.Contains(body, "project_has_active_run") {
		t.Fatalf("archive mid-run %d %s", code, body)
	}
	if code, body := c.do(s.HandleUpdateProject, busy.ID, `{"archived":true}`); code != 409 || !strings.Contains(body, "project_has_active_run") {
		t.Fatalf("patch archive mid-run %d %s", code, body)
	}
	// archive → unarchive → archive → delete
	if code, _ := c.do(s.HandleArchiveProject, idle.ID, ""); code != 200 {
		t.Fatal("archive")
	}
	if code, _ := c.do(s.HandleUpdateProject, idle.ID, `{"archived":false}`); code != 200 {
		t.Fatal("unarchive")
	}
	if code, body := c.do(s.HandleDeleteProject, idle.ID, ""); code != 409 || !strings.Contains(body, "project_not_archived") {
		t.Fatalf("delete after unarchive %d %s", code, body)
	}
	c.do(s.HandleUpdateProject, idle.ID, `{"archived":true}`)
	if code, body := c.do(s.HandleDeleteProject, idle.ID, ""); code != 200 || !strings.Contains(body, `"deleted":true`) {
		t.Fatalf("delete archived %d %s", code, body)
	}
	// Account deletion doesn't go through the route: it ends with the
	// active project untouched by these checks.
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	if err := s.finishAccountDeletion(ctx, uid); err != nil {
		t.Fatal(err)
	}
	if cu, _ := s.Store.GetCustomer(ctx, uid); !cu.AccountDeleted {
		t.Fatal("account not deleted")
	}
}

// The sample: archivable, never deletable; restored when it went missing,
// archived if it was; account deletion takes it.
func TestSampleLifecycle(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	c := projCaller{t, s, &AuthedUser{UID: uid}}
	ps := c.list("")
	id := ps[0]["project_id"].(string)
	if code, body := c.do(s.HandleDeleteProject, id, ""); code != 409 || !strings.Contains(body, "sample_not_deletable") ||
		!strings.Contains(body, "The sample can't be deleted. You can archive it.") {
		t.Fatalf("delete sample %d %s", code, body)
	}
	c.do(s.HandleArchiveProject, id, "")
	if code, body := c.do(s.HandleDeleteProject, id, ""); code != 409 || !strings.Contains(body, "sample_not_deletable") {
		t.Fatalf("delete archived sample %d %s", code, body)
	}
	if len(c.list("")) != 0 || len(c.list("?archived=1")) != 1 {
		t.Fatal("archived sample stays archived")
	}
	c.do(s.HandleUpdateProject, id, `{"archived":false}`)
	if len(c.list("")) != 1 {
		t.Fatal("unarchived")
	}
	// deleted under the earlier rule: back on the next list, as it was
	s.Store.UpdateProject(ctx, id, func(p *store.Project) error { p.Deleted, p.Archived = true, true; return nil })
	if len(c.list("?archived=1")) != 1 {
		t.Fatal("restored archived")
	}
	s.Store.UpdateProject(ctx, id, func(p *store.Project) error { p.Archived = false; return nil })
	if ps := c.list(""); len(ps) != 1 || ps[0]["project_id"] != id {
		t.Fatalf("restored %v", ps)
	}

	// an account from before the cutoff with an old smp… sample, archived
	old := "u" + store.NewID()
	s.Store.PutCustomer(ctx, old, &store.Customer{StripeCustomerID: "cus_2", CreatedAt: sampleSince.Add(-time.Hour)})
	s.Store.CreateProject(ctx, &store.Project{ID: "smp" + store.NewID()[:9], UID: old, Sample: true, Archived: true})
	oc := projCaller{t, s, &AuthedUser{UID: old}}
	if len(oc.list("")) != 0 {
		t.Fatal("archived legacy came back active")
	}
	if ps := oc.list("?archived=1"); len(ps) != 1 || ps[0]["project_id"] != sampleProjectID(old) {
		t.Fatalf("legacy archived %v", ps)
	}
	rec := httptest.NewRecorder()
	s.HandleGetConversion(rec, httptest.NewRequest("GET", "/", nil), &AuthedUser{UID: old}, sampleRunID(old))
	if rec.Code != 200 {
		t.Fatalf("restored run %d", rec.Code)
	}

	// account deletion takes the sample, and it doesn't come back
	s.Store.PutCustomer(ctx, uid, &store.Customer{StripeCustomerID: "cus_1"})
	if err := s.finishAccountDeletion(ctx, uid); err != nil {
		t.Fatal(err)
	}
	if p, _ := s.Store.GetProject(ctx, id); !p.Deleted {
		t.Fatal("sample kept after account deletion")
	}
	if len(c.list("")) != 0 {
		t.Fatal("restored after account deletion")
	}
}
