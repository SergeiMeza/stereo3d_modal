package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/config"
	"spatial-ai-labs/stereo3d-gateway/internal/pricing"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

func TestFeedback(t *testing.T) {
	s, _ := e0Service(t)
	ctx := context.Background()
	s.Cfg = &config.Config{Env: "test"}
	s.Pricing = pricing.NewStatic(pricing.DefaultsFor("test"))
	uid := "u" + store.NewID()
	post := func(user *AuthedUser, ip, body string) (int, map[string]any) {
		return callJSON(t, func(w http.ResponseWriter, r *http.Request) {
			r.RemoteAddr = ip + ":1234"
			s.HandleFeedback(w, r, user)
		}, "POST", body)
	}
	for _, bad := range []string{`{"kind":"rant","message":"x"}`, `{"kind":"idea","message":""}`,
		`{"kind":"idea","message":"` + strings.Repeat("a", 5001) + `"}`, `{"kind":"idea","message":"x","email":"nope"}`} {
		if code, _ := post(&AuthedUser{UID: uid}, "10.0.0.1", bad); code != 400 {
			t.Fatalf("%.50s: %d", bad, code)
		}
	}
	if code, _ := post(nil, "10.0.0.2", `{"kind":"idea","message":"hi"}`); code != 400 {
		t.Fatal("signed out without email")
	}
	code, out := post(&AuthedUser{UID: uid}, "10.0.0.3", `{"kind":"idea","message":"Make 8K faster","ok_to_contact":true,
		"context":{"route":"/projects/abc","project_id":"0123456789ab","run_id":"bad id","locale":"ja","user_agent":"Mozilla/5.0","plan":"studio","isPro":true,"app_version":"28d7aab"}}`)
	if code != 200 || out["id"] == "" {
		t.Fatalf("signed in %d %v", code, out)
	}
	docs, _ := s.Store.ListFeedback(ctx, "app_feedback_test", time.Now().Add(-time.Minute), 50)
	var d map[string]any
	for _, x := range docs {
		if x["id"] == out["id"] {
			d = x
		}
	}
	if d == nil || d["platform"] != "web" || d["kind"] != "suggestion" || d["text"] != "Make 8K faster" || d["uid"] != uid ||
		d["revenueCatID"] != uid || d["version"] != "28d7aab" || d["projectId"] != "0123456789ab" || d["runId"] != nil ||
		d["plan"] != "none" || d["isPro"] != false || d["okToContact"] != true || d["via"] != "gateway" || d["mailingAt"] == nil {
		t.Fatalf("doc %v", d)
	}
	// signed out with an email; the page's plan is taken then
	if code, _ := post(nil, "10.0.0.4", `{"kind":"problem","message":"Upload stalls","email":"ann@example.com","context":{"isPro":true,"plan":"pro"}}`); code != 200 {
		t.Fatalf("signed out %d", code)
	}
	// 5 an hour per IP
	n := 0
	for ; n < 10; n++ {
		if code, _ := post(nil, "10.0.0.9", `{"kind":"other","message":"x","email":"b@example.com"}`); code == 429 {
			break
		}
	}
	if n != feedbackPerHour {
		t.Fatalf("ip limit after %d", n)
	}
	if got := feedbackSubject(map[string]any{"kind": "suggestion", "version": "28d7aab", "isPro": true}, "test"); got != "[Spatial Video Studio] Suggestion · web 28d7aab · Pro (web) (test)" {
		t.Fatalf("subject %q", got)
	}
	if store.FeedbackCol("prod") != "app_feedback" || store.FeedbackCol("test") != "app_feedback_test" {
		t.Fatal("collections")
	}
	// admin: newest first, platform filter
	rec := httptest.NewRecorder()
	s.HandleAdminFeedback(rec, httptest.NewRequest("GET", "/?days=1&platform=web", nil), &AdminUser{Email: "a@x"})
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "Make 8K faster") || !strings.Contains(rec.Body.String(), `"platform":"web"`) ||
		!strings.Contains(rec.Body.String(), `"message":"Make 8K faster"`) || !strings.Contains(rec.Body.String(), `"kind":"idea"`) ||
		!strings.Contains(rec.Body.String(), `"ok_to_contact":true`) || !strings.Contains(rec.Body.String(), `"app_version":"28d7aab"`) {
		t.Fatalf("admin %d %.300s", rec.Code, rec.Body)
	}
}
