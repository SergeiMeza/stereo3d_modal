package mail

import (
	"strings"
	"testing"
)

func TestSignInCode(t *testing.T) {
	m := SignInCode("a@example.com", "042817")
	if m.Subject != "Spatial Video Studio: your sign-in code" || m.To != "a@example.com" {
		t.Fatalf("%+v", m)
	}
	for _, body := range []string{m.Text, m.HTML} {
		if !strings.Contains(body, "042817") || !strings.Contains(body, "10 minutes") {
			t.Fatalf("body: %q", body)
		}
		if strings.Contains(strings.ToLower(body), "firebase") || strings.Contains(strings.ToLower(body), "google") {
			t.Fatalf("names the provider: %q", body)
		}
	}
}

func TestSignInCodeChinese(t *testing.T) {
	m := SignInCodeIn("a@example.com", "042817", LangChinese)
	if !strings.Contains(m.Subject, "Spatial Video Studio") || !strings.Contains(m.Subject, "登录验证码") || m.To != "a@example.com" {
		t.Fatalf("subject %q", m.Subject)
	}
	for _, body := range []string{m.Text, m.HTML} {
		for _, want := range []string{"042817", "10 分钟", "如果不是你本人操作，请忽略此邮件。", "Spatial Video Studio"} {
			if !strings.Contains(body, want) {
				t.Fatalf("missing %q: %q", want, body)
			}
		}
		low := strings.ToLower(body)
		for _, banned := range []string{"firebase", "google", "relay", "http://", "https://", "<img", "@import", "<link"} {
			if strings.Contains(low, banned) {
				t.Fatalf("has %q: %q", banned, body)
			}
		}
	}
	if !strings.Contains(m.HTML, `lang="zh-Hans"`) {
		t.Fatal("html lang")
	}
	if en := SignInCodeIn("a@example.com", "042817", LangEnglish); en.Subject != SignInCodeSubject || en.HTML != SignInCode("a@example.com", "042817").HTML {
		t.Fatalf("english changed: %+v", en)
	}
}
