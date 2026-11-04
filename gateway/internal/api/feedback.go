package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/mail"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"cloud.google.com/go/firestore"

	"spatial-ai-labs/stereo3d-gateway/internal/httpx"
	gmail "spatial-ai-labs/stereo3d-gateway/internal/mail"
	"spatial-ai-labs/stereo3d-gateway/internal/store"
)

// POST /v1/feedback (owner 2026-11-04): the web's in-app feedback, in the
// app's store and document shape (store.FeedbackCol): kind (the app's
// names: idea → suggestion, problem, other), text, email, platform "web",
// version and build (the web commit), device (the user agent, cut to 64
// as the app's), locale, isPro, uid and revenueCatID (= uid) when signed
// in, via "gateway"; the web adds okToContact, route, projectId, runId,
// userAgent and plan. Signed out is allowed with an email. 5 an hour per
// IP and per account. The gateway claims the document (mailingAt) and
// mails it like the app's backend ("[Spatial Video Studio] Suggestion ·
// web <commit> · Pro (web)", reply-to the sender), so the backend's
// trigger skips it.

var feedbackKinds = map[string]string{"idea": "suggestion", "problem": "problem", "other": "other"}

var feedbackKindLabel = map[string]string{"suggestion": "Suggestion", "problem": "Problem report", "other": "Message"}

const (
	feedbackMax      = 5000
	feedbackPerHour  = 5
	feedbackBodySize = 32 << 10
)

func capStr(s string, n int) string {
	s = strings.TrimSpace(s)
	if utf8.RuneCountInString(s) > n {
		return string([]rune(s)[:n])
	}
	return s
}

// HandleFeedback takes user nil when signed out.
func (s *Service) HandleFeedback(w http.ResponseWriter, r *http.Request, user *AuthedUser) {
	ctx := r.Context()
	var req struct {
		Kind        string `json:"kind"`
		Message     string `json:"message"`
		Email       string `json:"email"`
		OKToContact bool   `json:"ok_to_contact"`
		Context     struct {
			Route      string `json:"route"`
			ProjectID  string `json:"project_id"`
			RunID      string `json:"run_id"`
			Locale     string `json:"locale"`
			UserAgent  string `json:"user_agent"`
			Plan       string `json:"plan"`
			IsPro      *bool  `json:"isPro"`
			AppVersion string `json:"app_version"`
		} `json:"context"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, feedbackBodySize)).Decode(&req); err != nil {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("malformed JSON body"))
		return
	}
	kind, ok := feedbackKinds[req.Kind]
	if !ok {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("kind is idea, problem or other"))
		return
	}
	text := strings.TrimSpace(req.Message)
	if text == "" || utf8.RuneCountInString(text) > feedbackMax {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("message is required, at most 5000 characters"))
		return
	}
	email := capStr(req.Email, 320)
	if email != "" {
		if a, err := mail.ParseAddress(email); err != nil || a.Address != email {
			httpx.WriteErr(ctx, w, httpx.ErrInvalid("email isn't an address"))
			return
		}
	}
	if user == nil && email == "" {
		httpx.WriteErr(ctx, w, httpx.ErrInvalid("signed out, an email is needed so we can answer"))
		return
	}
	now := time.Now().UTC()
	ipKey := "fb-ip:" + clientIP(r)
	if !eventAllowed(ipKey, feedbackPerHour, now) || (user != nil && !eventAllowed("fb-uid:"+user.UID, feedbackPerHour, now)) {
		httpx.WriteErr(ctx, w, httpx.Err(http.StatusTooManyRequests, "rate_limited", "You've sent a lot of feedback this hour. Try again later."))
		return
	}
	version := capStr(req.Context.AppVersion, 32)
	doc := map[string]any{
		"createdAt": firestore.ServerTimestamp, "via": "gateway", "platform": "web",
		"kind": kind, "text": text, "okToContact": req.OKToContact,
		"mailingAt": firestore.ServerTimestamp, // ours to mail (the backend's trigger skips it)
	}
	put := func(k, v string) {
		if v != "" {
			doc[k] = v
		}
	}
	put("email", email)
	put("version", version)
	put("build", version)
	put("device", capStr(req.Context.UserAgent, 64))
	put("userAgent", capStr(req.Context.UserAgent, 300))
	put("locale", capStr(req.Context.Locale, 32))
	put("route", capStr(req.Context.Route, 200))
	if ValidResourceID(req.Context.ProjectID) {
		doc["projectId"] = req.Context.ProjectID
	}
	if ValidResourceID(req.Context.RunID) {
		doc["runId"] = req.Context.RunID
	}
	plan, isPro := "none", false
	if user != nil {
		doc["uid"], doc["revenueCatID"] = user.UID, user.UID
		if t := s.accountTier(ctx, user.UID).Tier; t != "" {
			plan, isPro = t, true
		}
	} else if req.Context.IsPro != nil { // signed out: what the page knew
		isPro = *req.Context.IsPro
		if p := capStr(req.Context.Plan, 32); slugRE.MatchString(p) {
			plan = p
		}
	}
	doc["plan"], doc["isPro"] = plan, isPro
	coll := store.FeedbackCol(s.envName())
	id, err := s.Store.AddFeedback(ctx, coll, doc)
	if err != nil {
		httpx.WriteErr(ctx, w, err)
		return
	}
	merr := s.mailFeedback(ctx, coll, id, doc)
	if err := s.Store.MarkFeedbackMailed(ctx, coll, id, merr); err != nil {
		slog.WarnContext(ctx, "feedback mail mark failed", "id", id, "err", err)
	}
	httpx.WriteOK(w, map[string]any{"id": id})
}

func (s *Service) envName() string {
	if s.Cfg == nil {
		return "test"
	}
	return s.Cfg.Env
}

func feedbackSubject(doc map[string]any, env string) string {
	str := func(k string) string { v, _ := doc[k].(string); return v }
	parts := []string{feedbackKindLabel[str("kind")]}
	if parts[0] == "" {
		parts[0] = "Message"
	}
	v := str("version")
	if v == "" {
		v = "?"
	}
	parts = append(parts, "web "+v)
	if pro, _ := doc["isPro"].(bool); pro {
		parts = append(parts, "Pro")
	}
	subject := "[Spatial Video Studio] " + strings.Join(parts, " · ") + " (web)"
	if env != "prod" {
		subject += " (test)"
	}
	return subject
}

// mailFeedback sends it to the owner's address, reply-to the sender; the
// error, if any, is written on the document.
func (s *Service) mailFeedback(ctx context.Context, coll, id string, doc map[string]any) error {
	to := ""
	if s.Cfg != nil {
		to = s.Cfg.OwnerAlertEmail
	}
	if to == "" || !s.Mail.Configured() {
		slog.InfoContext(ctx, "feedback mail not sent (no address or key)", "id", id)
		return fmt.Errorf("mail not configured")
	}
	str := func(k string) string { v, _ := doc[k].(string); return v }
	var b strings.Builder
	b.WriteString(str("text") + "\n\n—\n")
	for _, kv := range [][2]string{{"Kind", feedbackKindLabel[str("kind")]}, {"Email", str("email")},
		{"OK to contact", strconv.FormatBool(doc["okToContact"] == true)}, {"Plan", str("plan")},
		{"Pro", map[bool]string{true: "yes", false: "no"}[doc["isPro"] == true]}, {"Web", str("version")},
		{"Page", str("route")}, {"Project", str("projectId")}, {"Run", str("runId")}, {"Locale", str("locale")},
		{"Browser", str("userAgent")}, {"User", str("uid")}, {"Document", coll + "/" + id}} {
		if kv[1] != "" {
			fmt.Fprintf(&b, "%s: %s\n", kv[0], kv[1])
		}
	}
	return s.Mail.Send(ctx, gmail.Message{To: to, Subject: feedbackSubject(doc, s.envName()), Text: b.String(), ReplyTo: str("email")})
}

// GET /v1/admin/feedback?days=30&platform=web|ios|… → {days, feedback[…],
// generated_at}: recent messages, newest first, read only: the env's own
// collection, and on test the app's app_feedback too.
func (s *Service) HandleAdminFeedback(w http.ResponseWriter, r *http.Request, a *AdminUser) {
	ctx := r.Context()
	days := 30
	if v, err := strconv.Atoi(r.URL.Query().Get("days")); err == nil && v > 0 && v <= 365 {
		days = v
	}
	platform := strings.ToLower(r.URL.Query().Get("platform"))
	since := time.Now().UTC().AddDate(0, 0, -days)
	colls := []string{store.FeedbackCol(s.envName())}
	if colls[0] != "app_feedback" {
		colls = append(colls, "app_feedback")
	}
	var rows, items []map[string]any
	for _, c := range colls {
		docs, err := s.Store.ListFeedback(ctx, c, since, 500)
		if err != nil {
			httpx.WriteErr(ctx, w, err)
			return
		}
		for _, d := range docs {
			p, _ := d["platform"].(string)
			if platform != "" && !strings.EqualFold(p, platform) {
				continue
			}
			rows = append(rows, feedbackRow(d))
			items = append(items, feedbackItem(d))
		}
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i]["created_at"].(string) > rows[j]["created_at"].(string) })
	sort.Slice(items, func(i, j int) bool { return items[i]["created_at"].(string) > items[j]["created_at"].(string) })
	if items == nil {
		items = []map[string]any{}
	}
	s.audit(ctx, a, "feedback_list", map[string]any{"days": days, "platform": platform})
	httpx.WriteOK(w, map[string]any{"days": days, "feedback": rows, "items": items, "generated_at": time.Now().UTC().Format(time.RFC3339)})
}

// feedbackRow is one message for the admin, app and web alike.
func feedbackRow(d map[string]any) map[string]any {
	out := map[string]any{}
	for _, k := range []string{"id", "collection", "platform", "kind", "rating", "text", "email", "company", "isPro", "plan",
		"version", "build", "device", "locale", "uid", "route", "projectId", "runId", "okToContact", "mailError"} {
		if v, ok := d[k]; ok {
			out[k] = v
		}
	}
	at := ""
	if t, ok := d["createdAt"].(time.Time); ok {
		at = t.UTC().Format(time.RFC3339)
	}
	out["created_at"] = at
	_, mailed := d["mailedAt"]
	out["mailed"] = mailed
	return out
}

// webKinds maps the stored kind back to the web's words for web messages.
var webKinds = map[string]string{"suggestion": "idea", "problem": "problem", "other": "other"}

// feedbackItem is one message in the web admin's shape: {platform, kind,
// message, email, ok_to_contact, app_version, context, created_at}.
func feedbackItem(d map[string]any) map[string]any {
	str := func(k string) string { v, _ := d[k].(string); return v }
	kind := str("kind")
	if str("platform") == "web" {
		if k, ok := webKinds[kind]; ok {
			kind = k
		}
	}
	ctx := map[string]any{}
	for out, in := range map[string]string{"route": "route", "project_id": "projectId", "run_id": "runId", "locale": "locale",
		"user_agent": "userAgent", "plan": "plan", "device": "device", "rating": "rating", "company": "company", "uid": "uid"} {
		if v, ok := d[in]; ok {
			ctx[out] = v
		}
	}
	if v, ok := d["isPro"]; ok {
		ctx["isPro"] = v
	}
	at := ""
	if t, ok := d["createdAt"].(time.Time); ok {
		at = t.UTC().Format(time.RFC3339)
	}
	return map[string]any{"id": str("id"), "platform": str("platform"), "kind": kind, "message": str("text"),
		"email": nilIfEmpty(str("email")), "ok_to_contact": d["okToContact"] == true, "app_version": nilIfEmpty(str("version")),
		"context": ctx, "created_at": at}
}
