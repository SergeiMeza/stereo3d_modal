"use client";

/**
 * The project's 3D method (S3D-01, S3D-14, S3D-30, S3D-44).
 *
 * - The chooser (Overview) shows both methods with this video's price and
 *   time, Lifelike first and recommended, Classic second with a grey
 *   "Older method" tag. It is offered until the project's first run.
 * - Afterwards only Classic → Lifelike exists: a Classic project shows a
 *   one-line offer with this video's Lifelike price and time; moving asks
 *   for confirmation ("Your Classic files stay in Files. You can't move
 *   back to Classic."). A Lifelike project never shows a way back; the
 *   gateway's 400 method_switch_not_allowed reads as a plain sentence.
 *
 * Prices come from POST .../quotes with the `method` override (the full
 * video at the best quality the source reaches, default formats). Native
 * radio inputs (steps/controls convention). Layout is minimal: the
 * redesign mocks define it.
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import {
  CHOOSER_SUBTITLE,
  CHOOSER_TITLE,
  METHOD_DESCRIPTIONS,
  METHOD_LABELS,
  METHOD_LIMITS,
  METHOD_ORDER,
  METHOD_TAGS,
  MOVE_TO_LIFELIKE_BODY,
  MOVE_TO_LIFELIKE_TITLE,
  RECOMMENDED_METHOD,
  SWITCH_NOT_ALLOWED,
} from "@/components/steps/methods";
import { formatCents } from "@/components/steps/money";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { track } from "@/lib/analytics";
import { GatewayError } from "@/lib/api/client";
import {
  methodOf,
  type Method,
  type Project,
  type StepConversionRequest,
  type StepQuoteResponse,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { formatDuration } from "@/lib/format";
import { qualitiesFor, qualityChoices, qualityLabelFor } from "@/lib/glossary";

/** What the customer reads when Classic can't take this video. */
export const TOO_LONG_FOR_CLASSIC =
  "This video is too long for Classic 3D. Lifelike 3D works with videos of any length, so we kept it.";

function switchErrorCopy(e: unknown, next: Method, current: Method): string {
  if (e instanceof GatewayError) {
    if (e.code === "source_too_long_for_method") return TOO_LONG_FOR_CLASSIC;
    if (e.code === "method_switch_not_allowed") return SWITCH_NOT_ALLOWED;
    if (e.code === "method_unavailable") {
      return `${METHOD_LABELS[next]} isn't available right now, so your project keeps ${METHOD_LABELS[current]}.`;
    }
    return e.message;
  }
  return "Couldn't change the method. Please try again.";
}

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
      setError(switchErrorCopy(e, next, method));
    } finally {
      setSwitching(false);
    }
  }

  return { method, switching, error, setMethod };
}

/** The best quality each method offers this source (the chooser prices
 * the whole video there). */
function topPreset(project: Project, method: Method) {
  const list =
    method === "lifelike"
      ? qualityChoices(project).map((q) => q.preset)
      : qualitiesFor(project.probe);
  return list[list.length - 1] ?? "1080p";
}

export interface MethodQuote {
  quote: StepQuoteResponse | null;
  /** plain sentence when the method can't price this video */
  error: string | null;
  /** quality label the price is for */
  qualityLabel: string;
}

/** This video's full-length price and time under each method (S3D-14). */
export function useMethodQuotes(
  project: Project,
  methods: readonly Method[] = METHOD_ORDER,
): Partial<Record<Method, MethodQuote>> {
  const gateway = useGateway();
  const ready = project.analyze.state === "succeeded" && project.probe;
  const [quotes, setQuotes] = useState<Partial<Record<Method, MethodQuote>>>(
    {},
  );
  const key = `${project.project_id}:${ready ? "ready" : "wait"}:${methods.join(",")}`;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    for (const m of methods) {
      const preset = topPreset(project, m);
      const req: StepConversionRequest = {
        step: "production",
        preset,
        formats: ["mvhevc", "half_sbs"],
        method: m,
        platform: "web",
      };
      gateway.quoteStep(project.project_id, req).then(
        (q) => {
          if (cancelled) return;
          setQuotes((prev) => ({
            ...prev,
            [m]: {
              quote: q,
              error: null,
              qualityLabel: qualityLabelFor(project, preset),
            },
          }));
        },
        (e: unknown) => {
          if (cancelled) return;
          setQuotes((prev) => ({
            ...prev,
            [m]: {
              quote: null,
              error:
                e instanceof GatewayError &&
                e.code === "source_too_long_for_method"
                  ? "This video is longer than Classic 3D can take."
                  : "Price not available right now.",
              qualityLabel: qualityLabelFor(project, preset),
            },
          }));
        },
      );
    }
    return () => {
      cancelled = true;
    };
    // the key covers project id, readiness and the methods asked for
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gateway, key]);
  return quotes;
}

/** "$58.50 · about 40 min" for a method quote. */
export function priceAndTime(q: MethodQuote | undefined): string | null {
  if (!q?.quote) return null;
  const eta = q.quote.eta_seconds;
  return `${formatCents(q.quote.quote.amount_cents)}${
    eta && eta > 0 ? ` · ${formatDuration(eta)}` : ""
  }`;
}

/** The confirmation for the one move there is (Classic → Lifelike). */
export function MoveToLifelikeDialog({
  open,
  onOpenChange,
  onConfirm,
  busy,
  lifelike,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
  lifelike?: MethodQuote;
}): JSX.Element {
  const pt = priceAndTime(lifelike);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="move-to-lifelike-dialog">
        <DialogHeader>
          <DialogTitle>{MOVE_TO_LIFELIKE_TITLE}</DialogTitle>
          <DialogDescription>{MOVE_TO_LIFELIKE_BODY}</DialogDescription>
        </DialogHeader>
        {pt ? (
          <p className="text-sm text-fg">
            Lifelike 3D for this video at {lifelike!.qualityLabel}: {pt}.
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Stay on Classic 3D
          </Button>
          <Button onClick={onConfirm} disabled={busy}>
            Move to Lifelike 3D
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The two cards (Overview), offered until the project's first run. */
export function MethodChooser({
  project,
  onChanged,
}: {
  project: Project;
  onChanged: (p: Project) => void;
}): JSX.Element {
  const sw = useMethodSwitch(project, onChanged);
  const quotes = useMethodQuotes(project);
  const [confirming, setConfirming] = useState(false);

  function choose(m: Method): void {
    // Classic → Lifelike is the one-way move: confirm it
    if (sw.method === "classic" && m === "lifelike") setConfirming(true);
    else void sw.setMethod(m);
  }

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
          const q = quotes[m];
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
              <span className="flex flex-wrap items-center gap-2">
                <input
                  type="radio"
                  name={`method-${project.project_id}`}
                  value={m}
                  checked={selected}
                  disabled={sw.switching}
                  onChange={() => choose(m)}
                  className="accent-primary"
                />
                <span className="text-sm font-medium text-fg">
                  {METHOD_LABELS[m]}
                </span>
                {METHOD_TAGS[m] ? (
                  <span
                    data-testid={`method-tag-${m}`}
                    className="rounded bg-surface-2 px-1.5 text-[10px] text-fg-muted"
                  >
                    {METHOD_TAGS[m]}
                  </span>
                ) : null}
                {m === RECOMMENDED_METHOD ? (
                  <Badge
                    variant="outline"
                    className="h-4 border-primary/30 bg-primary/10 px-1.5 text-[10px] text-primary"
                  >
                    Recommended
                  </Badge>
                ) : null}
                <span className="ml-auto text-[11px] text-fg-muted">
                  {METHOD_LIMITS[m]}
                </span>
              </span>
              <span className="pl-5 text-xs text-fg-muted">
                {METHOD_DESCRIPTIONS[m]}
              </span>
              <span
                data-testid={`method-price-${m}`}
                className="pl-5 text-sm font-medium text-fg"
              >
                {q === undefined
                  ? "Pricing this video…"
                  : (priceAndTime(q) ?? q.error)}
                {q?.quote ? (
                  <span className="text-xs font-normal text-fg-muted">
                    {" "}
                    at {q.qualityLabel}
                  </span>
                ) : null}
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
      <MoveToLifelikeDialog
        open={confirming}
        onOpenChange={setConfirming}
        busy={sw.switching}
        lifelike={quotes.lifelike}
        onConfirm={() => {
          setConfirming(false);
          void sw.setMethod("lifelike");
        }}
      />
    </section>
  );
}

/** A Classic project's one-line offer to move to Lifelike (S3D-44), with
 * this video's Lifelike price and time. */
export function MoveToLifelikeOffer({
  project,
  onChanged,
}: {
  project: Project;
  onChanged: (p: Project) => void;
}): JSX.Element | null {
  const sw = useMethodSwitch(project, onChanged);
  const quotes = useMethodQuotes(project, ["lifelike"]);
  const [confirming, setConfirming] = useState(false);
  if (sw.method !== "classic") return null;
  const pt = priceAndTime(quotes.lifelike);
  return (
    <div
      data-testid="move-to-lifelike-offer"
      className="flex flex-wrap items-center gap-3 rounded-md border border-edge bg-surface-1 px-3 py-2 text-sm"
    >
      <span className="text-fg">
        Move to Lifelike 3D{pt ? `: ${pt} for this video` : ""}.
      </span>
      <Button
        variant="outline"
        size="xs"
        className="ml-auto"
        onClick={() => setConfirming(true)}
      >
        See what changes
      </Button>
      {sw.error ? (
        <span role="alert" className="w-full text-xs text-amber-400">
          {sw.error}
        </span>
      ) : null}
      <MoveToLifelikeDialog
        open={confirming}
        onOpenChange={setConfirming}
        busy={sw.switching}
        lifelike={quotes.lifelike}
        onConfirm={() => {
          setConfirming(false);
          void sw.setMethod("lifelike");
        }}
      />
    </div>
  );
}

/** The project header's method label; Classic projects get the move. */
export function MethodBadge({
  project,
  onChanged,
  allowMove = true,
}: {
  project: Project;
  onChanged: (p: Project) => void;
  /** false when Lifelike can't be chosen right now */
  allowMove?: boolean;
}): JSX.Element {
  const sw = useMethodSwitch(project, onChanged);
  const [confirming, setConfirming] = useState(false);
  return (
    <span data-testid="method-badge" className="flex items-center gap-2 text-[11px]">
      <span className="rounded border border-edge bg-surface-2 px-2 py-0.5 text-fg-muted">
        {METHOD_LABELS[sw.method]}
      </span>
      {sw.method === "classic" && allowMove ? (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded border border-primary/30 px-2 py-0.5 text-primary hover:bg-primary/10"
        >
          Move to Lifelike 3D
        </button>
      ) : null}
      {sw.error ? (
        <span role="alert" className="max-w-xs text-amber-400">
          {sw.error}
        </span>
      ) : null}
      <MoveToLifelikeDialog
        open={confirming}
        onOpenChange={setConfirming}
        busy={sw.switching}
        onConfirm={() => {
          setConfirming(false);
          void sw.setMethod("lifelike");
        }}
      />
    </span>
  );
}
