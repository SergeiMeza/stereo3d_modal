package emailcode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"strings"
	"testing"
	"time"
)

// qaRig is a rig whose service logs to a buffer, in env with the switch
// as main.go sets it.
func qaRig(env, switchValue string) (*rig, *bytes.Buffer) {
	r := newRig()
	var buf bytes.Buffer
	r.svc.Log = slog.New(slog.NewJSONHandler(&buf, nil))
	r.svc.Env, r.svc.LogQACodes = env, QALogAllowed(env, switchValue)
	return r, &buf
}

func qaLines(t *testing.T, buf *bytes.Buffer) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, l := range strings.Split(strings.TrimSpace(buf.String()), "\n") {
		if l == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(l), &m); err != nil {
			t.Fatalf("log line %q: %v", l, err)
		}
		if m["msg"] == "qa signin code" {
			out = append(out, m)
		}
	}
	return out
}

func TestQAAgentAddress(t *testing.T) {
	for addr, want := range map[string]bool{
		"qa-agent+x@lpp.pw": true, "qa-agent+run.1_a-b@lpp.pw": true, " QA-AGENT+X@LPP.PW ": true,
		"qa-agent@lpp.pw": false, "qa-agent+@lpp.pw": false, "qa-agent+x@lpp.pw.evil.com": false, "x+qa-agent+y@lpp.pw": false,
		"qa-agent+x@lpp.pw\n": true, "qa-agent+x@lpp.pwx": false, "qa-agent+x@sub.lpp.pw": false, "qa-agent+x+y@lpp.pw": false,
		"qa-agent+x@lppxpw": false, "qa-agent+x y@lpp.pw": false, "qa_agent+x@lpp.pw": false, "sergei@lpp.pw": false,
	} {
		if got := IsQAAgent(addr); got != want {
			t.Errorf("%q: %v", addr, got)
		}
	}
}

func TestQALogGate(t *testing.T) {
	for _, c := range []struct {
		env, sw string
		want    bool
	}{
		{"test", "1", true}, {"test", " 1 ", true}, {"test", "", false}, {"test", "0", false}, {"test", "true", false},
		{"prod", "1", false}, {"prod", "", false}, {"", "1", false}, {"Test", "1", false},
	} {
		if got := QALogAllowed(c.env, c.sw); got != c.want {
			t.Errorf("%q %q: %v", c.env, c.sw, got)
		}
	}
	// a service told to log in prod still never does
	r, buf := qaRig("prod", "1")
	r.svc.LogQACodes = true
	if _, err := r.svc.Start(context.Background(), "qa-agent+x@lpp.pw"); err != nil {
		t.Fatal(err)
	}
	if len(qaLines(t, buf)) != 0 {
		t.Fatal("prod logged a code")
	}
}

func TestQASigninCodeLog(t *testing.T) {
	ctx := context.Background()
	// prod with the switch, test without it: never
	for _, c := range [][2]string{{"prod", "1"}, {"test", ""}} {
		r, buf := qaRig(c[0], c[1])
		if _, err := r.svc.Start(ctx, "qa-agent+x@lpp.pw"); err != nil || len(r.mail.sent) != 1 {
			t.Fatalf("%v: %v", c, err)
		}
		if n := len(qaLines(t, buf)); n != 0 {
			t.Fatalf("%v: %d lines", c, n)
		}
	}
	// test with the switch: only QA agents' addresses
	r, buf := qaRig("test", "1")
	for _, addr := range []string{"qa-agent@lpp.pw", "qa-agent+x@lpp.pw.evil.com", "x+qa-agent+y@lpp.pw", "someone@example.com"} {
		if _, err := r.svc.Start(ctx, addr); err != nil {
			t.Fatalf("%s: %v", addr, err)
		}
	}
	if n := len(qaLines(t, buf)); n != 0 {
		t.Fatalf("non-matching addresses logged %d", n)
	}
	// a match logs once per code sent, the code and the address only
	r.code = "654321"
	if _, err := r.svc.Start(ctx, "QA-AGENT+X@LPP.PW"); err != nil {
		t.Fatal(err)
	}
	lines := qaLines(t, buf)
	if len(lines) != 1 || lines[0]["qa_code"] != "654321" || lines[0]["email"] != "qa-agent+x@lpp.pw" || lines[0]["level"] != "INFO" {
		t.Fatalf("lines %v", lines)
	}
	for k := range lines[0] {
		if k != "time" && k != "level" && k != "msg" && k != "qa_code" && k != "email" {
			t.Fatalf("extra field %q", k)
		}
	}
	// the per-address limits still apply: a resend too soon is refused
	// and logs nothing
	var wait *WaitError
	if _, err := r.svc.Start(ctx, "QA-AGENT+X@LPP.PW"); !errors.As(err, &wait) {
		t.Fatalf("resend too soon: %v", err)
	}
	if n := len(qaLines(t, buf)); n != 1 {
		t.Fatalf("refused send logged: %d", n)
	}
	// after the gap, a new code: one more line
	r.now = r.now.Add(ResendGap + time.Second)
	r.code = "111222"
	if _, err := r.svc.Start(ctx, "QA-AGENT+X@LPP.PW"); err != nil {
		t.Fatal(err)
	}
	if lines = qaLines(t, buf); len(lines) != 2 || lines[1]["qa_code"] != "111222" {
		t.Fatalf("second code %v", lines)
	}
	// a send whose mail fails isn't a code sent: nothing logged
	r.now = r.now.Add(ResendGap + time.Second)
	r.mail.err = errors.New("down")
	r.svc.Start(ctx, "QA-AGENT+X@LPP.PW")
	if n := len(qaLines(t, buf)); n != 2 {
		t.Fatalf("failed mail logged: %d", n)
	}
}
