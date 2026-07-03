"""Generate the A/B cost reports from the live job records.

Reads jobs.tsv (label, job_id, depth_res, output_res), pulls each job's
cost_summary + timings from the API, and writes:
  - COST_SUMMARY.md  : one row per job (totals + GPU breakdown)
  - COST_BREAKDOWN.md : per-job, per-STAGE breakdown (seconds, gpu, $)

Run after all jobs complete. Read-only on the API (no rate-limited
billing calls — these are the in-source ESTIMATES on each job record)."""
import json
import sys
import urllib.request

BASE = "https://stereo-crafter-test--stereo3d-api-test.modal.run/v1/jobs"
DEST = "previews/ab_V5b_depthsweep"


def fetch(job_id):
    with urllib.request.urlopen(f"{BASE}/{job_id}", timeout=30) as r:
        return json.load(r)


def cost_summary(d):
    return (d.get("metadata") or {}).get("cost_summary") or d.get("cost_summary") or {}


def main():
    rows = []
    for line in open(f"{DEST}/jobs.tsv"):
        line = line.rstrip("\n")
        if not line:
            continue
        lbl, jid, dres, ores = line.split("\t")
        try:
            d = fetch(jid)
        except Exception as e:  # noqa
            rows.append((lbl, jid, dres, ores, {"status": f"fetch-error {e}"}, [], {}))
            continue
        rows.append((lbl, jid, dres, ores, d, d.get("timings") or [],
                     cost_summary(d)))

    # ---- COST_SUMMARY.md ----
    out = ["# A/B V5bVtAej1hs depth-res sweep — cost summary (in-source estimates)",
           "",
           "Source: V5bVtAej1hs first 60s @ 6fps, inpaint=none, adaptive depth-pro,",
           "sbs+mvhevc, audio. Costs are ESTIMATES (timings × Modal pricing), not",
           "billed (billing API lags real-time).",
           "",
           "| job | depth_res | output_res | total $ | gpu $ | cpu $ | mem $ | sec | by_gpu |",
           "|-----|-----------|------------|---------|-------|-------|-------|-----|--------|"]
    for lbl, jid, dres, ores, d, timings, cs in rows:
        if not cs:
            out.append(f"| {lbl} | {dres} | {ores} | (status: {d.get('status')}) | | | | | |")
            continue
        bg = ", ".join(f"{k}:${v}" for k, v in (cs.get("by_gpu_usd") or {}).items())
        out.append(
            f"| {lbl} | {dres} | {ores} | {cs.get('total_usd')} | {cs.get('gpu_usd')} "
            f"| {cs.get('cpu_usd')} | {cs.get('mem_usd')} | {cs.get('total_seconds')} | {bg} |")
    open(f"{DEST}/COST_SUMMARY.md", "w").write("\n".join(out) + "\n")

    # ---- COST_BREAKDOWN.md (per-stage) ----
    out = ["# A/B V5bVtAej1hs depth-res sweep — per-STAGE cost breakdown",
           "",
           "Each job's stages with seconds, GPU, and estimated $ (gpu/cpu/mem/total).",
           ""]
    for lbl, jid, dres, ores, d, timings, cs in rows:
        out.append(f"## {lbl} — depth_res={dres}, output_res={ores}  (`{jid}`)")
        out.append("")
        if not timings:
            out.append(f"_status: {d.get('status')} — no timings_\n")
            continue
        out.append("| stage | seconds | gpu | gpu $ | cpu $ | mem $ | total $ | detail |")
        out.append("|-------|---------|-----|-------|-------|-------|---------|--------|")
        for t in timings:
            c = t.get("cost") or {}
            det = {k: v for k, v in (t.get("detail") or {}).items()
                   if k in ("frames", "width", "height", "crf", "preset")}
            out.append(
                f"| {t.get('stage')} | {t.get('seconds')} | {t.get('gpu') or '-'} "
                f"| {c.get('gpu_usd') or 0} | {c.get('cpu_usd') or 0} "
                f"| {c.get('mem_usd') or 0} | {c.get('total_usd') or 0} | {det or ''} |")
        if cs:
            out.append(f"| **TOTAL** | {cs.get('total_seconds')} | | {cs.get('gpu_usd')} "
                       f"| {cs.get('cpu_usd')} | {cs.get('mem_usd')} | **{cs.get('total_usd')}** | |")
        out.append("")
    open(f"{DEST}/COST_BREAKDOWN.md", "w").write("\n".join(out) + "\n")
    print("wrote COST_SUMMARY.md + COST_BREAKDOWN.md")


if __name__ == "__main__":
    main()
