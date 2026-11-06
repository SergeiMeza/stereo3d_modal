package mail

import (
	"html"
	"strconv"
)

// SignInCodeSubject names the app, as every user mail does (S3D-70).
const SignInCodeSubject = "Spatial Video Studio: your sign-in code"

// Lang is a mail's language.
type Lang string

const (
	LangEnglish Lang = "en"
	// LangChinese is Simplified Chinese (zh-Hans), for China mode
	// (owner 2026-11-06).
	LangChinese Lang = "zh-Hans"
)

// codeMinutes: the codes last 10 minutes (emailcode.CodeTTL).
const codeMinutes = 10

// signInCodeStyle: the code's own line, the same in every language.
const signInCodeStyle = `font-size:32px;font-weight:600;letter-spacing:8px;font-family:ui-monospace,Menlo,Consolas,monospace;margin:16px 0`

// SignInCode is the one-time sign-in code email in English.
func SignInCode(to, code string) Message { return SignInCodeIn(to, code, LangEnglish) }

// SignInCodeIn is the one-time sign-in code email in lang. Short: the code
// first, how long it lasts, and what to do if it wasn't you. No images,
// fonts or links (nothing a mailbox in China would have to fetch); the
// system's own fonts.
func SignInCodeIn(to, code string, lang Lang) Message {
	c := html.EscapeString(code)
	mins := strconv.Itoa(codeMinutes)
	if lang == LangChinese {
		text := "你的 Spatial Video Studio 登录验证码：\n\n" +
			code + "\n\n" +
			"验证码 " + mins + " 分钟内有效，请勿告诉他人。如果不是你本人操作，请忽略此邮件。\n\n" +
			"Spatial Video Studio\n"
		htmlBody := `<div lang="zh-Hans" style="font-family:-apple-system,'PingFang SC','Hiragino Sans GB','Microsoft YaHei','Noto Sans CJK SC',sans-serif">` +
			"<p>你的 Spatial Video Studio 登录验证码：</p>" +
			`<p style="` + signInCodeStyle + `">` + c + "</p>" +
			`<p style="color:#666;font-size:13px">验证码 ` + mins + ` 分钟内有效，请勿告诉他人。` +
			"如果不是你本人操作，请忽略此邮件。</p>" +
			"<p>Spatial Video Studio</p></div>"
		return Message{To: to, Subject: "Spatial Video Studio 登录验证码：" + code, Text: text, HTML: htmlBody}
	}
	text := "Your Spatial Video Studio sign-in code:\n\n" +
		code + "\n\n" +
		"It expires in " + mins + " minutes. If you didn't ask for it, ignore this email; " +
		"nobody can sign in without the code.\n\n" +
		"Spatial Video Studio\n"
	htmlBody := "<p>Your Spatial Video Studio sign-in code:</p>" +
		`<p style="` + signInCodeStyle + `">` + c + "</p>" +
		`<p style="color:#666;font-size:13px">It expires in ` + mins + ` minutes. If you didn't ask for it, ` +
		"ignore this email; nobody can sign in without the code.</p>" +
		"<p>Spatial Video Studio</p>"
	return Message{To: to, Subject: SignInCodeSubject, Text: text, HTML: htmlBody}
}
