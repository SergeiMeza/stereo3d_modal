package mail

import (
	"os"
	"strings"
	"testing"
)

// Every key a language doesn't have yet is on the translation TODO list,
// and every key renders (in English at worst).
func TestTranslationTodoListsMissingKeys(t *testing.T) {
	raw, err := os.ReadFile("TODO-translations.md")
	if err != nil {
		t.Fatal(err)
	}
	todo := string(raw)
	for _, lang := range Langs[1:] {
		for _, k := range Keys() {
			if !Has(lang, k) && !strings.Contains(todo, "`"+k+"`") {
				t.Errorf("%s lacks %s and the TODO doesn't list it", lang, k)
			}
			if Raw(lang, k) == "" && !strings.HasPrefix(k, "_meta") {
				t.Errorf("%s %s renders empty", lang, k)
			}
		}
	}
}
