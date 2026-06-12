"""Vendored M2SVid inference code (mono-to-stereo video inpainting).

Provenance
    https://github.com/google-research/m2svid @ main (cloned 2026-06-13)
    "M2SVid: End-to-End Inpainting and Refinement for Monocular-to-Stereo
    Video Conversion", Shvetsova et al., 3DV 2026.

    - ``m2svid/`` — Apache 2.0, Google LLC (see LICENSE). Inference
      subset only: the ``VideoLDM`` model, its ``ConcatEmbedder``, and
      tiny psnr/anaglyph helpers. Training/data/eval modules dropped.
    - ``sgm/`` — the modified Stability ``generative-models`` stack
      vendored by M2SVid via Hi3D-Official (MIT, see
      LICENSE.Hi3D-Official). M2SVid's changes live in
      ``sgm/modules/video_attention.py`` (full attention over
      disoccluded tokens) and ``sgm/modules/diffusionmodules/
      sampling.py`` (``denoise_from_zero`` single-step sampling) — do
      NOT replace this tree with upstream sgm. Training-only modules
      (losses, sigma sampling, data, old variants) dropped.

Upstream code is byte-identical except for three patches, each marked
with a ``[vendored patch]`` comment at the edit site:
    1. ``m2svid_model.py`` — no LPIPS metric instantiation at init
       (avoids VGG weight downloads from external hosts on container
       start; LPIPS is eval-only).
    2. ``m2svid_model.py`` — ``torch.load(..., weights_only=False)``
       for the deepspeed-format checkpoint (torch>=2.6 default change).
    3. ``utils/anaglyph.py`` — unused matplotlib import removed.

Import contract: the upstream code uses absolute ``sgm.*`` /
``m2svid.*`` imports and OmegaConf ``target:`` strings (the repo is
PYTHONPATH-based, not pip-installable). Call :func:`bootstrap` before
importing either package so this directory joins ``sys.path`` and those
names resolve; rewriting every dotted path would invite drift against
upstream.
"""

import sys
from pathlib import Path

VENDOR_ROOT = Path(__file__).resolve().parent


def bootstrap() -> None:
    """Make the vendored ``sgm`` and ``m2svid`` packages importable as
    top-level modules (mirrors upstream's PYTHONPATH layout)."""
    root = str(VENDOR_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
