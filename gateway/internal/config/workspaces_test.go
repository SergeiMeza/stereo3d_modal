package config

import "testing"

// S3D-40: one default workspace today, more from MODAL_WORKSPACES.
func TestWorkspaces(t *testing.T) {
	if got := workspaceFromURL("https://stereo-crafter-test--stereo3d-api-test.modal.run"); got != "stereo-crafter-test" {
		t.Errorf("from URL: %q", got)
	}
	if got := workspaceFromURL("http://localhost:8000"); got != "default" {
		t.Errorf("no workspace: %q", got)
	}
	if ws, err := ParseWorkspaces("", nil); err != nil || ws != nil {
		t.Errorf("empty: %v %v", ws, err)
	}
	env := map[string]string{"MODAL_TOKEN_ID": "id0", "MODAL_TOKEN_SECRET": "s0", "WS2_ID": "id2", "WS2_SECRET": "s2"}
	ws, err := ParseWorkspaces(`[{"id":"ws2","modal_base_url":"https://ws2--stereo3d-api-prod.modal.run/","lifelike_base_url":"https://ws2--lifelike3d-api-prod.modal.run","token_id_env":"WS2_ID","token_secret_env":"WS2_SECRET"},{"id":"ws3","modal_base_url":"https://ws3--x.modal.run"}]`,
		func(k string) string { return env[k] })
	if err != nil || len(ws) != 2 {
		t.Fatalf("%v %v", ws, err)
	}
	if ws[0].ModalBaseURL != "https://ws2--stereo3d-api-prod.modal.run" || ws[0].ModalTokenID != "id2" || ws[0].LifelikeTokenSecret != "s2" {
		t.Errorf("ws2: %+v", ws[0])
	}
	if ws[1].ModalTokenID != "id0" || ws[1].LifelikeBaseURL != "" {
		t.Errorf("ws3 falls back to the default token, Lifelike off: %+v", ws[1])
	}
	for _, bad := range []string{`[{"id":"a"}]`, `[{"id":"a","modal_base_url":"x"},{"id":"a","modal_base_url":"y"}]`, `{`} {
		if _, err := ParseWorkspaces(bad, func(string) string { return "" }); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
}
