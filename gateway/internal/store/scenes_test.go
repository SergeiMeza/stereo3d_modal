package store

import (
	"encoding/json"
	"strings"
	"testing"
)

// A single-shot source has no cuts; the wire contract is number[], never null.
func TestScenesMarshalNilCutsAsEmptyArray(t *testing.T) {
	b, err := json.Marshal(&Scenes{Version: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(b), `"cuts":[]`) {
		t.Fatalf("nil cuts must serialize as []: %s", b)
	}
	b, _ = json.Marshal(map[string]any{"scenes": &Scenes{Version: 2, Cuts: []int{10, 20}}})
	if !strings.Contains(string(b), `"cuts":[10,20]`) {
		t.Fatalf("cuts lost: %s", b)
	}
}
