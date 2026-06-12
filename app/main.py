"""Deployment entrypoint.

    modal deploy -m app.main          # deploy (workspace: stereo-crafter-test)
    modal serve -m app.main           # live-reload dev server

Importing the stage/pipeline modules registers every worker on the
shared modal.App.
"""

import modal

from app.env import API_LABEL
from app.images import web_image
from app.modal_app import app
from app.pipelines import image as _image_pipeline  # noqa: F401
from app.pipelines import video as _video_pipeline  # noqa: F401
from app.stages import image_stereo as _image_stereo  # noqa: F401
from app.stages import media as _media  # noqa: F401
from app.stages import mvhevc as _mvhevc  # noqa: F401
from app.stages import video_depth as _video_depth  # noqa: F401
from app.stages import video_depth_models as _video_depth_models  # noqa: F401
from app.stages import video_stereo as _video_stereo  # noqa: F401
from app.stages import video_stereo_m2svid as _video_stereo_m2svid  # noqa: F401


from app.common.storage import slack_secret


@app.function(image=web_image, secrets=[slack_secret], timeout=300)
@modal.concurrent(max_inputs=100)
@modal.asgi_app(label=API_LABEL)
def fastapi_app():
    from app.api.main import web_app

    return web_app
