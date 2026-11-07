/**
 * The live status stream's events (owner 2026-11-07): GET /v1/events, one
 * server-sent stream per signed-in user. Every wire detail lives here, in
 * parseLiveEvent; the rest of the app only sees LiveEvent.
 *
 * The gateway's schema (coordinator 2026-11-07):
 *
 *   event: snapshot         {"type","version","runs":[Run…],"projects":[Project…]}
 *   event: run.state        {"type","run_id","project_id","version","state","run":Run}
 *   event: run.progress     {"type","run_id","project_id","version","state","progress","stage","eta_seconds","waiting_for_gpu","queued_s"}
 *   event: project.updated  {"type","project_id","version","deleted","project":Project}
 *   event: run.formats      {"type","run_id","project_id","version","formats":Formats,"outputs":[name]}
 *   event: handoff.state    {"type","code","run_id","version","state":"waiting"|"paying"|"closed"}
 *   event: billing.updated  {"type","kind":"settle"|"balance","version","settle_id?","state?",
 *                            "amount_cents?","balance_cents?","held_cents?"}
 *   event: bye              {"type","reason":"max_age"|"listener","retry_ms"}
 *
 * The snapshot also carries run_formats {run_id: Formats}, handoffs
 * [{code, run_id, state, version}], settles [{settle_id, state,
 * amount_cents, version}] and billing {balance_cents, held_cents,
 * version} (gateway 4578628). Formats is GET /v1/runs/{id}/formats.
 *
 * Run is the GET /v1/conversions/{id} response; Project is GET
 * /v1/projects/{id} without its runs. `id:` is a whole number, rising
 * through one stream (resume with Last-Event-ID). `version` is the doc's
 * update time in microseconds: keep the highest per run and per project,
 * drop anything not higher (duplicates, replays, out of order).
 */

import type { Conversion, Project } from "@/lib/api/types";

/** A run as an event or a read sent it: whatever fields came, its id and
 * its version. */
export type LiveRun = Partial<Conversion> & { conversion_id: string; version?: number };

/** A project's own fields (its analysis, profile job, card summary,
 * name…) with its version; runs come as run events. */
export type ProjectPatch = Partial<Omit<Project, "conversions">> & {
  project_id: string;
  version?: number;
  /** project.updated for a deleted project */
  deleted?: boolean;
};

/** run.formats: a run's format jobs (GET /v1/runs/{id}/formats) and its
 * files' names. */
export interface LiveFormats {
  run_id: string;
  version: number;
  formats: unknown;
  outputs?: string[];
}

/** handoff.state: a "pay on another device" code; "closed" once used or
 * expired. */
export interface LiveHandoff {
  code: string;
  run_id?: string;
  version: number;
  state: string;
}

/** billing.updated kind settle: one settle of what the account owes. */
export interface LiveSettle {
  settle_id: string;
  version: number;
  state?: string;
  amount_cents?: number;
}

/** billing.updated kind balance: the prepaid balance. */
export interface LiveBalance {
  version: number;
  balance_cents?: number;
  held_cents?: number;
}

export type LiveEvent =
  | {
      type: "snapshot";
      id?: string;
      runs: LiveRun[];
      projects: ProjectPatch[];
      formats?: LiveFormats[];
      handoffs?: LiveHandoff[];
      settles?: LiveSettle[];
      balance?: LiveBalance | null;
    }
  | { type: "run.formats"; id?: string; formats: LiveFormats }
  | { type: "handoff.state"; id?: string; handoff: LiveHandoff }
  | { type: "billing.updated"; id?: string; settle?: LiveSettle; balance?: LiveBalance }
  | { type: "run.state"; id?: string; run: LiveRun }
  | { type: "run.progress"; id?: string; run: LiveRun }
  | { type: "project.updated"; id?: string; project: ProjectPatch }
  | { type: "bye"; id?: string; retryMs: number | null };

/**
 * An RFC3339 time in microseconds since 1970, the unit of `version`
 * (Date.parse keeps only milliseconds); NaN when it can't be read.
 */
export function versionOf(at: string | undefined): number {
  if (!at) return NaN;
  const ms = Date.parse(at);
  if (!Number.isFinite(ms)) return NaN;
  const frac = /\.(\d+)/.exec(at)?.[1] ?? "";
  const micros = Number((frac + "000000").slice(3, 6));
  return ms * 1000 + micros;
}

function obj(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** A run read whole (a snapshot entry or a GET), its version from its
 * update time. */
export function runFromRead(r: Conversion | LiveRun): LiveRun {
  const v = versionOf(r.updated_at);
  return Number.isFinite(v) ? { ...r, version: v } : { ...r };
}

/** A project read whole, without its runs, its version from its update
 * time. */
export function projectFromRead(p: Project | ProjectPatch): ProjectPatch {
  const { conversions: _runs, ...rest } = p as Project;
  void _runs;
  const v = versionOf(rest.updated_at);
  return Number.isFinite(v) ? { ...rest, version: v } : rest;
}

/** Only the fields that came (an absent field never clears one). */
function defined<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function handoffOf(h: Record<string, unknown>): LiveHandoff {
  return {
    code: h.code as string,
    version: num(h.version) ?? 0,
    state: typeof h.state === "string" ? h.state : "",
    ...(typeof h.run_id === "string" ? { run_id: h.run_id } : {}),
  };
}

function settleOf(x: Record<string, unknown>): LiveSettle {
  return {
    settle_id: x.settle_id as string,
    version: num(x.version) ?? 0,
    ...defined({ state: typeof x.state === "string" ? x.state : undefined, amount_cents: num(x.amount_cents) }),
  };
}

function balanceOf(b: Record<string, unknown>): LiveBalance {
  return { version: num(b.version) ?? 0, ...defined({ balance_cents: num(b.balance_cents), held_cents: num(b.held_cents) }) };
}

/** One SSE message as a LiveEvent; null for an unknown or broken one
 * (the stream goes on). */
export function parseLiveEvent(event: string, data: string, id?: string): LiveEvent | null {
  let body: Record<string, unknown> | null;
  try {
    body = obj(JSON.parse(data));
  } catch {
    return null;
  }
  if (body === null) return null;
  const at = id !== undefined ? { id } : {};
  const type = event || (typeof body.type === "string" ? body.type : "");
  const version = num(body.version);
  switch (type) {
    case "snapshot": {
      const runs = (Array.isArray(body.runs) ? body.runs : [])
        .map(obj)
        .filter((r): r is Record<string, unknown> => r !== null && typeof r.conversion_id === "string")
        .map((r) => runFromRead(r as unknown as Conversion));
      const projects = (Array.isArray(body.projects) ? body.projects : [])
        .map(obj)
        .filter((p): p is Record<string, unknown> => p !== null && typeof p.project_id === "string")
        .map((p) => projectFromRead(p as unknown as Project));
      const top = version ?? 0;
      const runFormats = obj(body.run_formats);
      const formats: LiveFormats[] = runFormats
        ? Object.entries(runFormats).map(([run_id, f]) => ({ run_id, version: top, formats: f }))
        : [];
      const handoffs = (Array.isArray(body.handoffs) ? body.handoffs : [])
        .map(obj)
        .filter((h): h is Record<string, unknown> => h !== null && typeof h.code === "string")
        .map(handoffOf);
      const settles = (Array.isArray(body.settles) ? body.settles : [])
        .map(obj)
        .filter((x): x is Record<string, unknown> => x !== null && typeof x.settle_id === "string")
        .map(settleOf);
      const billing = obj(body.billing);
      return {
        type: "snapshot",
        ...at,
        runs,
        projects,
        formats,
        handoffs,
        settles,
        balance: billing ? balanceOf(billing) : null,
      };
    }
    case "run.state": {
      const run = obj(body.run) ?? {};
      const runId = typeof body.run_id === "string" ? body.run_id : run.conversion_id;
      if (typeof runId !== "string") return null;
      return {
        type: "run.state",
        ...at,
        run: {
          ...(run as Partial<Conversion>),
          ...defined({
            conversion_id: runId,
            project_id: typeof body.project_id === "string" ? body.project_id : undefined,
            state: typeof body.state === "string" ? (body.state as Conversion["state"]) : undefined,
            version: version ?? num(versionOf(run.updated_at as string | undefined)),
          }),
        } as LiveRun,
      };
    }
    case "run.progress": {
      if (typeof body.run_id !== "string") return null;
      return {
        type: "run.progress",
        ...at,
        run: {
          conversion_id: body.run_id,
          ...defined({
            project_id: typeof body.project_id === "string" ? body.project_id : undefined,
            state: typeof body.state === "string" ? (body.state as Conversion["state"]) : undefined,
            progress: num(body.progress),
            stage: typeof body.stage === "string" ? body.stage : undefined,
            eta_seconds: num(body.eta_seconds),
            waiting_for_gpu: typeof body.waiting_for_gpu === "boolean" ? body.waiting_for_gpu : undefined,
            queued_s: num(body.queued_s),
            version,
          }),
        },
      };
    }
    case "project.updated": {
      if (typeof body.project_id !== "string") return null;
      const project = obj(body.project) ?? {};
      const { conversions: _runs, ...rest } = project;
      void _runs;
      return {
        type: "project.updated",
        ...at,
        project: {
          ...(rest as Partial<Project>),
          ...defined({
            project_id: body.project_id,
            version: version ?? num(versionOf(rest.updated_at as string | undefined)),
            deleted: body.deleted === true ? true : undefined,
          }),
        } as ProjectPatch,
      };
    }
    case "run.formats":
      if (typeof body.run_id !== "string") return null;
      return {
        type: "run.formats",
        ...at,
        formats: {
          run_id: body.run_id,
          version: version ?? 0,
          formats: body.formats ?? null,
          ...(Array.isArray(body.outputs) ? { outputs: body.outputs.filter((o): o is string => typeof o === "string") } : {}),
        },
      };
    case "handoff.state":
      if (typeof body.code !== "string") return null;
      return { type: "handoff.state", ...at, handoff: handoffOf(body) };
    case "billing.updated":
      if (body.kind === "balance") return { type: "billing.updated", ...at, balance: balanceOf(body) };
      if (typeof body.settle_id !== "string") return null;
      return { type: "billing.updated", ...at, settle: settleOf(body) };
    case "bye":
      return { type: "bye", ...at, retryMs: num(body.retry_ms) ?? null };
    default:
      return null;
  }
}
