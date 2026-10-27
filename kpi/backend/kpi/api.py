"""KPI API. Reads the views in sql/views.sql; serves the built dashboard from ./static.
Every date is a UTC day; ranges are inclusive and default to the last 28 days through today."""
import datetime as dt
import os
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, db, ingest

app = FastAPI(title="Stereo3D Studio KPIs", docs_url="/api/docs", openapi_url="/api/openapi.json")

Grain = Literal["day", "week", "month"]

SOURCES = [
    ("conversions", "Runs (conversions)", "select min(day) as f, max(day) as t from v_conversion"),
    ("projects", "Projects", "select min(day) as f, max(day) as t from v_project"),
    ("customers", "Billing accounts (customers)", "select min(day) as f, max(day) as t from v_customer"),
    ("billing_batches", "Billing batches", "select min(created_at)::date as f, max(created_at)::date as t from v_batch"),
    ("site_analytics", "Website visits (Vercel Web Analytics)", "select min(date) as f, max(date) as t from site_daily"),
]


@app.on_event("startup")
def startup() -> None:
    try:
        db.migrate()
    except Exception as e:  # the ingest container also migrates; the API must still come up
        print("migrate skipped:", e, flush=True)


# -- helpers ------------------------------------------------------------------------------

def period(from_: str | None, to: str | None) -> tuple[dt.date, dt.date]:
    """The records are live, so the default range ends today (UTC)."""
    try:
        end = dt.date.fromisoformat(to) if to else dt.datetime.now(dt.timezone.utc).date()
        start = dt.date.fromisoformat(from_) if from_ else end - dt.timedelta(days=27)
    except ValueError as e:
        raise HTTPException(400, f"bad date: {e}")
    if start > end:
        start, end = end, start
    return start, end


def previous(start: dt.date, end: dt.date) -> tuple[dt.date, dt.date]:
    length = (end - start).days + 1
    return start - dt.timedelta(days=length), start - dt.timedelta(days=1)


def bucket_of(day: dt.date, grain: str) -> dt.date:
    if grain == "week":
        return day - dt.timedelta(days=day.weekday())
    if grain == "month":
        return day.replace(day=1)
    return day


def buckets(start: dt.date, end: dt.date, grain: str) -> list[dt.date]:
    out, d = [], bucket_of(start, grain)
    while d <= end:
        out.append(d)
        if grain == "day":
            d += dt.timedelta(days=1)
        elif grain == "week":
            d += dt.timedelta(days=7)
        else:
            d = (d + dt.timedelta(days=32)).replace(day=1)
    return out


def q(conn, sql: str, params=()):
    return conn.execute(sql, params).fetchall()


def one(conn, sql: str, params=()):
    return conn.execute(sql, params).fetchone()


def num(v) -> float | None:
    return float(v) if v is not None else None


def usd(cents) -> float:
    return round(float(cents or 0) / 100.0, 2)


def ratio(a, b) -> float | None:
    a, b = float(a or 0), float(b or 0)
    return a / b if b else None


def when(v) -> str | None:
    return v.isoformat() if v is not None else None


def card(key: str, label: str, value, prev, unit: str = "count", note: str | None = None) -> dict:
    return {"key": key, "label": label, "value": num(value), "previous": num(prev), "unit": unit, "note": note}


def series_rows(rows, start: dt.date, end: dt.date, grain: str, keys: list[str]) -> list[dict]:
    """Rows keyed by bucket (a `bucket` column) -> one dict per bucket in the range, zeros filled."""
    by = {r["bucket"]: r for r in rows}
    out = []
    for b in buckets(start, end, grain):
        r = by.get(b)
        out.append({"date": b.isoformat(), **{k: (num(r[k]) or 0.0) if r else 0.0 for k in keys}})
    return out


# -- meta -----------------------------------------------------------------------------------

@app.get("/api/meta")
def meta():
    out = []
    with db.connect() as conn:
        for sid, label, sql in SOURCES:
            run = one(conn, "select status, detail, finished_at, started_at from ingest_run where source = %s order by started_at desc limit 1", (sid,))
            rng = one(conn, sql)
            status = "never"
            if run:
                status = "error" if run["status"] == "error" else ("pending" if run["status"] == "running" else "ok")
                if status == "ok" and (run["detail"] or "").startswith("skipped"):
                    status = "skipped"
            if status == "ok" and rng["f"] is None:
                status = "pending"
            out.append({
                "id": sid, "label": label, "status": status,
                "last_run": (run["finished_at"] or run["started_at"]).isoformat() if run else None,
                "detail": run["detail"] if run else None,
                "from": rng["f"].isoformat() if rng["f"] else None,
                "to": rng["t"].isoformat() if rng["t"] else None,
            })
        other_currency = one(conn, "select count(*) as n from v_currency_check")["n"]
    return {"generated_at": dt.datetime.now(dt.timezone.utc).isoformat(), "currency": "USD", "timezone": "UTC",
            "app": {"name": config.APP_NAME, "firestore_env": config.FIRESTORE_ENV}, "sources": out,
            "other_currency_records": int(other_currency)}


# -- overview ---------------------------------------------------------------------------------

def overview_period(conn, a: dt.date, b: dt.date) -> dict:
    cash = one(conn, """select coalesce(sum(cents), 0) as cents, count(*) as payments, count(distinct uid) as payers
                        from v_cash where day between %s and %s""", (a, b))
    new_payers = one(conn, "select count(*) as n from v_payer where first_paid_day between %s and %s", (a, b))["n"]
    accounts = one(conn, "select count(*) as n from v_customer where day between %s and %s", (a, b))["n"]
    runs = one(conn, """select count(*) as runs, count(*) filter (where state = 'succeeded') as succeeded,
                               count(*) filter (where billed_cents > 0) as paid_runs, count(distinct uid) as users
                        from v_conversion where day between %s and %s""", (a, b))
    return {"cash": usd(cash["cents"]), "payments": cash["payments"], "payers": cash["payers"], "new_payers": new_payers,
            "accounts": accounts, "runs": runs["runs"], "succeeded": runs["succeeded"], "paid_runs": runs["paid_runs"],
            "users": runs["users"], "per_payer": ratio(usd(cash["cents"]), cash["payers"])}


@app.get("/api/overview", summary="Cash collected, paying and new customers, value per payer, runs by step and state")
def overview(from_: str | None = Query(None, alias="from"), to: str | None = None, grain: Grain = "day"):
    start, end = period(from_, to)
    p_start, p_end = previous(start, end)
    rng = (start, end)
    with db.connect() as conn:
        cur, prev = overview_period(conn, start, end), overview_period(conn, p_start, p_end)
        lifetime = one(conn, """select coalesce(sum(paid_cents), 0) as cents, count(*) as payers, coalesce(sum(payments), 0) as payments
                                from v_payer""")
        gateway_lifetime = one(conn, "select coalesce(sum(lifetime_paid_cents), 0) as cents, count(*) as accounts, "
                                     "count(*) filter (where has_card) as with_card, count(*) filter (where account_deleted) as deleted from v_customer")
        owed = one(conn, """select coalesce(sum(outstanding_cents) filter (where pi_status = 'batched'), 0) as in_batches,
                                   coalesce(sum(outstanding_cents) filter (where pi_status in ('charge_failed', 'capture_failed')), 0) as refused,
                                   coalesce(sum(outstanding_cents) filter (where pi_status not in ('batched', 'charge_failed', 'capture_failed')), 0) as pending
                            from v_conversion""")
        cash_series = q(conn, """select date_trunc(%s::text, day::timestamp)::date as bucket,
                                        sum(cents) filter (where source = 'batch') / 100.0 as batch,
                                        sum(cents) filter (where source = 'charge') / 100.0 as charge,
                                        sum(cents) filter (where source = 'hold_capture') / 100.0 as hold_capture,
                                        sum(cents) / 100.0 as cash, count(distinct uid) as payers
                                 from v_cash where day between %s and %s group by 1""", (grain, *rng))
        people_series = q(conn, """select bucket, sum(new_payers) as new_payers, sum(accounts) as accounts from (
                                     select date_trunc(%s::text, first_paid_day::timestamp)::date as bucket, count(*) as new_payers, 0 as accounts
                                       from v_payer where first_paid_day between %s and %s group by 1
                                     union all
                                     select date_trunc(%s::text, day::timestamp)::date, 0, count(*) from v_customer where day between %s and %s group by 1
                                   ) t group by 1""", (grain, *rng, grain, *rng))
        run_series = q(conn, """select date_trunc(%s::text, day::timestamp)::date as bucket, count(*) as runs,
                                       count(*) filter (where run_type = 'depth_preview') as depth_preview,
                                       count(*) filter (where run_type = 'stereo_preview') as stereo_preview,
                                       count(*) filter (where run_type = 'production') as production,
                                       count(*) filter (where run_type = 'image') as image,
                                       count(*) filter (where run_type = 'video') as video
                                from v_conversion where day between %s and %s group by 1""", (grain, *rng))
        by_step = q(conn, """select run_type, state, count(*) as runs, count(distinct uid) as users, sum(billed_cents) as billed_cents
                             from v_conversion where day between %s and %s group by 1, 2""", rng)
        payers = q(conn, """select p.uid, p.first_paid_at, p.last_paid_at, p.payments, p.paid_cents, c.created_at as account_at,
                                   coalesce(c.lifetime_paid_cents, 0) as gateway_cents,
                                   (select count(*) from v_conversion v where v.uid = p.uid) as runs
                            from v_payer p left join v_customer c on c.uid = p.uid
                            order by p.paid_cents desc, p.first_paid_at""")
    cards = [
        card("cash", "Cash collected", cur["cash"], prev["cash"], "usd", f"{cur['payments']} payments"),
        card("payers", "Paying customers", cur["payers"], prev["payers"], note="paid at least once in the range"),
        card("new_payers", "New paying customers", cur["new_payers"], prev["new_payers"], note="first payment in the range"),
        card("accounts", "New billing accounts", cur["accounts"], prev["accounts"], note="customers records created"),
        card("per_payer", "Average per payer", cur["per_payer"], prev["per_payer"], "usd", "cash ÷ paying customers"),
        card("runs", "Runs", cur["runs"], prev["runs"], note=f"{cur['users']} people"),
        card("succeeded", "Runs succeeded", cur["succeeded"], prev["succeeded"]),
        card("paid_runs", "Paid runs succeeded", cur["paid_runs"], prev["paid_runs"], note="a quote above zero"),
    ]
    order = ["depth_preview", "stereo_preview", "production", "video", "image"]
    states = ["succeeded", "failed", "canceled", "expired", "processing", "paid", "created"]
    steps: dict[str, dict] = {}
    for r in by_step:
        s = steps.setdefault(r["run_type"], {"run_type": r["run_type"], "total": 0, "billed_usd": 0.0, "states": {}})
        s["states"][r["state"]] = int(r["runs"])
        s["total"] += int(r["runs"])
        s["billed_usd"] += usd(r["billed_cents"])
    step_rows = sorted(steps.values(), key=lambda s: order.index(s["run_type"]) if s["run_type"] in order else 99)
    seen_states = sorted({k for s in step_rows for k in s["states"]}, key=lambda k: states.index(k) if k in states else 99)
    lifetime_cash = usd(lifetime["cents"])
    return {
        "from": start.isoformat(), "to": end.isoformat(), "grain": grain,
        "previous": {"from": p_start.isoformat(), "to": p_end.isoformat()},
        "cards": cards,
        "lifetime": {
            "cash": lifetime_cash, "payers": int(lifetime["payers"]), "payments": int(lifetime["payments"]),
            "per_payer": ratio(lifetime_cash, lifetime["payers"]),
            "gateway_total": usd(gateway_lifetime["cents"]), "accounts": int(gateway_lifetime["accounts"]),
            "accounts_with_card": int(gateway_lifetime["with_card"]), "accounts_deleted": int(gateway_lifetime["deleted"]),
            "owed_in_batches": usd(owed["in_batches"]), "owed_refused": usd(owed["refused"]), "owed_pending": usd(owed["pending"]),
        },
        "cash_series": series_rows(cash_series, start, end, grain, ["cash", "batch", "charge", "hold_capture", "payers"]),
        "people_series": series_rows(people_series, start, end, grain, ["new_payers", "accounts"]),
        "run_series": series_rows(run_series, start, end, grain, ["runs", "depth_preview", "stereo_preview", "production", "image", "video"]),
        "by_step": step_rows, "states": seen_states,
        "payers": [{"uid": r["uid"], "first_paid_at": when(r["first_paid_at"]), "last_paid_at": when(r["last_paid_at"]),
                    "account_at": when(r["account_at"]), "payments": int(r["payments"]), "paid": usd(r["paid_cents"]),
                    "gateway_total": usd(r["gateway_cents"]), "runs": int(r["runs"])} for r in payers],
    }


# -- errors -------------------------------------------------------------------------------------

def run_row(r: dict) -> dict:
    return {"id": r["id"], "uid": r["uid"], "created_at": when(r["created_at"]), "updated_at": when(r.get("updated_at")),
            "run_type": r["run_type"], "preset": r["preset"], "state": r["state"], "stage": r.get("stage"),
            "progress": num(r.get("progress")), "quote": usd(r.get("quote_cents")),
            "error_code": r.get("error_code"), "error_message": r.get("error_message"),
            "error_detail": (r.get("error_detail") or "")[:600] or None, "cost_usd": num(r.get("cost_usd"))}


@app.get("/api/errors", summary="Failure rates per step and day, failed and canceled runs, overdue runs, user reports, billing problems")
def errors(from_: str | None = Query(None, alias="from"), to: str | None = None, grain: Grain = "day"):
    start, end = period(from_, to)
    rng = (start, end)
    with db.connect() as conn:
        steps = q(conn, """select run_type,
                                  count(*) filter (where terminal) as ended,
                                  count(*) filter (where state = 'succeeded') as succeeded,
                                  count(*) filter (where state = 'failed') as failed,
                                  count(*) filter (where state = 'canceled') as canceled,
                                  count(*) filter (where state = 'expired') as expired,
                                  count(*) filter (where not terminal) as running
                           from v_conversion where day between %s and %s group by 1 order by 2 desc""", rng)
        series = q(conn, """select date_trunc(%s::text, day::timestamp)::date as bucket,
                                   count(*) filter (where state = 'succeeded') as succeeded,
                                   count(*) filter (where state = 'failed') as failed,
                                   count(*) filter (where state = 'canceled') as canceled,
                                   count(*) filter (where state = 'expired') as expired
                            from v_conversion where day between %s and %s group by 1""", (grain, *rng))
        codes = q(conn, """select coalesce(error_code, '(none)') as code, coalesce(stage, '(none)') as stage, count(*) as runs,
                                  max(created_at) as last_at
                           from v_conversion where state = 'failed' and day between %s and %s group by 1, 2 order by 3 desc, 4 desc""", rng)
        failed = q(conn, "select * from v_conversion where state = 'failed' and day between %s and %s order by created_at desc limit 100", rng)
        canceled = q(conn, "select * from v_conversion where state in ('canceled', 'expired') and day between %s and %s order by created_at desc limit 100", rng)
        overdue = q(conn, "select * from v_overdue order by coalesce(overdue_alerted_at, run_start) desc limit 100")
        reports = q(conn, "select * from v_report order by at desc limit 100")
        reports_in_range = one(conn, "select count(*) as n from v_report where at::date between %s and %s", rng)["n"]
        billing = q(conn, """select id, uid, created_at, run_type, preset, state, pi_status, quote_cents, settle_error, batch_id
                             from v_conversion where pi_status in ('charge_failed', 'capture_failed', 'cancel_failed')
                                or (settle_error is not null and pi_status <> 'succeeded')
                             order by created_at desc limit 100""")
        batches = q(conn, """select id, uid, state, total_cents, item_count, opened_at, closed_at, close_reason, settle_error, updated_at
                             from v_batch where state = 'failed' or (state = 'charging' and updated_at < now() - interval '1 hour')
                             order by updated_at desc""")
    by_step = []
    tot = {"ended": 0, "succeeded": 0, "failed": 0, "canceled": 0, "expired": 0, "running": 0}
    for r in steps:
        d = {k: int(r[k]) for k in tot}
        for k in tot:
            tot[k] += d[k]
        by_step.append({"run_type": r["run_type"], **d, "failure_rate": ratio(d["failed"], d["succeeded"] + d["failed"]),
                        "cancel_rate": ratio(d["canceled"], d["ended"])})
    pts = series_rows(series, start, end, grain, ["succeeded", "failed", "canceled", "expired"])
    for p in pts:
        p["failure_rate"] = ratio(p["failed"], p["succeeded"] + p["failed"])
    return {
        "from": start.isoformat(), "to": end.isoformat(), "grain": grain,
        "totals": {**tot, "failure_rate": ratio(tot["failed"], tot["succeeded"] + tot["failed"]),
                   "cancel_rate": ratio(tot["canceled"], tot["ended"]), "reports": int(reports_in_range)},
        "by_step": by_step, "series": pts,
        "codes": [{"code": r["code"], "stage": r["stage"], "runs": int(r["runs"]), "last_at": when(r["last_at"])} for r in codes],
        "failed": [run_row(r) for r in failed],
        "canceled": [run_row(r) for r in canceled],
        "overdue": [{**run_row(r), "expected_seconds": r["expected_seconds"], "overdue_after_seconds": int(r["overdue_after_seconds"]),
                     "run_start": when(r["run_start"]), "alerted_at": when(r["overdue_alerted_at"]), "overdue_now": bool(r["overdue_now"]),
                     "running_seconds": r["running_for"].total_seconds() if r["running_for"] else None,
                     "reports": int(r["report_count"])} for r in overdue],
        "reports": [{"conversion_id": r["conversion_id"], "uid": r["uid"], "run_type": r["run_type"], "preset": r["preset"],
                     "state": r["state"], "stage": r["stage"], "at": when(r["at"]), "note": r["note"]} for r in reports],
        "billing": [{"id": r["id"], "uid": r["uid"], "created_at": when(r["created_at"]), "run_type": r["run_type"],
                     "preset": r["preset"], "state": r["state"], "pi_status": r["pi_status"], "quote": usd(r["quote_cents"]),
                     "settle_error": (r["settle_error"] or "")[:300] or None, "batch_id": r["batch_id"]} for r in billing],
        "batches": [{"id": r["id"], "uid": r["uid"], "state": r["state"], "total": usd(r["total_cents"]), "runs": int(r["item_count"]),
                     "opened_at": when(r["opened_at"]), "closed_at": when(r["closed_at"]), "close_reason": r["close_reason"],
                     "settle_error": (r["settle_error"] or "")[:300] or None, "updated_at": when(r["updated_at"])} for r in batches],
    }


# -- margin ----------------------------------------------------------------------------------------

MARGIN_SUMS = """count(*) filter (where source = 'run') as runs,
                 count(*) filter (where source = 'analyze') as analyses,
                 count(*) filter (where not has_cost) as without_cost,
                 coalesce(sum(revenue_usd), 0) as revenue, coalesce(sum(billed_usd), 0) as billed,
                 coalesce(sum(outstanding_usd), 0) as outstanding, coalesce(sum(waived_usd), 0) as waived,
                 count(*) filter (where waived) as waived_runs, coalesce(sum(cost_usd), 0) as cost"""


def margin_row(r: dict) -> dict:
    revenue, billed, cost = float(r["revenue"]), float(r["billed"]), float(r["cost"])
    n = int(r["runs"]) + int(r["analyses"])
    return {"runs": int(r["runs"]), "analyses": int(r["analyses"]), "without_cost": int(r["without_cost"]),
            "revenue": round(revenue, 2), "billed": round(billed, 2), "outstanding": round(float(r["outstanding"]), 2),
            "waived": round(float(r["waived"]), 2), "waived_runs": int(r["waived_runs"]), "cost": round(cost, 4),
            "margin": round(revenue - cost, 2), "margin_pct": ratio(revenue - cost, revenue),
            "billed_margin_pct": ratio(billed - cost, billed),
            "cost_per_item": ratio(cost, n), "revenue_per_item": ratio(revenue, n)}


@app.get("/api/margin", summary="Revenue against GPU cost per step, preset and day")
def margin(from_: str | None = Query(None, alias="from"), to: str | None = None, grain: Grain = "day"):
    start, end = period(from_, to)
    rng = (start, end)
    with db.connect() as conn:
        total = one(conn, f"select {MARGIN_SUMS} from v_margin_item where day between %s and %s", rng)
        by_step = q(conn, f"select run_type, {MARGIN_SUMS} from v_margin_item where day between %s and %s group by 1 order by sum(cost_usd) desc", rng)
        by_preset = q(conn, f"""select run_type, preset, {MARGIN_SUMS} from v_margin_item where day between %s and %s
                                group by 1, 2 order by 1, sum(cost_usd) desc""", rng)
        series = q(conn, f"select date_trunc(%s::text, day::timestamp)::date as bucket, {MARGIN_SUMS} from v_margin_item where day between %s and %s group by 1",
                   (grain, *rng))
        waived = q(conn, """select id, uid, created_at, run_type, preset, state, waived_cents, waived_reason, cost_usd
                            from v_conversion where waived and day between %s and %s order by created_at desc""", rng)
        top = q(conn, """select * from v_conversion where day between %s and %s and cost_usd > 0 order by cost_usd desc limit 15""", rng)
    pts = []
    by_bucket = {r["bucket"]: r for r in series}
    for b in buckets(start, end, grain):
        r = by_bucket.get(b)
        m = margin_row(r) if r else margin_row({k: 0 for k in ("runs", "analyses", "without_cost", "revenue", "billed", "outstanding", "waived", "waived_runs", "cost")})
        pts.append({"date": b.isoformat(), "revenue": m["revenue"], "cost": m["cost"], "margin": m["margin"], "billed": m["billed"]})
    order = ["depth_preview", "stereo_preview", "production", "video", "image", "analyze"]
    return {
        "from": start.isoformat(), "to": end.isoformat(), "grain": grain,
        "total": margin_row(total),
        "by_step": sorted([{"run_type": r["run_type"], **margin_row(r)} for r in by_step],
                          key=lambda s: order.index(s["run_type"]) if s["run_type"] in order else 99),
        "by_preset": [{"run_type": r["run_type"], "preset": r["preset"], **margin_row(r)} for r in by_preset],
        "series": pts,
        "waived": [{"id": r["id"], "uid": r["uid"], "created_at": when(r["created_at"]), "run_type": r["run_type"], "preset": r["preset"],
                    "state": r["state"], "waived": usd(r["waived_cents"]), "reason": r["waived_reason"], "cost_usd": num(r["cost_usd"])}
                   for r in waived],
        "top_cost": [{**run_row(r), "revenue": usd(r["collected_cents"]), "billed": usd(r["billed_cents"])} for r in top],
    }


# -- the website --------------------------------------------------------------------------------------

SITE_TOP = 25


def site_totals(conn, a: dt.date, b: dt.date) -> dict:
    r = one(conn, """select coalesce(sum(visitors), 0) as visitors, coalesce(sum(pageviews), 0) as pageviews
                     from site_daily where dimension = 'total' and date between %s and %s""", (a, b))
    e = one(conn, "select coalesce(sum(count), 0) as events from site_event_daily where dimension = 'name' and date between %s and %s", (a, b))
    v, pv = int(r["visitors"]), int(r["pageviews"])
    return {"visitors": v, "pageviews": pv, "events": int(e["events"]), "pages_per_visitor": ratio(pv, v)}


def site_rows(rows, label=lambda v: v, total: float | None = None, key: str = "pageviews") -> list[dict]:
    out = []
    for r in rows:
        d = {k: (int(v or 0) if k in ("visitors", "pageviews", "count") else v) for k, v in r.items()}
        d["label"] = label(r["value"])
        d["share"] = ratio(d.get(key) or 0, total) if total else None
        out.append(d)
    return out


@app.get("/api/site", summary="The website's visitors, pages, referrers, countries, devices and custom events")
def site_(from_: str | None = Query(None, alias="from"), to: str | None = None, limit: int = Query(SITE_TOP, ge=1, le=200)):
    """Visitors are Vercel's per day and page: a sum over days or groups counts a returning visitor
    once per day and page, so the breakdowns' visitors do not add up to the total."""
    start, end = period(from_, to)
    p_start, p_end = previous(start, end)
    rng = (start, end)
    with db.connect() as conn:
        current, prev = site_totals(conn, start, end), site_totals(conn, p_start, p_end)
        days = {r["date"]: r for r in q(conn, """select date, visitors, pageviews from site_daily
                                                  where dimension = 'total' and date between %s and %s""", rng)}
        ev_days = {r["date"]: r for r in q(conn, """select date, sum(count) as events from site_event_daily
                                                     where dimension = 'name' and date between %s and %s group by 1""", rng)}
        coverage = one(conn, """select (select min(date) from site_daily) as site_from, (select max(date) from site_daily) as site_to,
                                       (select count(*) from site_daily where dimension = 'utm_source') as utm_rows""")
        last = one(conn, "select status, detail from ingest_run where source = 'site_analytics' order by started_at desc limit 1")

        def dim(name: str, lim: int | None = None):
            return q(conn, f"""select value, sum(visitors) as visitors, sum(pageviews) as pageviews from site_daily
                               where dimension = %s and date between %s and %s group by 1 order by 3 desc, 2 desc, 1
                               {'limit %s' if lim else ''}""", (name, *rng, *((lim,) if lim else ())))

        countries, referrers, pages, devices, utm = dim("country", limit), dim("referrer", limit), dim("path", limit), dim("device"), dim("utm_source", limit)
        events = q(conn, """select value, sum(count) as count, sum(visitors) as visitors from site_event_daily
                            where dimension = 'name' and date between %s and %s group by 1 order by 2 desc, 1""", rng)
    series = []
    d = start
    while d <= end:
        r, e = days.get(d), ev_days.get(d)
        series.append({"date": d.isoformat(), "visitors": float(r["visitors"]) if r else 0.0,
                       "pageviews": float(r["pageviews"]) if r else 0.0, "events": float(e["events"]) if e else 0.0})
        d += dt.timedelta(days=1)
    notes = []
    if coverage["site_from"] is None:
        why = (last["detail"] if last and last["detail"] else "the site_analytics source has not run yet")
        notes.append(f"No website data yet: {why}")
    elif start < coverage["site_from"]:
        notes.append(f"Website visits start on {coverage['site_from'].isoformat()}: Vercel answers only the last 366 days.")
    pv = current["pageviews"]
    return {
        "from": start.isoformat(), "to": end.isoformat(), "notes": notes,
        "current": current, "previous": {**prev, "from": p_start.isoformat(), "to": p_end.isoformat()},
        "coverage": {"site_from": when(coverage["site_from"]), "site_to": when(coverage["site_to"]), "utm": bool(coverage["utm_rows"])},
        "series": series,
        "countries": site_rows(countries, lambda v: v or "Unknown", pv),
        "referrers": site_rows(referrers, lambda v: v or "(none: typed, bookmarked or an app)", pv),
        "pages": site_rows(pages, lambda v: v, pv),
        "devices": site_rows(devices, lambda v: v or "Unknown", pv),
        "utm_sources": site_rows(utm, lambda v: v or "(none)", pv),
        "events": site_rows(events, lambda v: v or "(unnamed)", current["events"], "count"),
    }


# -- ingest ---------------------------------------------------------------------------------------------

@app.post("/api/ingest/run")
def ingest_run(sources: str | None = Query(None, description="comma-separated source ids; omitted means every source")):
    """Queues a pass for the ingest loop, which picks it up within 30 seconds."""
    names = ingest.parse_sources(sources) if sources else []
    if sources and not names:
        raise HTTPException(400, "no known source in `sources`")
    with db.connect() as conn:
        conn.execute("insert into ingest_request (sources) values (%s)", (",".join(names) or None,))
        conn.commit()
    what = ", ".join(names) if names else "every source"
    return {"started": True, "detail": f"The ingest loop picks the request up within 30 seconds ({what})."}


# -- static dashboard -------------------------------------------------------------------------------------

if os.path.isdir(config.STATIC_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(config.STATIC_DIR, "assets")), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        root = os.path.realpath(config.STATIC_DIR)
        candidate = os.path.realpath(os.path.join(root, path))
        if path and not path.startswith("api/") and candidate.startswith(root + os.sep) and os.path.isfile(candidate):
            return FileResponse(candidate)
        if path.startswith("api/"):
            raise HTTPException(404, "no such endpoint")
        # The hashed assets cache for ever; the page that names them must not.
        return FileResponse(os.path.join(config.STATIC_DIR, "index.html"), headers={"Cache-Control": "no-cache"})
else:
    @app.get("/", include_in_schema=False)
    def root():
        return JSONResponse({"detail": "dashboard not built; see /api/docs"})
