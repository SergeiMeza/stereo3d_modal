package main

import "testing"

// account-delete (request_deletion) and auto_reload_off refuse on prod
// without -prod; on test they run; other actions are untouched.
func TestProdGuard(t *testing.T) {
	for _, c := range []struct {
		env, action string
		prod        bool
		refused     bool
	}{
		{"prod", "request_deletion", false, true},
		{"prod", "auto_reload_off", false, true},
		{"prod", "request_deletion", true, false},
		{"prod", "auto_reload_off", true, false},
		{"test", "request_deletion", false, false},
		{"test", "auto_reload_off", false, false},
		{"prod", "write_off_owed", false, false},
	} {
		if got := prodRefusal(c.env, c.action, c.prod) != ""; got != c.refused {
			t.Errorf("%s %s -prod=%v: refused %v, want %v", c.env, c.action, c.prod, got, c.refused)
		}
	}
}
