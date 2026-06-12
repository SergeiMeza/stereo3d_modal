"""Slack notifications for pipeline lifecycle events.

The webhook URL lives in the ``slack-webhook`` Modal secret
(SLACK_WEBHOOK_URL); when the env var is absent every call is a no-op,
so local scripts and tests never need it. Sends are fire-and-forget —
a Slack outage must never fail a pipeline job.

Noise policy: stage-by-stage messages only for video jobs (a handful
per job); completion/failure messages for everything.
"""

import json
import os
import urllib.request

from app.common.debug import get_logger
from app.env import APP_ENV

logger = get_logger(__name__)

_TIMEOUT_S = 5


def notify_slack(text: str) -> None:
    """POST a message to the configured Slack webhook (no-op if unset)."""
    url = os.environ.get("SLACK_WEBHOOK_URL")
    if not url:
        return
    try:
        req = urllib.request.Request(
            url,
            data=json.dumps({"text": text}).encode(),
            headers={"Content-Type": "application/json"},
        )
        urllib.request.urlopen(req, timeout=_TIMEOUT_S)
    except Exception as exc:
        logger.warning(f"slack notification failed: {exc}")


def job_event(old: dict, new: dict) -> None:
    """Emit Slack messages for meaningful job transitions. Called from
    jobs.update_job with the pre/post state."""
    if not new.get("notify", True):
        return
    job_id = new["job_id"]
    kind = new.get("kind", "?")
    tag = f"`{job_id}` ({kind}, {APP_ENV})"

    old_status = old.get("status")
    new_status = new.get("status")

    if new_status == "completed" and old_status != "completed":
        elapsed = sum(t["seconds"] for t in new.get("timings", []))
        lines = [f"✅ {tag} completed — {elapsed:.0f}s of stage time"]
        outputs = new.get("outputs") or {}
        links = _flatten_links(outputs)
        if links:
            lines.append("  " + " · ".join(f"<{url}|{name}>" for name, url in links[:8]))
        notify_slack("\n".join(lines))
        return

    if new_status == "failed" and old_status != "failed":
        notify_slack(
            f"❌ {tag} failed at stage `{new.get('stage')}`:\n```{(new.get('error') or 'unknown')[:500]}```"
        )
        return

    # per-stage progress: video pipeline jobs only (bounded message count)
    if kind == "video" and new.get("stage") and new.get("stage") != old.get("stage"):
        notify_slack(f"🎬 {tag} → `{new['stage']}` ({new.get('progress', 0):.0%})")


def _flatten_links(outputs: dict, prefix: str = "") -> list[tuple[str, str]]:
    links = []
    for name, value in outputs.items():
        if isinstance(value, str) and value.startswith("http"):
            links.append((f"{prefix}{name}", value))
        elif isinstance(value, dict):
            links.extend(_flatten_links(value, prefix=f"{name}/"))
    return links
