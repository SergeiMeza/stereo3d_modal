package auth

import "testing"

func TestOOBCode(t *testing.T) {
	code, err := OOBCode("https://example.firebaseapp.com/__/auth/action?mode=resetPassword&oobCode=AbC-12_x&apiKey=k&lang=en")
	if err != nil || code != "AbC-12_x" {
		t.Fatalf("got %q %v", code, err)
	}
	for _, bad := range []string{"https://example.com/action?mode=resetPassword", "::not a url"} {
		if _, err := OOBCode(bad); err == nil {
			t.Errorf("%q: want error", bad)
		}
	}
}
