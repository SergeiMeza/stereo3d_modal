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
