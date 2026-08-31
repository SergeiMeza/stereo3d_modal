"""The API (web_image) and coordinator (media_image) containers import
app.main WITHOUT torch/torchvision/numpy/etc. — the GPU-only imports live
in ``image.imports()`` blocks that silently swallow ImportError there.
Anything evaluated at module/class-definition time (default arguments,
class attributes, decorators) must therefore resolve without those
blocks, or the API container crash-loops on every cold start and the
endpoint goes dark (2026-08-31 staging incident: a method default arg
referenced a name imported inside the block → NameError).

Run in a subprocess so the poisoned sys.modules never leak into other
tests."""

import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]

SCRIPT = r"""
import sys
for m in ("torch", "torchvision", "torchcodec", "ffmpeg", "cv2", "numpy",
          "scenedetect", "PIL", "pillow_heif", "Forward_Warp"):
    sys.modules[m] = None  # any `import <m>` raises ImportError
import app.main  # noqa: F401 — registers every function/class with the App
from app.api.main import web_app
from fastapi.testclient import TestClient
r = TestClient(web_app).post("/v1/videos", json={"input_path": "x.mp4", "warp": "gather"})
assert r.status_code == 400, (r.status_code, r.text)
print("OK")
"""


def test_app_main_imports_without_the_gpu_stack():
    proc = subprocess.run(
        [sys.executable, "-c", SCRIPT], cwd=REPO, capture_output=True, text=True, timeout=180
    )
    assert proc.returncode == 0 and "OK" in proc.stdout, proc.stderr[-2000:]
