"use client";

/**
 * The per-project 3D method choice (Lifelike / Classic): the two-card
 * chooser on the Media page (right after upload) and the compact switch in
 * the project header. Both PATCH /v1/projects/{id} {method} and hand the
 * updated project back; the choice can change any time. Native radio
 * inputs (steps/controls convention) so keyboard and tests work without
 * portals.
 *
 * A switch to Classic on a source longer than Classic's cap comes back as
 * 400 source_too_long_for_method — shown as a friendly note, the project
 * keeps its method.
 */

import { useState } from "react";
import type { JSX } from "react";

import {
  CHOOSER_SUBTITLE,
  CHOOSER_TITLE,
  METHOD_DESCRIPTIONS,
  METHOD_LABELS,
  METHOD_ORDER,
  RECOMMENDED_METHOD,
} from "@/components/steps/methods";
import { Badge } from "@/components/ui/badge";
import { track } from "@/lib/analytics";
import { GatewayError } from "@/lib/api/client";
import { methodOf, type Method, type Project } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";

/** What the customer reads when Classic can't take this video. */
export const TOO_LONG_FOR_CLASSIC =
  "This video is too long for Classic 3D. Lifelike 3D works with videos of any length, so we kept it.";

export interface MethodSwitch {
  method: Method;
  switching: boolean;
  error: string | null;
  setMethod: (m: Method) => Promise<void>;
}

/** PATCH the project's method; errors stay local to the control used. */
export function useMethodSwitch(
  project: Project,
  onChanged: (p: Project) => void,
): MethodSwitch {
  const gateway = useGateway();
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const method = methodOf(project);

  async function setMethod(next: Method): Promise<void> {
    if (next === method || switching) return;
    setSwitching(true);
    setError(null);
    try {
      const updated = await gateway.updateProject(project.project_id, {
        method: next,
      });
      track("method_changed", { method: next });
      // the PATCH answer is the full project; fall back to the request's
      // value for gateways that answer before storing it
      onChanged({ ...updated, method: updated.method ?? next });
    } catch (e) {
      setError(
        e instanceof GatewayError && e.code === "source_too_long_for_method"
          ? TOO_LONG_FOR_CLASSIC
          : e instanceof GatewayError && e.code === "method_unavailable"
            ? `${METHOD_LABELS[next]} isn't available right now, so your project keeps ${METHOD_LABELS[method]}.`
            : e instanceof GatewayError
              ? e.message
              : "Couldn't change the method. Please try again.",
      );
    } finally {
      setSwitching(false);
    }
  }

  return { method, switching, error, setMethod };
}

/** The two cards: Media page, right after upload. */
export function MethodChooser({
  project,
  onChanged,
}: {
  project: Project;
  onChanged: (p: Project) => void;
}): JSX.Element {
  const sw = useMethodSwitch(project, onChanged);
  return (
    <section
      data-testid="method-chooser"
      aria-labelledby="method-chooser-title"
      className="flex flex-col gap-3"
    >
      <div>
        <h3 id="method-chooser-title" className="text-sm font-semibold text-fg">
          {CHOOSER_TITLE}
        </h3>
        <p className="text-xs text-fg-muted">{CHOOSER_SUBTITLE}</p>
      </div>
      <div
        role="radiogroup"
        aria-labelledby="method-chooser-title"
        className="grid gap-3 sm:grid-cols-2"
      >
        {METHOD_ORDER.map((m) => {
          const selected = sw.method === m;
          return (
            <label
              key={m}
              data-testid={`method-card-${m}`}
              className={`flex cursor-pointer flex-col gap-1.5 rounded-lg border p-4 transition-colors ${
                selected
                  ? "border-primary bg-primary/10"
                  : "border-edge bg-surface-1 hover:bg-surface-2"
              } ${sw.switching ? "cursor-wait opacity-70" : ""}`}
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name={`method-${project.project_id}`}
                  value={m}
                  checked={selected}
                  disabled={sw.switching}
                  onChange={() => void sw.setMethod(m)}
                  className="accent-primary"
                />
                <span className="text-sm font-medium text-fg">
                  {METHOD_LABELS[m]}
                </span>
                {m === RECOMMENDED_METHOD ? (
                  <Badge
                    variant="outline"
                    className="h-4 border-primary/30 bg-primary/10 px-1.5 text-[10px] text-primary"
                  >
                    Recommended
                  </Badge>
                ) : null}
              </span>
              <span className="pl-5 text-xs text-fg-muted">
                {METHOD_DESCRIPTIONS[m]}
              </span>
            </label>
          );
        })}
      </div>
      {sw.error ? (
        <p role="alert" className="text-xs text-amber-400">
          {sw.error}
        </p>
      ) : null}
    </section>
  );
}

/** The compact switch in the project header. */
export function MethodSwitchControl({
  project,
  onChanged,
}: {
  project: Project;
  onChanged: (p: Project) => void;
}): JSX.Element {
  const sw = useMethodSwitch(project, onChanged);
  return (
    <span className="flex items-center gap-2">
      <span
        role="radiogroup"
        aria-label="3D method"
        data-testid="method-switch"
        className="flex overflow-hidden rounded border border-edge bg-surface-2 text-[11px]"
      >
        {METHOD_ORDER.map((m) => {
          const selected = sw.method === m;
          return (
            <label
              key={m}
              className={`flex cursor-pointer items-center px-2 py-0.5 transition-colors ${
                selected ? "bg-primary/15 text-primary" : "text-fg-muted hover:text-fg"
              }`}
            >
              <input
                type="radio"
                name={`method-switch-${project.project_id}`}
                value={m}
                checked={selected}
                disabled={sw.switching}
                onChange={() => void sw.setMethod(m)}
                className="sr-only"
              />
              {METHOD_LABELS[m]}
            </label>
          );
        })}
      </span>
      {sw.error ? (
        <span role="alert" className="max-w-xs text-[11px] text-amber-400">
          {sw.error}
        </span>
      ) : null}
    </span>
  );
}
