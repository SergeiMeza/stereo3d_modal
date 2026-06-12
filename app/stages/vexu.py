"""Apple spatial-video metadata (vexu/hfov) blob builder.

Builds the VisualSampleEntry extension boxes that make visionOS/macOS
treat an MV-HEVC file as "spatial media", per Apple's "QuickTime and
ISO Base Media File Formats and Spatial and Immersive Media" spec
(v1.9.8) and matching FFmpeg's movenc writer byte-for-byte:

    vexu
    └─ eyes
       ├─ stri   stereo view info (left+right present)
       ├─ hero   hero (primary) eye
       ├─ cams ▸ blin   camera baseline, micrometers   ┐ required for the
       └─ cmfy ▸ dadj   disparity adjustment (±10000)  │ visionOS "spatial
    hfov          horizontal FOV, thousandths of a degree ┘ media" badge

Both boxes are children of the hvc1 sample entry (hfov is a SIBLING of
vexu, not a child). Injection is done with Bento4 mp4edit, which
patches stco/co64 chunk offsets automatically.

Pure stdlib; no torch — usable in any container.
"""

import struct

LEFT = "left"
RIGHT = "right"

# Defaults for converted 2D→3D content (iPhone-15-Pro-like; Apple calls
# dadj +0.02 "a common default")
DEFAULT_BASELINE_MM = 19.24
DEFAULT_HFOV_DEG = 63.4
DEFAULT_DADJ = 200  # +0.02 of image width, in 1/10000 units


def _box(fourcc: str, payload: bytes) -> bytes:
    return struct.pack(">I", 8 + len(payload)) + fourcc.encode("ascii") + payload


def _full_box(fourcc: str, payload: bytes) -> bytes:
    # version=0, flags=0
    return _box(fourcc, b"\x00\x00\x00\x00" + payload)


def build_vexu(
    hero: str | None = LEFT,
    baseline_mm: float = DEFAULT_BASELINE_MM,
    dadj: int = DEFAULT_DADJ,
) -> bytes:
    """vexu box bytes. hero: "left" | "right" | None (omit hero box)."""
    if not -10000 <= dadj <= 10000:
        raise ValueError(f"dadj must be in [-10000, 10000], got {dadj}")
    stri = _full_box("stri", bytes([0b0000_0011]))  # left + right views present
    eyes_children = stri
    if hero is not None:
        eyes_children += _full_box("hero", bytes([{LEFT: 1, RIGHT: 2}[hero]]))
    baseline_um = round(baseline_mm * 1000)
    if baseline_um <= 0:
        raise ValueError("baseline must be positive for spatial-media recognition")
    eyes_children += _box("cams", _full_box("blin", struct.pack(">I", baseline_um)))
    eyes_children += _box("cmfy", _full_box("dadj", struct.pack(">i", dadj)))
    return _box("vexu", _box("eyes", eyes_children))


def build_hfov(hfov_deg: float = DEFAULT_HFOV_DEG) -> bytes:
    """hfov box bytes (plain box, no version/flags)."""
    return _box("hfov", struct.pack(">I", round(hfov_deg * 1000)))


def self_test() -> None:
    """Verify against the reference hex of Apple's spec layout
    (iPhone-15-Pro-like values: baseline 19240 µm, dadj +200,
    hfov 63.4°, hero=right, both eyes present)."""
    vexu = build_vexu(hero=RIGHT, baseline_mm=19.24, dadj=200)
    hfov = build_hfov(63.4)
    expected_vexu = bytes.fromhex(
        "0000005a76657875"              # vexu (90)
        "0000005265796573"              # └ eyes (82)
        "0000000d737472690000000003"    #   stri v0 f0, 0x03 = L|R
        "0000000d6865726f0000000002"    #   hero v0 f0, 2 = right
        "0000001863616d73"              #   cams (24)
        "00000010626c696e0000000000004b28"  # └ blin = 19240 µm
        "00000018636d6679"              #   cmfy (24)
        "000000106461646a00000000000000c8"  # └ dadj = +200
    )
    assert vexu == expected_vexu, f"\ngot      {vexu.hex()}\nexpected {expected_vexu.hex()}"
    assert hfov == bytes.fromhex("0000000c68666f760000f7a8")
    print("vexu/hfov self-test OK")


if __name__ == "__main__":
    self_test()
