"""Background billing poller for the A/B run. Every 60s, snapshots the
workspace's hourly cost over a 6-HOUR SLIDING WINDOW and appends ALL
buckets to ab_timeline.log. Cost for any period = the DIFF of cumulative
bucket totals between two snapshots (each hourly bucket accrues over its
clock hour). 6h is wide enough that no bucket touching the run ever falls
out of view, so diffs are always computable. 1 call/min is well under the
measured rate limit (~2 calls/10s)."""
import time
from datetime import datetime, timezone, timedelta

import modal.billing as b

LOG = "previews/ab_V5b_depthsweep/ab_timeline.log"


def w(msg: str) -> None:
    with open(LOG, "a") as f:
        f.write(msg + "\n")


for _ in range(360):  # up to ~6h of polling
    now = datetime.now(timezone.utc)
    try:
        rows = b.workspace_billing_report(
            start=now - timedelta(hours=6), end=now, resolution="h")
        buckets: dict = {}
        for r in rows:
            k = str(r["interval_start"])
            buckets[k] = buckets.get(k, 0.0) + float(r.get("cost") or 0)
        total = sum(buckets.values())
        parts = " | ".join(f"{k[11:16]}=${v:.4f}" for k, v in sorted(buckets.items()))
        # log per-bucket AND the 6h cumulative total — diffs of TOTAL across
        # snapshots give the cost of each inter-poll interval.
        w(f"{now.strftime('%Y-%m-%dT%H:%M:%SZ')} [BILLING] total6h=${total:.4f} | {parts or 'no-data'}")
    except Exception as e:  # noqa
        s = str(e)
        tag = "RATE_LIMITED" if "RESOURCE_EXHAUSTED" in s else s[:60]
        w(f"{now.strftime('%Y-%m-%dT%H:%M:%SZ')} [BILLING] error: {tag}")
    time.sleep(60)
