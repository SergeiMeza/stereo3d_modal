"""Deployment environment configuration.

APP_ENV controls naming so multiple environments can coexist in one
Modal workspace. Default is "test" (deployed to the stereo-crafter-test
workspace). Set APP_ENV=prod for the production deployment.
"""

import os

APP_ENV = os.environ.get("APP_ENV", "test")

APP_NAME = f"stereo3d-{APP_ENV}"

# Web endpoint label (https://<workspace>--<label>.modal.run)
API_LABEL = f"stereo3d-api-{APP_ENV}"

# How long idle GPU containers linger before scale-down. 30s everywhere:
# long enough that a fan-out worker stays warm to pick up its next queued
# chunk (avoiding a per-wave cold-start of model weights, ~20-40s GPU),
# short enough that idle GPU cost stays low. Prod previously used 300s to
# absorb bursts, but the cold-start vs idle tradeoff favors 30s for this
# fan-out workload.
SCALEDOWN_WINDOW = 30
