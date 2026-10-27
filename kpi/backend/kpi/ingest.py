"""Pulls every source into Postgres. `python -m kpi.ingest --once` for one pass, `--loop` to keep
running (one pass at start, then every INGEST_INTERVAL_HOURS, or when the API queues a request),
`--only conversions,site_analytics` for some sources.

Read-only towards every source: Firestore is only queried, never written."""
import argparse
import datetime as dt
import json
import os
import time
import traceback

from . import config, db, firestore, site

# source id -> (Runner method, Firestore collection prefix or None), in the order run_all runs them.
# A request may name a subset (ingest_request.sources, `--only`); anything else is ignored.
SOURCES = {
    "conversions": "conversions",
    "projects": "projects",
    "customers": "customers",
    "billing_batches": "billing_batches",
    "site_analytics": "site_analytics",
}

# Firestore source -> (collection prefix, landing table). The collection is <prefix>_<FIRESTORE_ENV>.
COLLECTIONS = {
    "conversions": ("conversions", "fs_conversion"),
    "projects": ("projects", "fs_project"),
    "customers": ("customers", "fs_customer"),
    "billing_batches": ("billing_batches", "fs_batch"),
}


def log(*a):
    print(dt.datetime.now(dt.timezone.utc).strftime("%H:%M:%S"), *a, flush=True)


def json_ready(value):
    """Decoded Firestore values -> JSON: datetimes as ISO strings, the rest as is."""
    if isinstance(value, dt.datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=dt.timezone.utc)
        return value.astimezone(dt.timezone.utc).isoformat()
    if isinstance(value, dict):
        return {k: json_ready(v) for k, v in value.items()}
    if isinstance(value, list):
        return [json_ready(v) for v in value]
    return value


def scrub(doc: dict) -> dict:
    """The document as stored: without Firestore's name fields, the Stripe client secret of a 3DS
    hold, and email addresses (the dashboard needs none of them)."""
    out = {k: v for k, v in doc.items() if not k.startswith("_")}
    stripe = out.get("stripe")
    if isinstance(stripe, dict):
        out["stripe"] = {k: v for k, v in stripe.items() if k != "client_secret"}
    out.pop("email", None)
    support = out.get("support")
    if isinstance(support, dict) and isinstance(support.get("reports"), list):
        support = dict(support)
        support["reports"] = [{k: v for k, v in r.items() if k != "email"} if isinstance(r, dict) else r
                              for r in support["reports"]]
        out["support"] = support
    return json_ready(out)


def firestore_configured() -> str | None:
    """None when the Firestore sources can run, else the reason to skip (never the path's content)."""
    path = config.FIRESTORE_SA_PATH
    if not path:
        return "skipped: FIRESTORE_SA_PATH not set"
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        return "skipped: FIRESTORE_SA_FILE is empty or missing (set it in kpi/.env)"
    return None


def site_span(cursor: dict, today: dt.date, reread: int | None = None) -> tuple[dt.date, dt.date]:
    """The days a site_analytics pass reads: from as far back as Vercel answers (first pass) or
    `reread` days before the last day loaded, to today."""
    reread = config.SITE_REREAD_DAYS if reread is None else reread
    first = today - dt.timedelta(days=site.REACH_DAYS)
    since = first
    if cursor.get("loaded_to"):
        since = max(first, dt.date.fromisoformat(cursor["loaded_to"]) - dt.timedelta(days=reread))
    return since, today


class Runner:
    def __init__(self) -> None:
        self._firestore = None
        self._site = None

    @property
    def firestore(self) -> firestore.Client:
        if self._firestore is None:
            self._firestore = firestore.Client(config.FIRESTORE_SA_PATH, config.FIRESTORE_PROJECT)
        return self._firestore

    @property
    def site(self) -> site.Client:
        if self._site is None:
            self._site = site.Client(config.VERCEL_TOKEN, config.VERCEL_TEAM_ID, config.VERCEL_PROJECT_ID)
        return self._site

    def run(self, source: str, fn) -> None:
        with db.connect() as conn:
            run_id = conn.execute("insert into ingest_run (source) values (%s) returning id", (source,)).fetchone()["id"]
            conn.commit()
        try:
            detail = fn()
            status = "ok"
        except Exception as e:  # keep the loop alive; the failure shows in /api/meta
            detail = f"{type(e).__name__}: {e}"[:1000]
            status = "error"
            traceback.print_exc()
        with db.connect() as conn:
            conn.execute("update ingest_run set finished_at = now(), status = %s, detail = %s where id = %s",
                         (status, detail, run_id))
            conn.commit()
        log(source, status, detail)

    def load_cursor(self, source: str) -> dict:
        with db.connect() as conn:
            row = conn.execute("select cursor from ingest_cursor where source = %s", (source,)).fetchone()
        return row["cursor"] if row else {}

    def save_cursor(self, source: str, cursor: dict) -> None:
        with db.connect() as conn:
            conn.execute("""insert into ingest_cursor (source, cursor) values (%s, %s::jsonb)
                            on conflict (source) do update set cursor = excluded.cursor, updated_at = now()""",
                         (source, json.dumps(cursor)))
            conn.commit()

    # -- Firestore records ----------------------------------------------------------------

    def collection(self, source: str) -> str:
        """One Firestore collection into its landing table.

        A full scan (ordered by document name, so documents without updated_at are seen too) on the
        first pass and every FIRESTORE_FULL_SCAN_HOURS; it replaces the table, so a deleted document
        leaves it. In between, an incremental pass reads updated_at >= the last one seen minus
        FIRESTORE_REREAD_MINUTES. Customers carry no updated_at, so every customers pass is full."""
        reason = firestore_configured()
        if reason:
            return reason
        prefix, table = COLLECTIONS[source]
        coll = f"{prefix}_{config.FIRESTORE_ENV}"
        cursor = self.load_cursor(source)
        now = dt.datetime.now(dt.timezone.utc)
        last_full = dt.datetime.fromisoformat(cursor["full_at"]) if cursor.get("full_at") else None
        full = (source == "customers" or last_full is None or not cursor.get("updated_at")
                or now - last_full > dt.timedelta(hours=config.FIRESTORE_FULL_SCAN_HOURS))
        since = None
        if not full:
            since = dt.datetime.fromisoformat(cursor["updated_at"]) - dt.timedelta(minutes=config.FIRESTORE_REREAD_MINUTES)
        seen: set[str] = set()
        newest = dt.datetime.fromisoformat(cursor["updated_at"]) if cursor.get("updated_at") else None
        n = 0
        pages = self.firestore.iterate(coll, "__name__") if full else self.firestore.iterate(coll, "updated_at", where_after=since)
        with db.connect() as conn:
            for page in pages:
                rows = []
                for d in page:
                    seen.add(d["_id"])
                    upd = d.get("updated_at") if isinstance(d.get("updated_at"), dt.datetime) else None
                    if upd and (newest is None or upd > newest):
                        newest = upd
                    rows.append((d["_id"], json.dumps(scrub(d)), upd))
                conn.cursor().executemany(
                    f"""insert into {table} (id, doc, updated_at) values (%s, %s::jsonb, %s)
                        on conflict (id) do update set doc = excluded.doc, updated_at = excluded.updated_at, loaded_at = now()""",
                    rows)
                n += len(rows)
            removed = 0
            if full:
                # The scan saw every document: rows it did not see were deleted in Firestore.
                removed = conn.execute(f"delete from {table} where not (id = any(%s))", (list(seen),)).rowcount
            conn.commit()
        if full:
            cursor["full_at"] = now.isoformat()
        if newest:
            cursor["updated_at"] = newest.isoformat()
        self.save_cursor(source, cursor)
        what = f"full scan of {coll}: {n} documents" + (f", {removed} removed" if removed else "")
        return what if full else f"{coll} since {since.isoformat(timespec='seconds')}: {n} documents"

    def conversions(self) -> str:
        return self.collection("conversions")

    def projects(self) -> str:
        return self.collection("projects")

    def customers(self) -> str:
        return self.collection("customers")

    def billing_batches(self) -> str:
        return self.collection("billing_batches")

    # -- The website -------------------------------------------------------------------------

    def site_analytics(self, today: dt.date | None = None) -> str:
        """The site's visits per day by path, country, referrer, device (and UTM source where the plan
        allows it), and the web app's custom events by name, a calendar month per request. The first
        pass reads all Vercel still answers (366 days); later passes re-read SITE_REREAD_DAYS before
        the last day loaded. Each window replaces its days per dimension, so a re-read never adds up
        twice; a dimension the plan refuses (UTM, HTTP 402) is left untouched."""
        if not config.VERCEL_TOKEN:
            return "skipped: VERCEL_TOKEN is empty (a token that can read the stereo3d-studio project; see kpi/README.md)"
        today = today or dt.date.today()
        cursor = self.load_cursor("site_analytics")
        since, until = site_span(cursor, today)
        visits = events = months = 0
        refused: list[str] = []
        try:
            for a, b in site.month_windows(since, until):
                with db.connect() as conn:
                    for dim in site.VISIT_DIMS:
                        if dim in refused:
                            continue
                        try:
                            rows = self.site.visits(a, b, dim)
                        except site.PlanLimit:
                            refused.append(dim)
                            continue
                        # every group comes with a zero row per quiet day; only the total keeps them
                        rows = [r for r in rows if dim == "total" or r["visitors"] or r["pageviews"]]
                        conn.execute("delete from site_daily where dimension = %s and date between %s and %s", (dim, a, b))
                        if rows:
                            conn.cursor().executemany(
                                """insert into site_daily (date, dimension, value, pageviews, visitors) values (%s, %s, %s, %s, %s)
                                   on conflict (date, dimension, value) do update set pageviews = excluded.pageviews,
                                     visitors = excluded.visitors, loaded_at = now()""",
                                [(r["day"], dim, r["value"], r["pageviews"], r["visitors"]) for r in rows])
                        visits += len(rows)
                    for dim in site.EVENT_DIMS:
                        if f"event_{dim}" in refused:
                            continue
                        try:
                            rows = [r for r in self.site.events(a, b, dim) if r["count"] or r["visitors"]]
                        except site.PlanLimit:
                            refused.append(f"event_{dim}")
                            continue
                        conn.execute("delete from site_event_daily where event = '*' and dimension = %s and date between %s and %s",
                                     (dim, a, b))
                        if rows:
                            conn.cursor().executemany(
                                """insert into site_event_daily (date, event, dimension, value, count, visitors) values (%s, '*', %s, %s, %s, %s)
                                   on conflict (date, event, dimension, value) do update set count = excluded.count,
                                     visitors = excluded.visitors, loaded_at = now()""",
                                [(r["day"], dim, r["value"], r["count"], r["visitors"]) for r in rows])
                        events += len(rows)
                    conn.commit()
                months += 1
                cursor["loaded_to"] = b.isoformat()
                self.save_cursor("site_analytics", cursor)
        except site.NotReadable as e:
            return f"skipped: the token cannot read the stereo3d-studio project's Web Analytics ({e})"
        detail = f"{months} months {since}..{until}: {visits} visit rows, {events} event rows"
        if refused:
            detail += f"; {', '.join(refused)} refused by the plan (Web Analytics Plus)"
        return detail

    def run_all(self) -> None:
        for name in SOURCES:
            self.run(name, getattr(self, SOURCES[name]))

    def run_only(self, names: list[str]) -> None:
        """The sources named, in the canonical order; unknown names are ignored so a stale request
        can never reach getattr with an arbitrary string."""
        for name in SOURCES:
            if name in names:
                self.run(name, getattr(self, SOURCES[name]))


def parse_sources(value: str | None) -> list[str]:
    """The known source names in `value` (comma-separated), in the canonical order."""
    wanted = {n.strip() for n in (value or "").split(",") if n.strip()}
    return [n for n in SOURCES if n in wanted]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--loop", action="store_true")
    ap.add_argument("--only", help="comma-separated sources: " + ", ".join(SOURCES))
    args = ap.parse_args()
    db.migrate()
    runner = Runner()
    if args.only:
        runner.run_only(parse_sources(args.only))
        return
    runner.run_all()
    if not args.loop:
        return
    last = time.time()
    while True:
        time.sleep(30)
        with db.connect() as conn:
            req = conn.execute("update ingest_request set taken_at = now() where taken_at is null returning id, sources").fetchall()
            conn.commit()
        due = time.time() - last > config.INGEST_INTERVAL_HOURS * 3600
        if due or any(r["sources"] is None for r in req):
            runner.run_all()
            last = time.time()
        elif req:
            names = parse_sources(",".join(r["sources"] for r in req))
            if names:
                runner.run_only(names)


if __name__ == "__main__":
    main()
