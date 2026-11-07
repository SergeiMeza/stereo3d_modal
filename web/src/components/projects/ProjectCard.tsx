"use client";

/**
 * One project in the list (screen 01, S3D-35): thumbnail with the length,
 * name, method, the outcome line (getting ready, waiting in line, making
 * 3D with progress and time left, 3D ready, payment needed, failed). No
 * money on cards (S3D-35): summary.spent_cents is ignored.
 *
 * The card body is a Link; management actions (pin/rename/archive/restore)
 * live in a SIBLING row outside the anchor — nested interactive elements
 * inside <a> are invalid HTML and break keyboard/AT navigation (and tests).
 * The action row only renders when the parent passes onUpdate, so other
 * usages (workspace) are unaffected.
 */

import {
  Archive,
  ArchiveRestore,
  Pencil,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import Link from "next/link";

import { watchNavigation } from "@/lib/navigation";
import { useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  methodOf,
  posterUrl,
  type Project,
  type UpdateProjectRequest,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { formatClock, formatTimeLeft } from "@/lib/format";
import { METHOD_NAMES } from "@/lib/glossary";
import { useLiveProject } from "@/lib/live/useLive";
import { activeIntl } from "@/lib/i18n/t";

/** "Dec 5, 2026" in the active language */
const DATE_FORMAT = { format: (d: Date) => new Intl.DateTimeFormat(activeIntl(), {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
}).format(d) };

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
  // S3D-24: erased files — the project stays, nothing to open or run
  if (project.files_deleted_at !== undefined) {
    return {
      label: `Files deleted on ${DATE_FORMAT.format(new Date(project.files_deleted_at))}`,
      tone: "plain",
    };
  }
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
      if (s.latest_waiting_for_gpu)
        return { label: "Waiting in line", tone: "working" };
      const pct =
        s.latest_progress !== undefined
          ? Math.round(s.latest_progress * 100)
          : null;
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
            link: { label: "Update payment method", tab: "files" },
          }
        : {
            label: "3D ready",
            tone: "ready",
            link: { label: "Files", tab: "files" },
          };
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

const DELETE_WARNING_MS = 14 * 24 * 3600 * 1000;

/** S3D-24: true when the files are scheduled to go within 14 days. */
export function filesDeleteSoon(
  at: string | undefined,
  now = Date.now(),
): boolean {
  if (at === undefined) return false;
  const t = Date.parse(at);
  return Number.isFinite(t) && t - now < DELETE_WARNING_MS;
}

/** gateway 00101: 409 project_has_active_run */
export const ARCHIVE_BLOCKED =
  "This project has a run in progress. Wait for it to finish, or cancel it, before archiving.";

const FINISHED = new Set(["succeeded", "failed", "canceled", "expired"]);

export function ProjectCard({
  project: listed,
  onUpdate,
  onDelete,
}: {
  project: Project;
  /** parent owns the API call + list refresh; absent = no action row */
  onUpdate?: (req: UpdateProjectRequest) => Promise<void>;
  /** owner 2026-11-04: archived projects only (archive first, then
   * delete); never the sample. Errors surface in the parent's banner. */
  onDelete?: () => Promise<void>;
}) {
  // owner 2026-11-07: the card's analysis and run line from the live feed,
  // the same moment the project page shows
  const project = useLiveProject(listed);
  const gateway = useGateway();
  const [kept, setKept] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "archive" | "delete" | null>(
    null,
  );
  // gateway 00101: no archiving while a run is unfinished
  const activeRun =
    project.summary?.latest_state !== undefined &&
    !FINISHED.has(project.summary.latest_state);
  const deletable =
    project.archived === true &&
    project.sample !== true &&
    onDelete !== undefined;
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const probe = project.probe;
  const thumb =
    posterUrl(project);
  const state = cardState(project);
  const method = methodOf(project);
  const href = `/projects/${project.project_id}`;
  // S3D-24: unused files go after 90 days; the card warns in the last 14
  const [deleteSoon] = useState(() => filesDeleteSoon(project.files_delete_at));

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

  const remove = async () => {
    if (onDelete === undefined) return;
    setBusy(true);
    try {
      await onDelete();
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
      <Link
        href={href}
        // owner bug 2026-11-07: a navigation that never lands becomes a full load
        onClick={(e) => {
          if (e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) watchNavigation(href);
        }}
        className="group flex gap-3 p-3.5 pb-2.5"
      >
        <div className="relative aspect-video w-32 shrink-0 self-start overflow-hidden rounded-md bg-black">
          {thumb ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={thumb} alt="" className="h-full w-full object-cover" />
          ) : null}
          {probe ? (
            <span className="absolute right-1 bottom-1 rounded bg-black/70 px-1 font-mono text-[10px] text-white">
              {formatClock(probe.duration_s)}
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
            <span className="truncate">
              {project.name ?? "Untitled project"}
            </span>
          </h2>
          <span>
            <Badge
              variant="outline"
              data-testid="card-method"
              className={
                method === "lifelike"
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-edge bg-surface-2 text-fg-muted"
              }
            >
              {METHOD_NAMES[method]}
              {method === "classic" ? " · Older method" : ""}
            </Badge>
            {project.sample ? (
              <Badge
                variant="outline"
                data-testid="card-sample"
                className="ml-1.5 border-edge bg-surface-2 text-fg-muted"
              >
                Sample
              </Badge>
            ) : null}
          </span>
        </div>
      </Link>
      {project.sample ? (
        <p
          data-testid="card-sample-note"
          className="px-3.5 text-xs text-fg-muted"
        >
          {project.archived === true
            ? "The sample can't be deleted. Unarchive it any time."
            : "A finished example to look around. It's not billed and you can archive it."}
        </p>
      ) : null}

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
        {/* S3D-35: no money on cards — the method chip and the state only */}
        {deleteSoon && !kept && project.files_deleted_at === undefined ? (
          <span
            data-testid="card-files-delete"
            className="flex items-center gap-1.5 text-amber-300"
          >
            Files deleted on{" "}
            {DATE_FORMAT.format(new Date(project.files_delete_at!))}
            <span aria-hidden>·</span>
            <button
              type="button"
              disabled={keeping}
              onClick={async () => {
                setKeeping(true);
                try {
                  await gateway.keepProject(project.project_id);
                  setKept(true);
                } finally {
                  setKeeping(false);
                }
              }}
              className="text-primary hover:underline disabled:opacity-50"
            >
              Keep
            </button>
          </span>
        ) : (
          <span>{DATE_FORMAT.format(new Date(project.created_at))}</span>
        )}
        {onUpdate !== undefined ? (
          <div className="flex items-center gap-0.5 text-fg-muted">
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={
                project.pinned === true ? "Unpin project" : "Pin project"
              }
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
              <>
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
                {deletable ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label="Delete project"
                    data-testid="card-delete"
                    disabled={busy}
                    onClick={() => setDialog("delete")}
                  >
                    <Trash2 />
                  </Button>
                ) : null}
              </>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  {/* a disabled button gets no hover: the span carries the reason */}
                  <span
                    tabIndex={activeRun ? 0 : -1}
                    data-testid="archive-wrap"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Archive project"
                      aria-description={activeRun ? ARCHIVE_BLOCKED : undefined}
                      disabled={busy || activeRun}
                      onClick={() => setDialog("archive")}
                    >
                      <Archive />
                    </Button>
                  </span>
                </TooltipTrigger>
                {activeRun ? (
                  <TooltipContent side="top">{ARCHIVE_BLOCKED}</TooltipContent>
                ) : null}
              </Tooltip>
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

      <AlertDialog
        open={dialog === "delete"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <AlertDialogContent data-testid="delete-project-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this project for good?</AlertDialogTitle>
            <AlertDialogDescription>
              Its files are removed for good. You won&apos;t be able to download
              them again, and this can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep project</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void remove();
              }}
            >
              Delete for good
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={dialog === "archive"}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive project</AlertDialogTitle>
            <AlertDialogDescription>
              Archive this project? You can restore it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                void run({ archived: true });
              }}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
