package mail

import (
	"embed"
	"encoding/json"
	"fmt"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Customer mail copy in the web's 11 languages (copy/<lang>.json, the
// same terms as web/messages). Keys are flat ("e1.subject"); {name}
// placeholders are filled by T. A key missing in a language falls back to
// English, so a mail never goes out with a raw key.

//go:embed copy/*.json
var copyFS embed.FS

// Langs are the web's languages, English first.
var Langs = []string{"en", "zh-Hans", "ja", "fr", "de", "zh-Hant", "ko", "es", "ru", "tr", "ar"}

var catalogs = loadCatalogs()

func loadCatalogs() map[string]map[string]string {
	out := map[string]map[string]string{}
	entries, err := copyFS.ReadDir("copy")
	if err != nil {
		panic(err)
	}
	for _, e := range entries {
		raw, err := copyFS.ReadFile(path.Join("copy", e.Name()))
		if err != nil {
			panic(err)
		}
		m := map[string]string{}
		if err := json.Unmarshal(raw, &m); err != nil {
			panic(fmt.Sprintf("mail copy %s: %v", e.Name(), err))
		}
		out[strings.TrimSuffix(e.Name(), ".json")] = m
	}
	if out["en"] == nil {
		panic("mail copy: en.json missing")
	}
	return out
}

// Keys lists the English keys (tests).
func Keys() []string {
	keys := make([]string, 0, len(catalogs["en"]))
	for k := range catalogs["en"] {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// Has reports whether lang has its own text for key (tests).
func Has(lang, key string) bool {
	_, ok := catalogs[lang][key]
	return ok
}

// Raw is key's text in lang (English when missing), unfilled.
func Raw(lang, key string) string {
	if v, ok := catalogs[lang][key]; ok {
		return v
	}
	return catalogs["en"][key]
}

// Args fill a text's {placeholders}.
type Args map[string]string

// T is key's text in lang with args filled.
func T(lang, key string, args Args) string {
	s := Raw(lang, key)
	for k, v := range args {
		s = strings.ReplaceAll(s, "{"+k+"}", v)
	}
	return s
}

// Dir is "rtl" for Arabic, else "ltr".
func Dir(lang string) string {
	if Raw(lang, "_meta.dir") == "rtl" {
		return "rtl"
	}
	return "ltr"
}

// LangFor maps a BCP-47 tag, or an Accept-Language header (its first
// tag), to one of Langs; "" when none fits.
func LangFor(tag string) string {
	t := strings.TrimSpace(tag)
	if i := strings.IndexAny(t, ",;"); i >= 0 {
		t = t[:i]
	}
	t = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(t), "_", "-"))
	if t == "" || t == "*" {
		return ""
	}
	parts := strings.Split(t, "-")
	if parts[0] == "zh" {
		for _, p := range parts[1:] {
			switch p {
			case "hant", "tw", "hk", "mo":
				return "zh-Hant"
			}
		}
		return "zh-Hans"
	}
	switch parts[0] {
	case "en", "ja", "fr", "de", "ko", "es", "ru", "tr", "ar":
		return parts[0]
	}
	return ""
}

// FormatDate is t's day in lang ("9 November 2026", "2026年11月9日").
func FormatDate(lang string, t time.Time) string { return formatDay(lang, "_meta.date", t) }

// FormatDayMonth is t's day without the year ("9 November").
func FormatDayMonth(lang string, t time.Time) string { return formatDay(lang, "_meta.dayMonth", t) }

func formatDay(lang, key string, t time.Time) string {
	t = t.UTC()
	months := strings.Split(Raw(lang, "_meta.months"), "|")
	month := strconv.Itoa(int(t.Month()))
	if len(months) == 12 {
		month = months[t.Month()-1]
	}
	return T(lang, key, Args{"d": strconv.Itoa(t.Day()), "month": month, "y": strconv.Itoa(t.Year())})
}
