package mail

import (
	"bytes"
	"html"
	"net/url"
	"strings"
	"text/template"
)

// The one branded layout every customer mail uses (owner 2026-11-08): the
// app icon and name, a title, a short body, at most one button (with a
// short fallback link under it, never a raw URL in the HTML), a details
// table for amounts, small print, and a footer with help, the legal
// entity and why the mail came. Table layout and inline styles for
// Gmail and Outlook (a VML button), a <style> block only for what
// supports it (dark mode, narrow screens), system fonts only. Text is the
// plain-text alternative of the same content.

const (
	// LogoURL is the app icon the web serves (256 px, shown at 40).
	LogoURL = "https://www.stereo3d.studio/brand/app-icon.png"
	// LegalEntity names who makes the app, as the web's footer does.
	LegalEntity = "Spatial AI Labs Ltd"
	// SupportEmail is the help address and every customer mail's reply-to.
	SupportEmail = "support@spatial-ai-labs.com"
	// SubjectSuffix ends every customer mail subject (the owner's rule:
	// subjects name the app).
	SubjectSuffix = " · Spatial Video Studio"
	// SubjectMax is the most a subject may say before SubjectSuffix.
	SubjectMax = 45
)

// Row is one line of a mail's details table.
type Row struct {
	Label string
	Value string
	Href  string // optional: the value links here
	Total bool   // a total: bold
	// Pill: a small gradient tag before the value ("Lifelike 3D").
	Pill string
}

// Layout is one mail's content in one language.
type Layout struct {
	Lang      string
	Subject   string // without SubjectSuffix
	Preheader string // the inbox preview line
	Title     string
	Paras     []string
	Rows      []Row
	After     []string // paragraphs after the details table
	Button    string
	ButtonURL string
	// LinkText/LinkURL: a secondary text link (the App Store's settings).
	LinkText string
	LinkURL  string
	Notes    []string // small print (consent, currency)
	Reason   string   // why this mail came (footer)
	// Banner: the test environment's notice, on top.
	Banner string
	// Code: a sign-in code shown large (the code mail).
	Code string
	// Lifelike: the card carries the Lifelike 3D edge (a gradient rule
	// on top, the web's .ll-edge colours, static).
	Lifelike bool
}

// FullSubject is the subject as sent.
func (l Layout) FullSubject() string { return l.Subject + SubjectSuffix }

// ShortLink is how a link is shown under a button: host and path,
// shortened ("stereo3d.studio/billing", "stereo3d.studio/pay/k7Q2…").
func ShortLink(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return raw
	}
	s := strings.TrimPrefix(u.Host, "www.") + strings.TrimRight(u.Path, "/")
	if r := []rune(s); len(r) > 34 {
		s = string(r[:33]) + "…"
	}
	return s
}

type viewModel struct {
	Layout
	Dir, Start, End, Brand string
	Logo                   string
	SiteURL                string
	FallbackPre            string
	FallbackPost           string
	FallbackText           string
	Help                   string
	Entity                 string
	BtnWidth               int
}

// HTML renders the mail.
func (l Layout) HTML() string {
	dir := Dir(l.Lang)
	start, end := "left", "right"
	if dir == "rtl" {
		start, end = "right", "left"
	}
	vm := viewModel{Layout: l, Dir: dir, Start: start, End: end, Brand: T(l.Lang, "common.brand", nil), Logo: LogoURL,
		SiteURL: "https://www.stereo3d.studio", Entity: T(l.Lang, "common.entity", Args{"entity": LegalEntity})}
	if l.ButtonURL != "" {
		fb := Raw(l.Lang, "common.fallback")
		pre, post, _ := strings.Cut(fb, "{link}")
		vm.FallbackPre, vm.FallbackPost, vm.FallbackText = pre, post, ShortLink(l.ButtonURL)
		// Outlook's VML button needs a width: roughly the label's.
		vm.BtnWidth = min(max(len([]rune(l.Button))*11+60, 200), 520)
	}
	help := html.EscapeString(Raw(l.Lang, "common.help"))
	help = strings.ReplaceAll(help, "{email}", `<a href="mailto:`+SupportEmail+`" style="color:#4f8cff;text-decoration:underline" class="link">`+SupportEmail+`</a>`)
	vm.Help = help
	var b bytes.Buffer
	if err := layoutTmpl.Execute(&b, vm); err != nil {
		return ""
	}
	return b.String()
}

// Text renders the plain-text alternative.
func (l Layout) Text() string {
	var b strings.Builder
	if l.Banner != "" {
		b.WriteString("[" + l.Banner + "]\n\n")
	}
	b.WriteString(l.Title + "\n\n")
	if l.Code != "" {
		b.WriteString(l.Code + "\n\n")
	}
	for _, p := range l.Paras {
		b.WriteString(p + "\n\n")
	}
	if len(l.Rows) > 0 {
		for _, r := range l.Rows {
			b.WriteString(r.Label)
			if v := strings.Trim(r.Pill+" · "+r.Value, " ·"); v != "" {
				b.WriteString(": " + v)
			}
			if r.Href != "" {
				b.WriteString(" (" + r.Href + ")")
			}
			b.WriteString("\n")
		}
		b.WriteString("\n")
	}
	for _, p := range l.After {
		b.WriteString(p + "\n\n")
	}
	if l.Button != "" && l.ButtonURL != "" {
		b.WriteString(l.Button + ": " + l.ButtonURL + "\n\n")
	}
	if l.LinkText != "" && l.LinkURL != "" {
		b.WriteString(l.LinkText + ": " + l.LinkURL + "\n\n")
	}
	for _, n := range l.Notes {
		b.WriteString(n + "\n")
	}
	if len(l.Notes) > 0 {
		b.WriteString("\n")
	}
	b.WriteString("--\n")
	b.WriteString(T(l.Lang, "common.help", Args{"email": SupportEmail}) + "\n")
	if l.Reason != "" {
		b.WriteString(l.Reason + "\n")
	}
	b.WriteString(T(l.Lang, "common.entity", Args{"entity": LegalEntity}) + "\n")
	return b.String()
}

var layoutTmpl = template.Must(template.New("mail").Funcs(template.FuncMap{"h": html.EscapeString, "u": safeURL}).Parse(strings.ReplaceAll(layoutHTML, "FONT", fontStack)))

// safeURL escapes an http(s) or mailto link for an attribute; anything
// else becomes "#".
func safeURL(raw string) string {
	l := strings.ToLower(strings.TrimSpace(raw))
	if !strings.HasPrefix(l, "https://") && !strings.HasPrefix(l, "http://") && !strings.HasPrefix(l, "mailto:") {
		return "#"
	}
	return html.EscapeString(strings.TrimSpace(raw))
}

// The web's palette (web/src/app/globals.css): page #09090b, card
// #101013, text #e7e7ea, muted #8b8b93, rule #26262c, the studio blue
// #4f8cff. Dark first, like the app: every background is also a bgcolor
// attribute, so a client that drops CSS backgrounds keeps the dark card
// and the light text stays readable. The button's label is 19 px bold
// (WCAG AA large text: white on #4f8cff is 3.3:1).
const fontStack = `-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,'Hiragino Sans','PingFang SC','Noto Sans',sans-serif`

const layoutHTML = `<!DOCTYPE html>
<html lang="{{h .Lang}}" dir="{{h .Dir}}" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="X-UA-Compatible" content="IE=edge">
<meta name="x-apple-disable-message-reformatting">
<meta name="format-detection" content="telephone=no, date=no, address=no, email=no">
<meta name="color-scheme" content="dark light">
<meta name="supported-color-schemes" content="dark light">
<title>{{h .Subject}}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><style>body,table,td,p,a,span,h1{font-family:Segoe UI,Arial,sans-serif !important;}</style><![endif]-->
<style>
:root { color-scheme: dark light; supported-color-schemes: dark light; }
body { margin:0 !important; padding:0 !important; width:100% !important; background-color:#09090b; }
a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
u + .body a, #MessageViewBody a { color:inherit; }
@media screen and (max-width: 600px) {
  .card { border-radius:0 !important; border-left:0 !important; border-right:0 !important; }
  .pad { padding-left:20px !important; padding-right:20px !important; }
  .h1 { font-size:22px !important; line-height:29px !important; }
}
[data-ogsc] .fg, [data-ogsc] .h1 { color:#e7e7ea !important; }
[data-ogsc] .muted { color:#8b8b93 !important; }
[data-ogsb] .bg { background-color:#09090b !important; }
[data-ogsb] .card { background-color:#101013 !important; }
</style>
</head>
<body class="body bg" bgcolor="#09090b" style="margin:0;padding:0;background-color:#09090b;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%">
{{if .Preheader}}<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;font-size:1px;line-height:1px;color:#09090b">{{h .Preheader}}&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;&#8199;&#847;</div>{{end}}
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#09090b" style="background-color:#09090b" dir="{{h .Dir}}">
<tr><td align="center" style="padding:28px 0">
<!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;margin:0 auto">
<tr><td class="pad" style="padding:0 24px 18px 24px;text-align:{{h .Start}}">
<a href="{{u .SiteURL}}" style="text-decoration:none;color:#e7e7ea"><img src="{{u .Logo}}" width="32" height="32" alt="{{h .Brand}}" style="display:inline-block;vertical-align:middle;width:32px;height:32px;border:0;border-radius:8px;outline:none;text-decoration:none"><span class="fg" style="display:inline-block;vertical-align:middle;padding-{{h .Start}}:10px;font-family:FONT;font-size:15px;line-height:20px;font-weight:600;letter-spacing:-0.01em;color:#e7e7ea">{{h .Brand}}</span></a>
</td></tr>
{{if .Banner}}<tr><td class="pad" style="padding:0 24px 12px 24px"><div style="font-family:FONT;font-size:13px;line-height:18px;color:#fde68a;background-color:#2a2108;border:1px solid #4a3a0c;border-radius:8px;padding:8px 12px;text-align:{{h .Start}}">{{h .Banner}}</div></td></tr>{{end}}
<tr><td>
<table role="presentation" class="card" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="#101013" style="background-color:#101013;border:1px solid #26262c;border-radius:16px;border-collapse:separate;overflow:hidden">
{{if .Lifelike}}<tr><td height="3" bgcolor="#4f8cff" style="height:3px;line-height:3px;font-size:0;background-color:#4f8cff;background-image:linear-gradient(90deg,#4f8cff,#a78bfa 55%,#34d3c4);border-radius:16px 16px 0 0">&nbsp;</td></tr>{{end}}
<tr><td class="pad" bgcolor="#101013" style="padding:30px 32px 6px 32px;text-align:{{h .Start}};font-family:FONT">
<h1 class="h1" style="margin:0 0 14px 0;font-family:FONT;font-size:24px;line-height:31px;font-weight:700;letter-spacing:-0.01em;color:#f4f4f6">{{h .Title}}</h1>
{{if .Code}}<div class="code" style="margin:0 0 16px 0;padding:14px 16px;background-color:#18181d;border:1px solid #26262c;border-radius:10px;font-family:'SF Mono',Menlo,Consolas,monospace;font-size:30px;line-height:36px;letter-spacing:6px;font-weight:700;color:#f4f4f6;text-align:center" dir="ltr">{{h .Code}}</div>{{end}}
{{range .Paras}}<p class="fg" style="margin:0 0 14px 0;font-family:FONT;font-size:16px;line-height:24px;color:#e7e7ea">{{h .}}</p>
{{end}}
</td></tr>
{{if .Rows}}<tr><td class="pad" bgcolor="#101013" style="padding:4px 32px 10px 32px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:FONT">
{{range .Rows}}<tr>
<td class="muted" valign="top" style="padding:11px 0;border-top:1px solid #26262c;font-size:14px;line-height:20px;color:#8b8b93;text-align:{{h $.Start}}">{{h .Label}}</td>
<td class="fg" valign="top" style="padding:11px 0;padding-{{h $.Start}}:16px;border-top:1px solid #26262c;font-size:14px;line-height:20px;color:#e7e7ea;text-align:{{h $.End}};font-weight:{{if .Total}}700{{else}}500{{end}}">{{if .Pill}}<span style="display:inline-block;white-space:nowrap;margin-{{h $.End}}:6px;padding:1px 8px;border-radius:999px;background-color:#4f8cff;background-image:linear-gradient(90deg,#4f8cff,#8b6cff);color:#ffffff;font-size:11px;line-height:18px;font-weight:600;letter-spacing:0.02em;vertical-align:1px">{{h .Pill}}</span>{{end}}{{if .Href}}<a href="{{u .Href}}" class="link" style="color:#4f8cff;text-decoration:none">{{h .Value}}</a>{{else}}{{h .Value}}{{end}}</td>
</tr>
{{end}}</table>
</td></tr>{{end}}
{{if .After}}<tr><td class="pad" bgcolor="#101013" style="padding:10px 32px 0 32px;text-align:{{h .Start}};font-family:FONT">
{{range .After}}<p class="fg" style="margin:0 0 14px 0;font-family:FONT;font-size:16px;line-height:24px;color:#e7e7ea">{{h .}}</p>
{{end}}</td></tr>{{end}}
{{if .ButtonURL}}<tr><td class="pad" bgcolor="#101013" style="padding:12px 32px 4px 32px;text-align:{{h .Start}}">
<!--[if mso]><v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{{u .ButtonURL}}" style="height:52px;v-text-anchor:middle;width:{{.BtnWidth}}px;" arcsize="24%" stroke="f" fillcolor="#4f8cff"><w:anchorlock/><center style="color:#ffffff;font-family:Segoe UI,Arial,sans-serif;font-size:19px;font-weight:bold;">{{h .Button}}</center></v:roundrect><![endif]-->
<!--[if !mso]><!-- --><a href="{{u .ButtonURL}}" class="btn" style="display:inline-block;background-color:#4f8cff;border:1px solid #4f8cff;border-radius:12px;color:#ffffff;font-family:FONT;font-size:19px;line-height:24px;font-weight:700;text-decoration:none;padding:13px 26px;mso-hide:all">{{h .Button}}</a><!--<![endif]-->
<p class="muted" style="margin:12px 0 0 0;font-family:FONT;font-size:13px;line-height:19px;color:#8b8b93">{{h .FallbackPre}}<a href="{{u .ButtonURL}}" class="link" style="color:#4f8cff;text-decoration:underline;word-break:break-all" dir="ltr">{{h .FallbackText}}</a>{{h .FallbackPost}}</p>
</td></tr>{{end}}
{{if .LinkURL}}<tr><td class="pad" bgcolor="#101013" style="padding:14px 32px 0 32px;text-align:{{h .Start}};font-family:FONT;font-size:15px;line-height:22px"><a href="{{u .LinkURL}}" class="link" style="color:#4f8cff;text-decoration:underline">{{h .LinkText}}</a></td></tr>{{end}}
<tr><td class="pad" bgcolor="#101013" style="padding:20px 32px 26px 32px;text-align:{{h .Start}};font-family:FONT">
{{range .Notes}}<p class="muted" style="margin:0 0 8px 0;font-family:FONT;font-size:13px;line-height:19px;color:#8b8b93">{{h .}}</p>
{{end}}</td></tr>
</table>
</td></tr>
<tr><td class="pad" style="padding:20px 32px 8px 32px;text-align:{{h .Start}};font-family:FONT">
<p class="muted" style="margin:0 0 6px 0;font-family:FONT;font-size:12px;line-height:18px;color:#8b8b93">{{.Help}}</p>
{{if .Reason}}<p class="muted" style="margin:0 0 6px 0;font-family:FONT;font-size:12px;line-height:18px;color:#8b8b93">{{h .Reason}}</p>{{end}}
<p class="muted" style="margin:0;font-family:FONT;font-size:12px;line-height:18px;color:#8b8b93">{{h .Entity}}</p>
</td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
</td></tr>
</table>
</body>
</html>
`
