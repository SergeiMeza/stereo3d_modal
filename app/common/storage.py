"""Storage layout.

Three kinds of storage, mounted at fixed paths in every worker:

- GCS bucket (CloudBucketMount, HMAC auth) — external input/output.
  The mount is restricted to the ``stereo3d/`` prefix of the
  ``spatial-video-studio-app`` bucket so this app cannot touch
  production user data living at the bucket root.
- ``stereo3d-cache`` Volume — intermediate pipeline artifacts
  (pre-cropped inputs, depth videos, stereo fragments). Read/write
  heavy, so a Volume rather than the bucket mount.
- ``stereo3d-weights`` Volume — model checkpoints, downloaded once at
  first container start and reused across image rebuilds.

Bucket paths in API payloads use ``gs://`` URIs or bucket-relative
paths; helpers below translate to mounted filesystem paths.
"""

from pathlib import Path
from urllib.parse import quote

import modal

from app.env import APP_ENV

BUCKET_NAME = "spatial-video-studio-app"
BUCKET_PREFIX = f"stereo3d/{APP_ENV}/"

# Mount points (same in every container)
BUCKET_DIR = Path("/bucket")
CACHE_DIR = Path("/cache")
WEIGHTS_DIR = Path("/weights")

gcp_hmac_secret = modal.Secret.from_name(
    "gcp-secret",
    required_keys=["GOOGLE_ACCESS_KEY_ID", "GOOGLE_ACCESS_KEY_SECRET"],
)

hf_secret = modal.Secret.from_name("hf-secret", required_keys=["HF_TOKEN"])

bucket_mount = modal.CloudBucketMount(
    bucket_name=BUCKET_NAME,
    bucket_endpoint_url="https://storage.googleapis.com",
    secret=gcp_hmac_secret,
    key_prefix=BUCKET_PREFIX,
)

cache_volume = modal.Volume.from_name(f"stereo3d-cache-{APP_ENV}", create_if_missing=True)
weights_volume = modal.Volume.from_name("stereo3d-weights", create_if_missing=True)

# volumes= mapping shared by pipeline workers
PIPELINE_VOLUMES = {
    str(BUCKET_DIR): bucket_mount,
    str(CACHE_DIR): cache_volume,
}

GPU_VOLUMES = {
    **PIPELINE_VOLUMES,
    str(WEIGHTS_DIR): weights_volume,
}


def safe_reload(volume: modal.Volume) -> None:
    """Volume.reload() refuses to run while this container holds open
    files — and a previous input's decoders may still be alive until
    GC runs. Collect first, then degrade to a warning: a failed reload
    only matters if the file is missing, which callers check anyway."""
    import gc

    gc.collect()
    try:
        volume.reload()
    except Exception as exc:
        import logging

        logging.getLogger(__name__).warning(f"volume reload skipped: {exc}")


def bucket_path(path: str) -> Path:
    """Translate an API input path to the mounted filesystem path.

    Accepts ``gs://<bucket>/stereo3d/<env>/foo``, ``stereo3d/<env>/foo``
    or a prefix-relative path like ``inputs/samples/clip.mp4``.
    """
    p = str(path)
    if p.startswith("gs://"):
        p = p[len("gs://") :]
        bucket, _, rest = p.partition("/")
        if bucket != BUCKET_NAME:
            raise ValueError(f"unsupported bucket: {bucket}")
        p = rest
    if p.startswith(BUCKET_PREFIX):
        p = p[len(BUCKET_PREFIX) :]
    return BUCKET_DIR / p


def public_url(path: str | Path | None) -> str | None:
    """Public HTTPS URL for a file under the bucket mount."""
    if path is None:
        return None
    p = str(path)
    if p.startswith(str(BUCKET_DIR)):
        rel = Path(p).relative_to(BUCKET_DIR)
    else:
        rel = Path(p)
    key = f"{BUCKET_PREFIX}{rel}"
    return f"https://storage.googleapis.com/{BUCKET_NAME}/{quote(key)}"


def job_cache_dir(job_id: str) -> Path:
    d = CACHE_DIR / "jobs" / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def job_output_dir(job_id: str) -> Path:
    d = BUCKET_DIR / "outputs" / job_id
    d.mkdir(parents=True, exist_ok=True)
    return d
