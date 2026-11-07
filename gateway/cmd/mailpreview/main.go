// Command mailpreview writes the customer mail gallery: every mail as
// sent (HTML and plain text), Lifelike next to Classic, and the web copy
// and refund policy before/after tables. Static files only; it sends
// nothing and reads no config.
//
//	go run ./cmd/mailpreview -out /path/to/mail-preview
//
// web-copy.json and web-copy-refund.json in -out ([{key, surface, before,
// after, note}]) become the Web copy and Refund policy pages.
package main

import (
	"encoding/json"
	"flag"
	"html/template"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"spatial-ai-labs/stereo3d-gateway/internal/api"
)

type copyRow struct {
	Key     string `json:"key"`
	Surface string `json:"surface"`
	Before  string `json:"before"`
	After   string `json:"after"`
	Note    string `json:"note"`
}

type card struct {
	api.MailSample
	Slug string
}

type pair struct {
	Title    string
	Lifelike card
	Classic  card
}

type page struct {
	Title, Nav string
	Groups     []group
	Pairs      []pair
	Rows       []copyRow
	MailRows   []copyRow
	Missing    string
}

type group struct {
	Name  string
	Cards []card
}

var slugRe = regexp.MustCompile(`[^a-z0-9]+`)

func slug(id string) string {
	return strings.Trim(slugRe.ReplaceAllString(strings.ToLower(id), "-"), "-")
}

func main() {
	out := flag.String("out", "mail-preview", "output folder")
	site := flag.String("site", "https://www.stereo3d.studio", "the web's origin in links")
	flag.Parse()
	if err := os.MkdirAll(filepath.Join(*out, "mails"), 0o755); err != nil {
		log.Fatal(err)
	}
	samples := api.MailSamples(*site, "en")
	bySlug := map[string]card{}
	var groups []group
	idx := map[string]int{}
	for _, s := range samples {
		c := card{MailSample: s, Slug: slug(s.ID)}
		bySlug[c.Slug] = c
		write(filepath.Join(*out, "mails", c.Slug+".html"), s.HTML)
		write(filepath.Join(*out, "mails", c.Slug+".txt"), "Subject: "+s.Subject+"\n\n"+s.Text)
		i, ok := idx[s.Group]
		if !ok {
			i = len(groups)
			idx[s.Group] = i
			groups = append(groups, group{Name: s.Group})
		}
		groups[i].Cards = append(groups[i].Cards, c)
	}
	render(filepath.Join(*out, "index.html"), page{Title: "Customer mails", Nav: "all", Groups: groups})

	var pairs []pair
	for _, p := range [][3]string{
		{"Receipt as it starts (E1)", "e1-lifelike", "e1-classic"},
		{"Ready (single)", "rd-lifelike", "rd-classic"},
		{"Ready (several) and receipt rows", "rd-batch", "e20-receipt"},
	} {
		pairs = append(pairs, pair{Title: p[0], Lifelike: bySlug[p[1]], Classic: bySlug[p[2]]})
	}
	render(filepath.Join(*out, "lifelike.html"), page{Title: "Lifelike 3D next to Classic 3D", Nav: "lifelike", Pairs: pairs})

	web, miss := readRows(filepath.Join(*out, "web-copy.json"))
	render(filepath.Join(*out, "web-copy.html"), page{Title: "Web copy", Nav: "web", Rows: web, Missing: miss})
	refund, miss := readRows(filepath.Join(*out, "web-copy-refund.json"))
	render(filepath.Join(*out, "refund-policy.html"), page{Title: "Refund policy", Nav: "refund", Rows: refund, MailRows: refundMailRows, Missing: miss})
	log.Printf("wrote %d mails to %s", len(samples), *out)
}

// refundMailRows: what the mails said before the refund policy
// (2026-11-08) and what they say now.
var refundMailRows = []copyRow{
	{Key: "DL1 (deletion scheduled)", Surface: "Mail, when the account has an unspent balance",
		Before: "Your unspent balance of $12.60 will be lost when the account is deleted. Want to ask for a refund first? You can send a request in Billing before then. [Ask for a refund in Billing]",
		After:  "Your unspent balance of $12.60 will be lost when your account is deleted.",
		Note:   "No refund promised or offered at deletion; the one sentence the owner approved."},
	{Key: "Deletion with a balance (old flow)", Surface: "Account deletion answer, closure mail",
		Before: "You have $12.60 left in your balance. We'll refund it to your payment method. We'll delete your account once your refund is decided, within 2 business days.",
		After:  "(gone: the balance is forfeited; DL1 says so)",
		Note:   "Staging's refund policy removed the closure refund; no mail promises it."},
	{Key: "E1 (receipt as it starts)", Surface: "Mail",
		Before: "If it doesn't work out, we refund you in full.",
		After:  "If it doesn't work out, we refund you in full.",
		Note:   "Kept: a failed 3D video is refunded in full."},
	{Key: "E6 / E9-E12 (refund requests)", Surface: "Mail",
		Before: "Your case: CASE-0042.",
		After:  "Reference: CASE-0042",
		Note:   "Kept; a refund is decided one request at a time. \"Case\" became \"Reference\"."},
}

func readRows(path string) ([]copyRow, string) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, filepath.Base(path) + " not found next to this page."
	}
	var rows []copyRow
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, filepath.Base(path) + ": " + err.Error()
	}
	return rows, ""
}

func write(path, s string) {
	if err := os.WriteFile(path, []byte(s), 0o644); err != nil {
		log.Fatal(err)
	}
}

func render(path string, p page) {
	f, err := os.Create(path)
	if err != nil {
		log.Fatal(err)
	}
	defer f.Close()
	if err := tpl.Execute(f, p); err != nil {
		log.Fatal(err)
	}
}

var tpl = template.Must(template.New("page").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>{{.Title}}</title>
<style>
:root{--bg:#f6f6f8;--card:#fff;--fg:#18181b;--muted:#5f5f69;--line:#e2e2e8;--accent:#3b74e6;--del:#b42318;--ins:#067647}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#09090b;--card:#101013;--fg:#e7e7ea;--muted:#8b8b93;--line:#26262c;--accent:#4f8cff;--del:#f97066;--ins:#47cd89}}
:root[data-theme="dark"]{--bg:#09090b;--card:#101013;--fg:#e7e7ea;--muted:#8b8b93;--line:#26262c;--accent:#4f8cff;--del:#f97066;--ins:#47cd89}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding:12px 16px;display:flex;flex-wrap:wrap;gap:8px 16px;align-items:center}
header b{margin-right:8px}nav a{color:var(--muted);text-decoration:none;margin-right:14px}nav a.on{color:var(--fg);font-weight:600}
label{color:var(--muted);font-size:13px;margin-left:auto}main{padding:16px;max-width:1500px;margin:0 auto}
h2{font-size:18px;margin:28px 0 8px}.cap{text-transform:capitalize}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;margin:12px 0}
.meta{display:flex;flex-wrap:wrap;gap:6px 12px;align-items:baseline;margin-bottom:8px}.subj{font-weight:600}.muted{color:var(--muted);font-size:13px}
.tag{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 8px;color:var(--muted)}.tag.app{color:var(--accent);border-color:var(--accent)}
.frames{display:flex;gap:12px;overflow-x:auto}.frames iframe{border:1px solid var(--line);border-radius:8px;background:#fff;height:760px;flex:none}
.m{width:390px}.d{width:720px}.pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(360px,1fr));gap:12px}.pair iframe{width:100%;height:820px;border:1px solid var(--line);border-radius:8px}
body.invert iframe{filter:invert(1) hue-rotate(180deg)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{text-align:left;vertical-align:top;padding:10px;border-bottom:1px solid var(--line)}th{font-size:13px;color:var(--muted)}
td.b{color:var(--del)}td.a{color:var(--ins)}code{font-size:12px}a{color:var(--accent)}
@media (max-width:700px){table,tbody,tr,td{display:block}thead{display:none}td{border:0;padding:4px 10px}tr{border-bottom:1px solid var(--line);padding:8px 0}}
</style></head>
<body><header><b>Spatial Video Studio mails</b><nav>
<a href="index.html"{{if eq .Nav "all"}} class="on"{{end}}>All mails</a><a href="lifelike.html"{{if eq .Nav "lifelike"}} class="on"{{end}}>Lifelike vs Classic</a>
<a href="web-copy.html"{{if eq .Nav "web"}} class="on"{{end}}>Web copy</a><a href="refund-policy.html"{{if eq .Nav "refund"}} class="on"{{end}}>Refund policy</a></nav>
{{if or .Groups .Pairs}}<label><input type="checkbox" onchange="document.body.classList.toggle('invert',this.checked)"> Simulate a client that inverts dark mail</label>{{end}}
</header><main>
<h1 style="font-size:22px;margin:8px 0">{{.Title}}</h1>
{{if .Groups}}<p class="muted">English for now; other languages fall back to English until their copy ships. Each mail at 390 px (phone) and 720 px (desktop). <i>app</i> marks mails the mobile app's payments send.</p>{{end}}
{{range .Groups}}<h2 class="cap">{{.Name}}</h2>{{range .Cards}}<div class="card"><div class="meta"><span class="tag">{{.Kind}}</span><span class="tag{{if eq .Where "app"}} app{{end}}">{{.Where}}</span>
<span class="subj">{{.Subject}}</span><span class="muted">{{.ID}} · <a href="mails/{{.Slug}}.html">HTML</a> · <a href="mails/{{.Slug}}.txt">plain text</a></span></div>
<div class="frames"><iframe class="m" loading="lazy" src="mails/{{.Slug}}.html" title="{{.ID}} phone"></iframe><iframe class="d" loading="lazy" src="mails/{{.Slug}}.html" title="{{.ID}} desktop"></iframe></div></div>{{end}}{{end}}
{{range .Pairs}}<h2>{{.Title}}</h2><div class="pair"><div><div class="meta"><span class="subj">{{.Lifelike.Subject}}</span></div><iframe src="mails/{{.Lifelike.Slug}}.html" title="Lifelike"></iframe></div>
<div><div class="meta"><span class="subj">{{.Classic.Subject}}</span></div><iframe src="mails/{{.Classic.Slug}}.html" title="Classic"></iframe></div></div>{{end}}
{{if .MailRows}}<h2>Mails</h2><table><thead><tr><th>Mail</th><th>Before</th><th>After</th><th>Why</th></tr></thead><tbody>
{{range .MailRows}}<tr><td><b>{{.Key}}</b><div class="muted">{{.Surface}}</div></td><td class="b">{{.Before}}</td><td class="a">{{.After}}</td><td class="muted">{{.Note}}</td></tr>{{end}}</tbody></table><h2>Web</h2>{{end}}
{{if .Missing}}<p class="muted">{{.Missing}}</p>{{end}}
{{if .Rows}}<table><thead><tr><th>Key</th><th>Before</th><th>After</th><th>Note</th></tr></thead><tbody>
{{range .Rows}}<tr><td><code>{{.Key}}</code><div class="muted">{{.Surface}}</div></td><td class="b">{{.Before}}</td><td class="a">{{.After}}</td><td class="muted">{{.Note}}</td></tr>{{end}}</tbody></table>{{end}}
</main></body></html>`))
