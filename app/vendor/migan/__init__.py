"""MI-GAN inference generator, vendored from
https://github.com/Picsart-AI-Research/MI-GAN (MIT, Picsart AI Research;
NeurIPS 2023 "MI-GAN: A Simple Baseline for Image Inpainting on Mobile
Devices"). lib/model_zoo/migan_inference.py verbatim — a self-contained
StyleGAN2-style encoder/synthesis pair with fixed-resolution buffers, so
inputs are always (B, 4, 512, 512): cat([mask - 0.5, image * mask]) with
mask 1 = known / 0 = hole and image in [-1, 1]; output is RGB in [-1, 1].
Weights: migan_512_places2.pt from the paper's official release (loaded
as a plain state_dict by Generator(resolution=512))."""

from app.vendor.migan.migan_inference import Generator  # noqa: F401
