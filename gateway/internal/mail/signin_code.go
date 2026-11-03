package mail

import "html"

// SignInCodeSubject names the app, as every user mail does (S3D-70).
const SignInCodeSubject = "Spatial Video Studio: your sign-in code"

// SignInCode is the one-time sign-in code email. Short: the code first,
// how long it lasts, and what to do if it wasn't you.
func SignInCode(to, code string) Message {
	text := "Your Spatial Video Studio sign-in code:\n\n" +
		code + "\n\n" +
		"It expires in 10 minutes. If you didn't ask for it, ignore this email; " +
		"nobody can sign in without the code.\n\n" +
		"Spatial Video Studio\n"
	c := html.EscapeString(code)
	htmlBody := "<p>Your Spatial Video Studio sign-in code:</p>" +
		`<p style="font-size:32px;font-weight:600;letter-spacing:8px;font-family:ui-monospace,Menlo,monospace;margin:16px 0">` +
		c + "</p>" +
		`<p style="color:#666;font-size:13px">It expires in 10 minutes. If you didn't ask for it, ` +
		"ignore this email; nobody can sign in without the code.</p>" +
		"<p>Spatial Video Studio</p>"
	return Message{To: to, Subject: SignInCodeSubject, Text: text, HTML: htmlBody}
}
