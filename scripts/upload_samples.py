"""Upload local sample inputs to the app's GCS prefix.

Usage (from the project root, profile stereo-crafter-test):

    modal run scripts/upload_samples.py

Files land under gs://spatial-video-studio-app/stereo3d/<env>/inputs/samples/
and are then addressable in API payloads as "inputs/samples/<name>".
"""

from pathlib import Path

import modal

from app.common.storage import BUCKET_DIR, PIPELINE_VOLUMES
from app.images import media_image

app = modal.App("stereo3d-upload-samples")

SAMPLES = Path(__file__).resolve().parent.parent / "samples"


@app.function(image=media_image, volumes=PIPELINE_VOLUMES, timeout=600)
def put_file(rel_path: str, data: bytes) -> str:
    dest = BUCKET_DIR / "inputs" / "samples" / rel_path
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return f"inputs/samples/{rel_path} ({len(data) / 1e6:.1f} MB)"


@app.function(image=media_image, volumes=PIPELINE_VOLUMES, timeout=120)
def list_samples() -> list[str]:
    base = BUCKET_DIR / "inputs" / "samples"
    if not base.exists():
        return []
    return sorted(str(p.relative_to(base)) for p in base.rglob("*") if p.is_file())


@app.local_entrypoint()
def main():
    existing = set(list_samples.remote())
    print(f"already uploaded: {len(existing)} files")

    uploads = []
    for path in sorted(SAMPLES.rglob("*")):
        if not path.is_file() or path.name.startswith("."):
            continue
        rel = str(path.relative_to(SAMPLES))
        if rel in existing:
            print(f"  skip {rel}")
            continue
        uploads.append((rel, path.read_bytes()))

    if not uploads:
        print("nothing to upload")
        return
    for result in put_file.starmap(uploads):
        print(f"  ⬆️  {result}")
    print(f"uploaded {len(uploads)} files")
