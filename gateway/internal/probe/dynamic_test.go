package probe

import "testing"

// An iPhone clip: HEVC Main 10, BT.2020, HLG, Dolby Vision 8.4.
const iphoneHDR = `{"streams":[{"codec_name":"hevc","profile":"Main 10","pix_fmt":"yuv420p10le","color_space":"bt2020nc",
"color_transfer":"arib-std-b67","color_primaries":"bt2020","side_data_list":[{"side_data_type":"DOVI configuration record",
"dv_version_major":1,"dv_version_minor":0,"dv_profile":8,"dv_level":5,"rpu_present_flag":1,"el_present_flag":0,
"bl_present_flag":1,"dv_bl_signal_compatibility_id":4}]}]}`

func TestParseDynamic(t *testing.T) {
	for _, tc := range []struct {
		name, json, rng, base string
		hdr                   bool
	}{
		{"iphone dv 8.4", iphoneHDR, RangeDV8, RangeHLG, true},
		{"sdr", `{"streams":[{"profile":"High","color_transfer":"bt709"}]}`, RangeSDR, "", false},
		{"untagged", `{"streams":[{"profile":"High"}]}`, RangeSDR, "", false},
		{"hlg", `{"streams":[{"profile":"Main 10","color_transfer":"arib-std-b67"}]}`, RangeHLG, "", true},
		{"pq", `{"streams":[{"profile":"Main 10","color_transfer":"smpte2084"}]}`, RangePQ, "", true},
		{"dv 8.1", `{"streams":[{"color_transfer":"smpte2084","side_data_list":[{"side_data_type":"DOVI configuration record","dv_profile":8,"dv_bl_signal_compatibility_id":1}]}]}`, RangeDV8, RangePQ, true},
		{"dv 8.2", `{"streams":[{"color_transfer":"bt709","side_data_list":[{"side_data_type":"DOVI configuration record","dv_profile":8,"dv_bl_signal_compatibility_id":2}]}]}`, RangeDV8, RangeSDR, false},
		{"dv 5", `{"streams":[{"color_transfer":"unknown","side_data_list":[{"side_data_type":"DOVI configuration record","dv_profile":5,"dv_bl_signal_compatibility_id":0}]}]}`, RangeDV5, "", false},
		{"other side data", `{"streams":[{"color_transfer":"smpte2084","side_data_list":[{"side_data_type":"Mastering display metadata"}]}]}`, RangePQ, "", true},
	} {
		d, err := ParseDynamic([]byte(tc.json))
		if err != nil || d.Range != tc.rng || d.Base != tc.base || d.HDR() != tc.hdr {
			t.Errorf("%s: %+v %v", tc.name, d, err)
		}
	}
	if d, _ := ParseDynamic([]byte(iphoneHDR)); d.DVProfile != 8 || d.DVCompat != 4 || d.Transfer != "arib-std-b67" || d.Primaries != "bt2020" || d.Profile != "Main 10" {
		t.Errorf("iphone fields %+v", d)
	}
	if _, err := ParseDynamic([]byte(`{"streams":[]}`)); err == nil {
		t.Error("no stream")
	}
}
