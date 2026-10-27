"""Settings from the environment. Secrets are read, never logged."""
import os


def env(name: str, default: str | None = None) -> str:
    value = os.environ.get(name, default)
    if value is None or value == "":
        raise SystemExit(f"{name} is not set")
    return value


DATABASE_URL = env("DATABASE_URL", "postgresql://kpi:kpi@localhost:5436/kpi")
APP_NAME = env("APP_NAME", "Stereo3D Studio")
# How often the ingest loop runs a full pass, in hours. The records are small (hundreds of documents),
# so a pass costs a few reads; the dashboard's Refresh button queues one at any time.
INGEST_INTERVAL_HOURS = float(env("INGEST_INTERVAL_HOURS", "1"))

# Firestore (the gateway's records, gateway/internal/store). Empty FIRESTORE_SA_PATH means the
# Firestore sources skip. The key is the Spatial Video Studio KPI's read-only service account
# (roles/datastore.viewer) on the same GCP project.
FIRESTORE_SA_PATH = os.environ.get("FIRESTORE_SA_PATH", "")
FIRESTORE_PROJECT = os.environ.get("FIRESTORE_PROJECT", "spatial-video-studio")
# The gateway's environment suffix: conversions_<env>, projects_<env>, customers_<env>,
# billing_batches_<env>. Always prod for the dashboard; test exists for the gateway's own checks.
FIRESTORE_ENV = env("FIRESTORE_ENV", "prod")
# How far back each incremental pass re-reads updated_at (server clocks and transactions can land
# slightly out of order), and how often a pass reads every document again instead (which also drops
# rows whose document was deleted).
FIRESTORE_REREAD_MINUTES = int(env("FIRESTORE_REREAD_MINUTES", "10"))
FIRESTORE_FULL_SCAN_HOURS = float(env("FIRESTORE_FULL_SCAN_HOURS", "24"))

# Vercel Web Analytics of the website. Empty VERCEL_TOKEN means the site_analytics source skips; the
# token must be able to read the stereo3d-studio project (a team token scoped to other projects
# answers 404). Ids from web/.vercel/project.json.
VERCEL_TOKEN = os.environ.get("VERCEL_TOKEN", "")
VERCEL_TEAM_ID = env("VERCEL_TEAM_ID", "team_h8LpJIFfbz5kNs7lVb82tdSP")
VERCEL_PROJECT_ID = env("VERCEL_PROJECT_ID", "prj_LPNpdK89zkLnqKOA1jJIN8XeM3ry")
SITE_REREAD_DAYS = int(env("SITE_REREAD_DAYS", "3"))

STATIC_DIR = os.environ.get("STATIC_DIR", os.path.join(os.path.dirname(__file__), "..", "static"))
SQL_DIR = os.environ.get("SQL_DIR", os.path.join(os.path.dirname(__file__), "..", "sql"))
