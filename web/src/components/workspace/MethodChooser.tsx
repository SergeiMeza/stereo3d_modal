"use client";

/**
 * The project's 3D method (S3D-01, S3D-14, S3D-30, S3D-44). There is no
 * chooser: new projects are Lifelike, and a Lifelike project never shows
 * Classic. An existing Classic project keeps its "Older method" tag and
 * shows the one-way offer "Move to Lifelike 3D: $X, about Y min for this
 * video." Moving asks first ("Your Classic files stay in Files. You can't
 * move back to Classic.") with both prices side by side (screen 04). The
 * gateway's 400 method_switch_not_allowed reads as a plain sentence.
 *
 * Prices come from POST .../quotes with the `method` override (the full
 * video at the best quality each method reaches, default formats).
 */

import { useEffect, useState } from "react";
import type { JSX } from "react";

import {
  METHOD_LABELS,
  METHOD_ORDER,
  METHOD_TAGS,
  MOVE_TO_LIFELIKE_BODY,
  MOVE_TO_LIFELIKE_TITLE,
  SWITCH_NOT_ALLOWED,
} from "@/components/steps/methods";
import { formatCents } from "@/components/steps/money";
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
  type Preset,
  type Project,
  type StepConversionRequest,
  type StepQuoteResponse,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { formatDuration } from "@/lib/format";
import { qualitiesFor, qualityChoices, qualityLabelFor } from "@/lib/glossary";

/** The dialog's closing line names Lifelike as the newest. */
const LIFELIKE_EYEBROW_SENTENCE = "Our newest 3D technology.";

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
export function topPreset(project: Project, method: Method): Preset {
  const list =
    method === "lifelike"
      ? qualityChoices(project).map((q) => q.preset)
      : qualitiesFor(project.probe, "classic");
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
  /** price a method at this quality instead of its best one */
  presets: Partial<Record<Method, Preset>> = {},
): Partial<Record<Method, MethodQuote>> {
  const gateway = useGateway();
  const ready = project.analyze.state === "succeeded" && project.probe;
  const [quotes, setQuotes] = useState<Partial<Record<Method, MethodQuote>>>(
    {},
  );
  const key = `${project.project_id}:${ready ? "ready" : "wait"}:${methods.join(",")}:${JSON.stringify(presets)}`;
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    for (const m of methods) {
      const preset = presets[m] ?? topPreset(project, m);
      const req: StepConversionRequest = {
        step: "production",
        preset,
        formats: ["mvhevc", "sbs"],
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

/** The comparison row values for a method quote. */
function quoteCells(q: MethodQuote | undefined): { price: string; time: string } {
  if (!q) return { price: "…", time: "…" };
  if (!q.quote) return { price: "—", time: "—" };
  const eta = q.quote.eta_seconds;
  return {
    price: formatCents(q.quote.quote.amount_cents),
    time: eta && eta > 0 ? formatDuration(eta) : "—",
  };
}

/** The "New" tag beside Lifelike's name (S3D-46). */
export function NewTag(): JSX.Element {
  return (
    <span data-testid="method-tag-new" className="ll-tag-new">
      New
    </span>
  );
}

/** The confirmation for the one move there is (Classic → Lifelike), with
 * this video's price and time under both methods (screen 04). */
export function MoveToLifelikeDialog({
  open,
  onOpenChange,
  onConfirm,
  busy,
  lifelike,
  classic,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  busy: boolean;
  lifelike?: MethodQuote;
  classic?: MethodQuote;
}): JSX.Element {
  const l = quoteCells(lifelike);
  const c = quoteCells(classic);
  const quality = lifelike?.qualityLabel ?? classic?.qualityLabel;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="move-to-lifelike-dialog">
        <DialogHeader>
          <DialogTitle>{MOVE_TO_LIFELIKE_TITLE}</DialogTitle>
          <DialogDescription>{MOVE_TO_LIFELIKE_BODY}</DialogDescription>
        </DialogHeader>
        {lifelike || classic ? (
          <table
            data-testid="move-compare"
            className="w-full overflow-hidden rounded-lg border border-edge text-sm"
          >
            <thead className="bg-surface-2 text-left text-xs text-fg-muted">
              <tr>
                <th className="px-3 py-2 font-normal">
                  For this video{quality ? ` at ${quality}` : ""}
                </th>
                <th className="px-3 py-2 font-normal">Classic 3D now</th>
                <th className="px-3 py-2 font-normal">
                  <span className="flex items-center gap-1.5">
                    <span className="text-fg">Lifelike 3D</span>
                    <NewTag />
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-edge">
                <td className="px-3 py-2 text-fg-muted">Price</td>
                <td data-testid="move-classic-price" className="px-3 py-2 font-mono">
                  {c.price}
                </td>
                <td
                  data-testid="move-lifelike-price"
                  className="px-3 py-2 font-mono text-fg"
                >
                  {l.price}
                </td>
              </tr>
              <tr className="border-t border-edge">
                <td className="px-3 py-2 text-fg-muted">Ready in</td>
                <td className="px-3 py-2">{c.time}</td>
                <td className="px-3 py-2">{l.time}</td>
              </tr>
            </tbody>
          </table>
        ) : null}
        <p className="text-xs text-fg-muted">
          {LIFELIKE_EYEBROW_SENTENCE} No Depth or 3D look pages to set up.
        </p>
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
  const [confirming, setConfirming] = useState(false);
  // a fair comparison (S3D-14/44): Lifelike at the Classic project's own
  // quality; Lifelike's best size on a second line when it goes higher
  const classicPreset = topPreset(project, "classic");
  const lifelikeTop = topPreset(project, "lifelike");
  const quotes = useMethodQuotes(project, METHOD_ORDER, { lifelike: classicPreset });
  const best = useMethodQuotes(
    project,
    lifelikeTop !== classicPreset ? ["lifelike"] : [],
  ).lifelike;
  if (sw.method !== "classic") return null;
  const q = quotes.lifelike?.quote;
  const eta = q?.eta_seconds;
  return (
    <div
      data-testid="move-to-lifelike-offer"
      className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm"
    >
      <span aria-hidden className="text-primary">
        ✦
      </span>
      <span className="text-fg">
        <span className="font-medium">Move to Lifelike 3D</span>
        {q ? (
          <span data-testid="move-offer-price">
            : {formatCents(q.quote.amount_cents)}
            {eta && eta > 0 ? `, ${formatDuration(eta)}` : ""} for this video.
          </span>
        ) : (
          "."
        )}
        {best?.quote ? (
          <span data-testid="move-offer-higher" className="block text-xs text-fg-muted">
            or {best.qualityLabel} for {formatCents(best.quote.quote.amount_cents)}
          </span>
        ) : null}
      </span>
      <button
        type="button"
        className="ml-auto text-xs text-primary hover:underline"
        onClick={() => setConfirming(true)}
      >
        Move
      </button>
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
        classic={quotes.classic}
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
  const quotes = useMethodQuotes(project, confirming ? METHOD_ORDER : [], {
    lifelike: topPreset(project, "classic"),
  });
  return (
    <span data-testid="method-badge" className="flex items-center gap-2 text-[11px]">
      <span className="rounded border border-edge bg-surface-2 px-2 py-0.5 text-fg-muted">
        {METHOD_LABELS[sw.method]}
      </span>
      {METHOD_TAGS[sw.method] ? (
        <span
          data-testid={`method-tag-${sw.method}`}
          className="rounded-full border border-edge px-1.5 text-fg-muted"
        >
          {METHOD_TAGS[sw.method]}
        </span>
      ) : null}
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
        lifelike={quotes.lifelike}
        classic={quotes.classic}
        onConfirm={() => {
          setConfirming(false);
          void sw.setMethod("lifelike");
        }}
      />
    </span>
  );
}
