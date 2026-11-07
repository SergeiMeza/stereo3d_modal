package probe

import "testing"

// An iPhone HDR clip and an Apple spatial file as ffprobe 9 prints them.
func TestParseFacts(t *testing.T) {
	iphone := `{"streams":[
	 {"codec_type":"video","codec_name":"hevc","profile":"Main 10","pix_fmt":"yuv420p10le","bit_rate":"24103112","color_transfer":"arib-std-b67","color_primaries":"bt2020",
	  "side_data_list":[{"side_data_type":"DOVI configuration record","dv_profile":8},{"side_data_type":"Display Matrix","rotation":-90}]},
	 {"codec_type":"audio","codec_name":"aac","channels":2,"sample_rate":"44100","bit_rate":"173000"},
	 {"codec_type":"data"}],
	 "format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"12.512","tags":{"major_brand":"qt  ","com.apple.quicktime.make":"Apple","com.apple.quicktime.model":"iPhone 15 Pro Max",
	  "com.apple.quicktime.location.ISO6709":"+35.6+139.7/"}}}`
	f, err := ParseFacts([]byte(iphone))
	if err != nil {
		t.Fatal(err)
	}
	if f.Container != "mov" || f.DurationS != 12.512 || f.Make != "Apple" || f.Model != "iPhone 15 Pro Max" ||
		f.Video.Codec != "hevc" || f.Video.Profile != "Main 10" || f.Video.BitDepth != 10 || f.Video.BitRateBps != 24103112 ||
		f.Video.ColorTransfer != "arib-std-b67" || f.Video.ColorPrimaries != "bt2020" || f.Video.Rotation != -90 ||
		f.Audio == nil || f.Audio.Codec != "aac" || f.Audio.Channels != 2 || f.Audio.SampleRate != 44100 || f.Audio.BitRateBps != 173000 || f.Stereo.Spatial {
		t.Fatalf("%+v %+v %+v", f, f.Video, f.Audio)
	}
	spatial := `{"streams":[{"codec_type":"video","codec_name":"hevc","profile":"Main","pix_fmt":"yuv420p","bit_rate":"8064069",
	  "side_data_list":[{"side_data_type":"Stereo 3D","type":"unspecified","view":"packed","primary_eye":"left"}]}],
	  "format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","duration":"10.04","tags":{"major_brand":"qt  "}}}`
	f, _ = ParseFacts([]byte(spatial))
	if !f.Stereo.Spatial || f.Stereo.Layout != "mvhevc" || f.Video.BitDepth != 8 || f.Audio != nil || f.Make != "" {
		t.Fatalf("%+v", f)
	}
	mp4 := `{"streams":[{"codec_type":"video","codec_name":"h264","pix_fmt":"yuv420p","side_data_list":[{"side_data_type":"Stereo 3D","type":"side by side"}]}],
	  "format":{"format_name":"mov,mp4,m4a,3gp,3g2,mj2","tags":{"major_brand":"isom","com.android.manufacturer":"Google","com.android.model":"Pixel 9"}}}`
	f, _ = ParseFacts([]byte(mp4))
	if f.Container != "mp4" || f.Stereo.Layout != "sbs" || f.Stereo.Spatial || f.Make != "Google" || f.Model != "Pixel 9" {
		t.Fatalf("%+v", f)
	}
	if _, err := ParseFacts([]byte(`{"streams":[{"codec_type":"audio"}],"format":{}}`)); err == nil {
		t.Fatal("no video")
	}
}

func TestBitDepthAndMoov(t *testing.T) {
	for pf, want := range map[string]int{"yuv420p": 8, "yuv420p10le": 10, "p010le": 10, "nv12": 8, "yuv422p12be": 12, "gray": 8, "": 0} {
		if got := bitDepthOf(pf, ""); got != want {
			t.Errorf("%s: %d", pf, got)
		}
	}
	if s := StereoFromMoov([]byte("....moov....trak....hvc1....vexu....")); !s.Spatial || s.From != "vexu" {
		t.Fatalf("%+v", s)
	}
	st3d := append([]byte("\x00\x00\x00\x0dst3d\x00\x00\x00\x00"), 2)
	if s := StereoFromMoov(append([]byte("moov"), st3d...)); s.Layout != "sbs" || s.Spatial {
		t.Fatalf("%+v", s)
	}
	if s := StereoFromMoov([]byte("moov plain")); s.Layout != "" {
		t.Fatalf("%+v", s)
	}
}
