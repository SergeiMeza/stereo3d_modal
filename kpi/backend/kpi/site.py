"""Vercel Web Analytics for the Stereo3D Studio website (Vercel project stereo3d-studio), the same
source as the Spatial Video Studio KPI's Website page (its ADR 0077, kpi/backend/kpi/site.py).

The query API answers per day and per one dimension:

    GET https://api.vercel.com/v1/query/web-analytics/{visits|events}/aggregate
        ?teamId&projectId&since=YYYY-MM-DD&until=YYYY-MM-DD&by=day&by=<dim>&limit=100[&filter=<OData>]

`until` is an inclusive day. `by` is repeated, never a comma list. `limit` caps the groups of the
dimension (not the days) and folds the rest into a group named "Others"; left out it defaults to 10,
so it is always sent. Every group comes back with a row for every day, zeros included. Visits rows
carry visitors and pageviews, event rows count and visitors. A visitor is counted once per day and
page: summing visitors over days or groups counts a returning visitor again.

The Pro plan answers only the latest 366 days; the UTM dimensions need Web Analytics Plus (HTTP 402),
which the ingest skips instead of failing. A token that cannot see the project gets HTTP 403/404,
which the ingest reports as a skip with the reason.
"""
import datetime as dt
import time

import httpx

BASE = "https://api.vercel.com/v1/query/web-analytics"
LIMIT = 100
REACH_DAYS = 365

# dashboard dimension -> Vercel `by` value. `total` asks by day alone.
VISIT_DIMS = {
    "total": None,
    "path": "requestPath",
    "country": "country",
    "referrer": "referrerHostname",
    "device": "deviceType",
    "utm_source": "utmSource",
}
# The custom events the web app sends with track() (web/src: upload_started, project_created,
# lp_cta_hero_click, add_payment_info, ...), counted per day by event name.
EVENT_DIMS = {"name": "eventName"}


class PlanLimit(Exception):
    """The query needs a plan or add-on the project does not have (HTTP 402)."""


class NotReadable(Exception):
    """The token cannot read this project's Web Analytics (HTTP 401/403/404)."""


def month_windows(start: dt.date, end: dt.date):
    """[start, end] cut at calendar month ends into inclusive spans; nothing when start > end."""
    cur = start
    while cur <= end:
        nxt = (cur.replace(day=1) + dt.timedelta(days=32)).replace(day=1)
        stop = min(nxt - dt.timedelta(days=1), end)
        yield cur, stop
        cur = stop + dt.timedelta(days=1)


def _day(row: dict) -> dt.date:
    return dt.date.fromisoformat(str(row["timestamp"])[:10])


def _value(row: dict, by: str | None) -> str:
    if by is None:
        return ""
    raw = row.get(by)
    return "" if raw is None else str(raw)


def visit_rows(data: list[dict], by: str | None) -> list[dict]:
    return [{"day": _day(r), "value": _value(r, by), "pageviews": int(r.get("pageviews") or 0),
             "visitors": int(r.get("visitors") or 0)} for r in data]


def event_rows(data: list[dict], by: str | None) -> list[dict]:
    return [{"day": _day(r), "value": _value(r, by), "count": int(r.get("count") or 0),
             "visitors": int(r.get("visitors") or 0)} for r in data]


class Client:
    def __init__(self, token: str, team_id: str, project_id: str) -> None:
        self.team_id, self.project_id = team_id, project_id
        self.http = httpx.Client(timeout=60, headers={"Authorization": f"Bearer {token}"})

    def _get(self, kind: str, since: dt.date, until: dt.date, by: str | None) -> list[dict]:
        params = [("teamId", self.team_id), ("projectId", self.project_id), ("since", since.isoformat()),
                  ("until", until.isoformat()), ("by", "day"), ("limit", str(LIMIT))]
        if by:
            params.append(("by", by))
        url = f"{BASE}/{kind}/aggregate"
        for attempt in range(5):
            try:
                r = self.http.get(url, params=params)
            except httpx.TransportError:
                if attempt == 4:
                    raise
                time.sleep(2 ** attempt)
                continue
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(2 ** attempt)
                continue
            if r.status_code == 402:
                raise PlanLimit(f"{by}: {r.text[:200]}")
            if r.status_code in (401, 403, 404):
                raise NotReadable(f"HTTP {r.status_code}: {r.text[:200]}")
            r.raise_for_status()
            return r.json().get("data") or []
        r.raise_for_status()
        return r.json().get("data") or []

    def visits(self, since: dt.date, until: dt.date, dim: str) -> list[dict]:
        by = VISIT_DIMS[dim]
        return visit_rows(self._get("visits", since, until, by), by)

    def events(self, since: dt.date, until: dt.date, dim: str) -> list[dict]:
        by = EVENT_DIMS[dim]
        return event_rows(self._get("events", since, until, by), by)
