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
 *   event: bye              {"type","reason":"max_age"|"listener","retry_ms"}
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

export type LiveEvent =
  | { type: "snapshot"; id?: string; runs: LiveRun[]; projects: ProjectPatch[] }
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
      return { type: "snapshot", ...at, runs, projects };
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
    case "bye":
      return { type: "bye", ...at, retryMs: num(body.retry_ms) ?? null };
    default:
      return null;
  }
}
