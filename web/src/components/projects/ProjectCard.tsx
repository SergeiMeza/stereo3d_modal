"use client";

/**
 * One project in the list (screen 01, S3D-35): thumbnail with the length,
 * name, method, the outcome line (getting ready, waiting in line, making
 * 3D with progress and time left, 3D ready, payment needed, failed) and
 * what it has cost so far (GET /v1/projects summary).
 *
 * The card body is a Link; management actions (pin/rename/archive/restore)
 * live in a SIBLING row outside the anchor — nested interactive elements
 * inside <a> are invalid HTML and break keyboard/AT navigation (and tests).
 * The action row only renders when the parent passes onUpdate, so other
 * usages (workspace) are unaffected.
 */

import { Archive, ArchiveRestore, Pencil, Pin, PinOff } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCents } from "@/components/steps/money";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  methodOf,
  type Project,
  type UpdateProjectRequest,
} from "@/lib/api/types";
import { formatTimeLeft } from "@/lib/format";
import { METHOD_NAMES } from "@/lib/glossary";

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** A card's outcome line (S3D-35): what is happening, or what came out. */
export interface CardState {
  label: string;
  tone: "working" | "ready" | "attention" | "plain";
  /** 0..1 when there is a bar */
  progress?: number;
  /** "about 12 min left" */
  right?: string;
  link?: { label: string; tab: string };
}

export function cardState(project: Project): CardState {
  const a = project.analyze;
  if (a.state === "running") {
    const pct = a.progress !== undefined ? Math.round(a.progress * 100) : null;
    return {
      label: `Getting your video ready${pct !== null ? ` · ${pct}%` : ""}`,
      tone: "plain",
      progress: a.progress,
      right:
        a.eta_seconds && a.eta_seconds > 0
          ? formatTimeLeft(a.eta_seconds)
          : undefined,
    };
  }
  if (a.state === "failed") {
    return {
      label: "Couldn't read this video",
      tone: "attention",
      link: { label: "Try again", tab: "overview" },
    };
  }
  const s = project.summary;
  switch (s?.latest_state) {
    case "created":
    case "paid":
      return { label: "Waiting in line", tone: "working" };
    case "processing": {
      if (s.latest_waiting_for_gpu) return { label: "Waiting in line", tone: "working" };
      const pct =
        s.latest_progress !== undefined ? Math.round(s.latest_progress * 100) : null;
      return {
        label: `Making 3D${pct !== null ? ` · ${pct}%` : ""}`,
        tone: "working",
        progress: s.latest_progress,
        right:
          s.latest_eta_seconds && s.latest_eta_seconds > 0
            ? formatTimeLeft(s.latest_eta_seconds)
            : undefined,
      };
    }
    case "succeeded":
      return s.latest_billing_status === "charge_failed"
        ? {
            label: "Payment needed",
            tone: "attention",
            link: { label: "Update card", tab: "files" },
          }
        : { label: "3D ready", tone: "ready", link: { label: "Files", tab: "files" } };
    case "failed":
      return {
        label: "Failed, not charged",
        tone: "plain",
        link: { label: "Try again", tab: "make" },
      };
    case "canceled":
    case "expired":
      return { label: "Cancelled · not charged", tone: "plain" };
  }
  return { label: "Ready for 3D", tone: "plain" };
}

const TONE: Record<CardState["tone"], string> = {
  working: "border-primary/30 bg-primary/10 text-primary",
  ready: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
  attention: "border-red-500/30 bg-red-500/10 text-red-300",
  plain: "border-edge bg-surface-2 text-fg-muted",
};

/** m:ss / h:mm:ss for the thumbnail corner. */
function clock(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}

export function ProjectCard({
  project,
  onUpdate,
}: {
  project: Project;
  /** parent owns the API call + list refresh; absent = no action row */
  onUpdate?: (req: UpdateProjectRequest) => Promise<void>;
}) {
  const [dialog, setDialog] = useState<"rename" | "archive" | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const probe = project.probe;
  const thumb = project.scene_thumbs?.[0]?.url ?? project.strip_thumbs?.[0]?.url;
  const state = cardState(project);
  const method = methodOf(project);
  const spent = project.summary?.spent_cents ?? 0;
  const href = `/projects/${project.project_id}`;

  const run = async (req: UpdateProjectRequest) => {
    if (onUpdate === undefined) return;
    setBusy(true);
    try {
      await onUpdate(req); // errors surface in the parent's banner
    } finally {
      setBusy(false);
      setDialog(null);
    }
  };

  return (
    <div
      data-testid="project-card"
      className={`flex h-full flex-col rounded-lg border border-edge bg-surface-2 transition-colors hover:border-primary/60 ${
        project.archived === true ? "opacity-50" : ""
      }`}
    >
      <Link href={href} className="group flex gap-3 p-3.5 pb-2.5">
        <div className="relative aspect-video w-32 shrink-0 self-start overflow-hidden rounded-md bg-black">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" className="h-full w-full object-cover" />
          ) : null}
          {probe ? (
            <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">
              {clock(probe.duration_s)}
            </span>
          ) : null}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <h2 className="flex min-w-0 items-center gap-1.5 font-medium text-fg transition-colors group-hover:text-primary/80">
            {project.pinned === true ? (
              <>
                <Pin aria-hidden className="size-3.5 shrink-0 text-primary" />
                <span className="sr-only">Pinned</span>
              </>
            ) : null}
            <span className="truncate">{project.name ?? "Untitled project"}</span>
          </h2>
          <span>
            <Badge
              variant="outline"
              data-testid="card-method"
              className={
                method === "lifelike"
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-violet-400/30 bg-violet-400/10 text-violet-300"
              }
            >
              {METHOD_NAMES[method]}
            </Badge>
          </span>
        </div>
      </Link>

      <div className="flex min-h-11 flex-col justify-center gap-1.5 px-3.5 pb-3">
        <div className="flex items-center gap-2 text-xs">
          <Badge
            variant="outline"
            data-testid="card-state"
            className={TONE[state.tone]}
          >
            {state.label}
          </Badge>
          {state.right ? (
            <span className="ml-auto text-fg-muted">{state.right}</span>
          ) : null}
          {state.link ? (
            <Link
              href={`${href}#tab=${state.link.tab}`}
              className="ml-auto text-primary hover:underline"
            >
              {state.link.label}
            </Link>
          ) : null}
        </div>
        {state.progress !== undefined ? (
          <Progress
            value={Math.round(Math.min(Math.max(state.progress, 0), 1) * 100)}
            className="h-1"
          />
        ) : null}
      </div>

      <div className="mt-auto flex items-center gap-2 border-t border-edge py-1.5 pr-2 pl-3.5 text-xs text-fg-muted">
        {spent > 0 ? (
          <span data-testid="card-spent">
            Spent so far{" "}
            <span className="font-mono text-fg">{formatCents(spent)}</span>
          </span>
        ) : (
          <span data-testid="card-spent">Nothing spent yet</span>
        )}
        <span className="ml-auto">
          {DATE_FORMAT.format(new Date(project.created_at))}
        </span>
      {onUpdate !== undefined ? (
        <div className="flex items-center gap-0.5 text-fg-muted">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={project.pinned === true ? "Unpin project" : "Pin project"}
            disabled={busy}
            onClick={() => void run({ pinned: project.pinned !== true })}
          >
            {project.pinned === true ? <PinOff /> : <Pin />}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label="Rename project"
            disabled={busy}
            onClick={() => {
              setNameDraft(project.name ?? "Untitled project");
              setDialog("rename");
            }}
          >
            <Pencil />
          </Button>
          {project.archived === true ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Restore project"
              disabled={busy}
              onClick={() => void run({ archived: false })}
            >
              <ArchiveRestore />
            </Button>
          ) : (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Archive project"
              disabled={busy}
              onClick={() => setDialog("archive")}
            >
              <Archive />
            </Button>
          )}
        </div>
      ) : null}
      </div>

      <Dialog
        open={dialog === "rename"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename project</DialogTitle>
          </DialogHeader>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void run({ name: nameDraft.trim() });
            }}
          >
            <input
              type="text"
              aria-label="Project name"
              value={nameDraft}
              maxLength={120}
              onChange={(e) => setNameDraft(e.target.value)}
              className="w-full rounded-md border border-edge bg-surface-1 px-3 py-2 text-sm text-fg outline-none focus:border-primary/60"
            />
            <DialogFooter showCloseButton>
              <Button type="submit" disabled={busy || nameDraft.trim() === ""}>
                Save
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog
        open={dialog === "archive"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive project</DialogTitle>
            <DialogDescription>
              Archive this project? You can restore it later. A run still in
              progress is cancelled, and you won&apos;t be charged for it.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button
              type="button"
              variant="destructive"
              disabled={busy}
              onClick={() => void run({ archived: true })}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
