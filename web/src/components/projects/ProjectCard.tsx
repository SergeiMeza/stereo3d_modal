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
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  methodOf,
  type Project,
  type UpdateProjectRequest,
} from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { formatClock, formatTimeLeft } from "@/lib/format";
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
            link: { label: "Update payment method", tab: "files" },
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

const DELETE_WARNING_MS = 14 * 24 * 3600 * 1000;

/** S3D-24: true when the files are scheduled to go within 14 days. */
export function filesDeleteSoon(at: string | undefined, now = Date.now()): boolean {
  if (at === undefined) return false;
  const t = Date.parse(at);
  return Number.isFinite(t) && t - now < DELETE_WARNING_MS;
}

export function ProjectCard({
  project,
  onUpdate,
}: {
  project: Project;
  /** parent owns the API call + list refresh; absent = no action row */
  onUpdate?: (req: UpdateProjectRequest) => Promise<void>;
}) {
  const gateway = useGateway();
  const [kept, setKept] = useState(false);
  const [keeping, setKeeping] = useState(false);
  const [dialog, setDialog] = useState<"rename" | "archive" | null>(null);
  const [nameDraft, setNameDraft] = useState("");
  const [busy, setBusy] = useState(false);

  const probe = project.probe;
  const thumb = project.scene_thumbs?.[0]?.url ?? project.strip_thumbs?.[0]?.url;
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
            <span className="truncate">{project.name ?? "Untitled project"}</span>
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
        {/* S3D-35: no money on cards — the method chip and the state only */}
        {deleteSoon && !kept ? (
          <span data-testid="card-files-delete" className="flex items-center gap-1.5 text-amber-300">
            Files deleted on {DATE_FORMAT.format(new Date(project.files_delete_at!))}
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
