// svs-admin is the owner's command line for the admin console's work
// (spec M1): cases, decisions, accounts, the disputes panel, the M3
// reconciliation and the block list. It calls the same service functions
// as /v1/admin/*, with the same audit rows, so a decision made here is the
// one the console would make.
//
//	go run ./cmd/svs-admin [-env test|prod] <command> [flags] [args]
//
// Commands:
//
//	cases [-tab open|waiting|decided|closed|all] [-q text] [-type t] [-reason r]
//	case CASE-0001
//	act CASE-0001 <action> [-items c1=100,c2=250] [-expected-max N] [-template t] [-text t] [-method m] [-reference r] [-yes]
//	open -uid U [-runs a,b] -reason R [-topup T] [-text t]   (reason plan_refund: the latest plan invoice, proposing paid × unspent ÷ credit)
//	account UID
//	account-action UID <action> [-cents N] [-case CASE-0001] [-note t] [-yes] [-prod]   (auto_reload_off needs -prod on prod)
//	account-delete UID [-balance-confirmed] [-case CASE-0001] [-note t] [-yes] [-prod]   (support's deletion request: the customer path's checks, the configured delay; -prod on prod)
//	disputes [-months 3] [-csv]
//	policy
//	mail-previews
//	reconcile [-since 48h] [-dry-run] [-yes]
//	blocklist [add|remove FINGERPRINT [-note t]]
//	emails-backfill [-dry-run] [-stripe] [-yes]   (EM-01: the email store from Firebase users and customer records; counts only)
//	revenue-backfill-plans [-apply] [-yes]   (the revenue report's plan_payments from Stripe's paid web plan invoices, for invoices before 2026-11-07; counts only without -apply)
//	rc-web-plan-backfill [-apply] [-yes]   (D14: web_plan / web_plan_renews_at for every active web plan's grant; counts only without -apply; TEST writes only allowlisted uids)
//
// Credentials: Application Default Credentials (gcloud auth
// application-default login) for Firestore and Firebase; the Stripe and
// mail keys are read from Secret Manager with gcloud when they aren't in
// the environment. Nothing secret is printed. Money actions ask for
// confirmation unless -yes is given.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"spatial-ai-labs/stereo3d-gateway/internal/api"
	"spatial-ai-labs/stereo3d-gateway/internal/app"
	"spatial-ai-labs/stereo3d-gateway/internal/config"
)

const project = "spatial-video-studio"

// needRevenueCat: the command writes to RevenueCat, so its key is loaded
// (every other command runs without it, as before).
var needRevenueCat bool

var moneyActions = map[string]bool{"approve": true, "partial": true, "waive": true, "deny": true, "mark_out_of_band": true,
	"stop_run": true, "assign": true, "no_refund": true, "write_off_owed": true, "adjust_balance": true, "block_permanent": true,
	"grant_credit": true, "auto_reload_off": true}

// prodGuarded: account changes that refuse on prod without -prod.
var prodGuarded = map[string]bool{"auto_reload_off": true, "request_deletion": true}

// prodRefusal: why a prod-guarded action can't run ("" when it can).
func prodRefusal(env, action string, prod bool) string {
	if prodGuarded[action] && env == "prod" && !prod {
		return action + " on prod needs -prod"
	}
	return ""
}

// guardProd refuses a prod-guarded action on prod unless -prod was given.
func guardProd(env, action string, prod bool) {
	if why := prodRefusal(env, action, prod); why != "" {
		fail(why)
	}
}

func main() {
	slog.SetDefault(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn})))
	env := flag.String("env", "test", "test or prod")
	flag.Usage = func() {
		fmt.Fprintln(os.Stderr, "usage: svs-admin [-env test|prod] <cases|case|act|open|account|account-action|account-delete|disputes|policy|mail-previews|reconcile|blocklist|emails-backfill|revenue-backfill-plans|rc-web-plan-backfill> …")
		flag.PrintDefaults()
	}
	flag.Parse()
	if flag.NArg() == 0 {
		flag.Usage()
		os.Exit(2)
	}
	if *env != "test" && *env != "prod" {
		fail("-env must be test or prod")
	}
	if flag.Arg(0) == "rc-web-plan-backfill" {
		needRevenueCat = true // the only command that writes to RevenueCat
	}
	if err := loadEnv(*env); err != nil {
		fail(err.Error())
	}
	cfg, err := config.Load()
	if err != nil {
		fail("config: " + err.Error())
	}
	ctx := context.Background()
	built, err := app.Build(ctx, cfg)
	if err != nil {
		fail(err.Error())
	}
	defer built.Close()
	svc := built.Svc
	who := os.Getenv("USER")
	if who == "" {
		who = "owner"
	}
	admin := &api.AdminUser{UID: "cli", Email: "cli:" + who, AuthTime: time.Now(), Method: "cli"} // the operator's own credentials

	cmd, args := flag.Arg(0), flag.Args()[1:]
	switch cmd {
	case "cases":
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		tab := fs.String("tab", "open", "open|waiting|decided|closed|all")
		q := fs.String("q", "", "search: case id, email, run id, pi_…, re_…")
		typ := fs.String("type", "", "case type")
		reason := fs.String("reason", "", "reason")
		fs.Parse(args)
		qs := fmt.Sprintf("?tab=%s&q=%s&type=%s&reason=%s", *tab, *q, *typ, *reason)
		run(func(w http.ResponseWriter, r *http.Request) { svc.HandleAdminCases(w, r, admin) }, "GET", "/v1/admin/cases"+qs, nil)
	case "case":
		id := need(args, 0, "case id")
		run(func(w http.ResponseWriter, r *http.Request) { svc.HandleAdminCase(w, r, admin, id) }, "GET", "/", nil)
	case "act":
		id, action := need(args, 0, "case id"), need(args, 1, "action")
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		items := fs.String("items", "", "cents per run: c1=100,c2=250")
		expected := fs.Int64("expected-max", -1, "the maximum you saw (409 amount_changed if it moved)")
		template := fs.String("template", "", "deny: delivered|outside_terms|other")
		text := fs.String("text", "", "text for the customer or the note")
		method := fs.String("method", "", "out of band: how the money went back")
		reference := fs.String("reference", "", "out of band: its reference")
		yes := fs.Bool("yes", false, "don't ask before money actions")
		fs.Parse(args[2:])
		body := map[string]any{"action": action, "template": *template, "text": *text, "method": *method, "reference": *reference}
		if *items != "" {
			body["items"] = parseItems(*items)
		}
		if *expected >= 0 {
			body["expected_max_cents"] = *expected
		}
		if moneyActions[action] {
			confirm(*yes, fmt.Sprintf("%s on %s (%s) in %s", action, id, *items, *env))
		}
		run(func(w http.ResponseWriter, r *http.Request) { svc.HandleAdminCaseAction(w, r, admin, id) }, "POST", "/", body)
	case "open":
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		uid := fs.String("uid", "", "account uid")
		runs := fs.String("runs", "", "conversion ids, comma-separated")
		reason := fs.String("reason", "", "refund reason (e.g. quality_complaint, topup_withdrawal, closure_balance)")
		topup := fs.String("topup", "", "top-up id (topup_withdrawal)")
		text := fs.String("text", "", "the customer's words")
		fs.Parse(args)
		body := map[string]any{"uid": *uid, "conversion_ids": splitList(*runs), "reason": *reason, "topup_id": *topup, "text": *text}
		run(func(w http.ResponseWriter, r *http.Request) { svc.HandleAdminOpenCase(w, r, admin) }, "POST", "/", body)
	case "account":
		uid := need(args, 0, "uid")
		run(func(w http.ResponseWriter, r *http.Request) { svc.HandleAdminAccount(w, r, admin, uid) }, "GET", "/", nil)
	case "account-action":
		uid, action := need(args, 0, "uid"), need(args, 1, "action")
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		cents := fs.Int64("cents", 0, "adjust_balance: cents (negative takes away)")
		caseID := fs.String("case", "", "adjust_balance: the case it belongs to")
		note := fs.String("note", "", "note")
		yes := fs.Bool("yes", false, "don't ask before money actions")
		prod := fs.Bool("prod", false, "allow auto_reload_off on prod")
		fs.Parse(args[2:])
		guardProd(*env, action, *prod)
		if action == "request_deletion" {
			fail("use account-delete UID [-balance-confirmed]")
		}
		if moneyActions[action] {
			confirm(*yes, fmt.Sprintf("%s on account %s (%d cents) in %s", action, uid, *cents, *env))
		}
		body := map[string]any{"action": action, "cents": *cents, "case_id": *caseID, "note": *note}
		run(func(w http.ResponseWriter, r *http.Request) { svc.HandleAdminAccountAction(w, r, admin, uid) }, "POST", "/", body)
	case "account-delete":
		uid := need(args, 0, "uid")
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		balance := fs.Bool("balance-confirmed", false, "the person gives up a cash balance (refunded through its closure case)")
		caseID := fs.String("case", "", "the support case it belongs to")
		note := fs.String("note", "", "note")
		yes := fs.Bool("yes", false, "don't ask")
		prod := fs.Bool("prod", false, "allow it on prod")
		fs.Parse(args[1:])
		guardProd(*env, "request_deletion", *prod)
		confirm(*yes, fmt.Sprintf("request the deletion of account %s in %s (balance confirmed: %v)", uid, *env, *balance))
		body := map[string]any{"action": "request_deletion", "balance_confirmed": *balance, "case_id": *caseID, "note": *note}
		run(func(w http.ResponseWriter, r *http.Request) { svc.HandleAdminAccountAction(w, r, admin, uid) }, "POST", "/", body)
	case "disputes":
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		months := fs.Int("months", 3, "months back")
		csv := fs.Bool("csv", false, "CSV")
		fs.Parse(args)
		qs := "?months=" + strconv.Itoa(*months)
		if *csv {
			qs += "&format=csv"
		}
		run(func(w http.ResponseWriter, r *http.Request) { svc.HandleAdminDisputes(w, r, admin) }, "GET", "/v1/admin/disputes/summary"+qs, nil)
	case "policy":
		run(func(w http.ResponseWriter, r *http.Request) { svc.HandleAdminPolicy(w, r, admin) }, "GET", "/", nil)
	case "mail-previews":
		run(func(w http.ResponseWriter, r *http.Request) { svc.HandleAdminMailPreviews(w, r, admin) }, "GET", "/", nil)
	case "reconcile":
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		since := fs.Duration("since", 48*time.Hour, "how far back to search PaymentIntents")
		dry := fs.Bool("dry-run", false, "report only: no refunds, no replays, no retention deletes")
		yes := fs.Bool("yes", false, "don't ask (a real run can refund)")
		fs.Parse(args)
		if !*dry {
			confirm(*yes, fmt.Sprintf("M3 reconciliation in %s since %s (it can refund)", *env, *since))
		}
		body := map[string]any{"since_hours": int(since.Hours() + 0.5), "dry_run": *dry}
		run(func(w http.ResponseWriter, r *http.Request) { svc.HandleAdminReconcile(w, r, admin) }, "POST", "/", body)
	case "blocklist":
		if len(args) == 0 {
			run(func(w http.ResponseWriter, r *http.Request) { svc.HandleAdminBlocklist(w, r, admin) }, "GET", "/", nil)
			return
		}
		action, fp := need(args, 0, "add|remove"), need(args, 1, "fingerprint")
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		note := fs.String("note", "", "why")
		fs.Parse(args[2:])
		run(func(w http.ResponseWriter, r *http.Request) { svc.HandleAdminBlocklist(w, r, admin) }, "POST", "/",
			map[string]any{"action": action, "fingerprint": fp, "note": *note})
	case "emails-backfill":
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		dry := fs.Bool("dry-run", false, "count only: nothing written")
		withStripe := fs.Bool("stripe", false, "live: also set plan accounts' Stripe customer email to the main one")
		yes := fs.Bool("yes", false, "don't ask before a live run")
		fs.Parse(args)
		if svc.Auth == nil {
			fail("Firebase Auth isn't configured")
		}
		if !*dry {
			what := "write account_emails_" + *env
			if *withStripe {
				what += " and the Stripe customer emails of plan accounts"
			}
			confirm(*yes, "EM-01 backfill: "+what)
		}
		res, err := svc.BackfillAccountEmails(ctx, svc.Auth.EachUser, !*dry, *withStripe && !*dry)
		b, _ := json.MarshalIndent(res, "", "  ")
		fmt.Println(string(b))
		if err != nil {
			fail("backfill stopped: " + err.Error())
		}
	case "revenue-backfill-plans":
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		apply := fs.Bool("apply", false, "record them (without it: count only)")
		yes := fs.Bool("yes", false, "don't ask before writing")
		fs.Parse(args)
		if *apply {
			confirm(*yes, "record paid web plan invoices from Stripe into plan_payments_"+*env)
		}
		res, err := svc.BackfillPlanPayments(ctx, *apply)
		b, _ := json.MarshalIndent(res, "", "  ")
		fmt.Println(string(b))
		if err != nil {
			fail("backfill stopped: " + err.Error())
		}
	case "rc-web-plan-backfill":
		fs := flag.NewFlagSet(cmd, flag.ExitOnError)
		apply := fs.Bool("apply", false, "write the attributes (without it: count only)")
		yes := fs.Bool("yes", false, "don't ask before writing")
		fs.Parse(args)
		if *apply {
			confirm(*yes, "D14 backfill: write web_plan / web_plan_renews_at to RevenueCat for every active web plan on "+*env)
		}
		res, err := svc.BackfillWebPlanMarkers(ctx, *apply)
		if err != nil {
			fail("backfill: " + err.Error())
		}
		b, _ := json.MarshalIndent(res, "", "  ")
		fmt.Println(string(b))
	default:
		flag.Usage()
		os.Exit(2)
	}
}

// run calls a handler in process and prints its answer.
func run(h http.HandlerFunc, method, target string, body any) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req := httptest.NewRequest(method, target, rd)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	rec := httptest.NewRecorder()
	h(rec, req.WithContext(ctx))
	out := rec.Body.Bytes()
	if strings.HasPrefix(rec.Header().Get("Content-Type"), "application/json") {
		var v any
		if json.Unmarshal(out, &v) == nil {
			out, _ = json.MarshalIndent(v, "", "  ")
		}
	}
	os.Stdout.Write(out)
	fmt.Println()
	if rec.Code >= 300 {
		fmt.Fprintf(os.Stderr, "HTTP %d\n", rec.Code)
		os.Exit(1)
	}
}

// loadEnv fills what the gateway config needs: the env, the project, and
// the secrets from Secret Manager (read with gcloud, never printed).
func loadEnv(env string) error {
	set := func(k, v string) {
		if os.Getenv(k) == "" {
			os.Setenv(k, v)
		}
	}
	set("APP_ENV", env)
	set("GCP_PROJECT_ID", project)
	set("MODAL_BASE_URL", fmt.Sprintf("https://stereo-crafter-%s--stereo3d-api-%s.modal.run", env, env)) // not called by admin work
	set("LIFELIKE_BASE_URL", "off")
	for k, secret := range map[string]string{
		"STRIPE_SECRET_KEY": "stripe-secret-key-" + env,
		"RESEND_API_KEY":    "RESEND_API_KEY",
		"SLACK_WEBHOOK_URL": "slack-webhook",
		"RECONCILE_TOKEN":   "reconcile-token-" + env,
		"RC_API_KEY_V1":     map[bool]string{true: "RC_API_KEY_V1"}[needRevenueCat],
	} {
		if secret == "" {
			continue
		}
		if os.Getenv(k) != "" {
			continue
		}
		out, err := exec.Command("gcloud", "secrets", "versions", "access", "latest", "--secret="+secret, "--project="+project).Output()
		if err != nil {
			if k == "STRIPE_SECRET_KEY" {
				return fmt.Errorf("couldn't read %s from Secret Manager (gcloud auth login?)", secret)
			}
			continue // optional: mail and Slack stay off
		}
		os.Setenv(k, strings.TrimSpace(string(out)))
	}
	return nil
}

func confirm(yes bool, what string) {
	if yes {
		return
	}
	fmt.Fprintf(os.Stderr, "%s. Type yes to go on: ", what)
	line, _ := bufio.NewReader(os.Stdin).ReadString('\n')
	if strings.TrimSpace(line) != "yes" {
		fail("stopped")
	}
}

func parseItems(s string) map[string]int64 {
	out := map[string]int64{}
	for _, part := range splitList(s) {
		k, v, ok := strings.Cut(part, "=")
		n, err := strconv.ParseInt(strings.TrimSpace(v), 10, 64)
		if !ok || err != nil {
			fail("items are run=cents, e.g. c1=100,c2=250")
		}
		out[strings.TrimSpace(k)] = n
	}
	return out
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func need(args []string, i int, what string) string {
	if len(args) <= i || strings.HasPrefix(args[i], "-") {
		fail("missing " + what)
	}
	return args[i]
}

func fail(msg string) {
	fmt.Fprintln(os.Stderr, "svs-admin: "+msg)
	os.Exit(1)
}
