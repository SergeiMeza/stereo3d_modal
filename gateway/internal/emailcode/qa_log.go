package emailcode

import (
	"context"
	"log/slog"
	"regexp"
	"strings"
)

// QA sign-in codes (owner 2026-11-07, TEST only): QA agents sign in with
// email codes and read them from the TEST gateway's log instead of the
// owner relaying them. Only addresses qa-agent+<tag>@lpp.pw, only with
// APP_ENV=test and QA_LOG_SIGNIN_CODES=1 together; prod never logs one,
// whatever its env says.

// QALogSwitch is the env var that turns it on (set only by the TEST deploy).
const QALogSwitch = "QA_LOG_SIGNIN_CODES"

// qaAgentEmail: the only addresses whose codes may be logged.
var qaAgentEmail = regexp.MustCompile(`^qa-agent\+[a-z0-9._-]+@lpp\.pw$`)

// IsQAAgent: email, lowercased and trimmed, is a QA agent's address.
func IsQAAgent(email string) bool {
	return qaAgentEmail.MatchString(strings.ToLower(strings.TrimSpace(email)))
}

// QALogAllowed: both the test environment and the switch at exactly "1".
// Prod is refused even with the switch set.
func QALogAllowed(env, switchValue string) bool {
	return env == "test" && strings.TrimSpace(switchValue) == "1"
}

// logQACode writes the one "qa signin code" line for a code just mailed
// to a QA agent's address: the code and the address, nothing else.
func (s *Service) logQACode(ctx context.Context, email, code string) {
	if !s.LogQACodes || !QALogAllowed(s.Env, "1") || !IsQAAgent(email) {
		return
	}
	l := s.Log
	if l == nil {
		l = slog.Default()
	}
	l.InfoContext(ctx, "qa signin code", "qa_code", code, "email", strings.ToLower(strings.TrimSpace(email)))
}
