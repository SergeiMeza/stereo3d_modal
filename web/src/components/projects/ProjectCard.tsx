"use client";

/**
 * One project in the list. Duration comes from the probe via
 * src/lib/frames.ts (frame doctrine: the rational fps, never the float);
 * scene count is cuts.length + 1 (cuts tile the video into N+1 scenes).
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
import type { Project, UpdateProjectRequest } from "@/lib/api/types";
import { frameToTimecode, parseRational } from "@/lib/frames";

import { AnalyzeBadge } from "./AnalyzeBadge";

const DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  year: "numeric",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

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
  const duration =
    probe !== undefined
      ? frameToTimecode(probe.num_frames, parseRational(probe.fps_rational))
      : null;
  const sceneCount =
    project.scenes !== undefined ? project.scenes.cuts.length + 1 : null;

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
      className={`rounded-lg border border-edge bg-surface-2 transition-colors hover:border-primary/60 ${
        project.archived === true ? "opacity-50" : ""
      }`}
    >
      <Link
        href={`/projects/${project.project_id}`}
        className={`group block p-4 ${onUpdate !== undefined ? "pb-2" : ""}`}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex min-w-0 items-center gap-1.5 font-medium text-fg transition-colors group-hover:text-primary/80">
            {project.pinned === true ? (
              <>
                <Pin aria-hidden className="size-3.5 shrink-0 text-primary" />
                <span className="sr-only">Pinned</span>
              </>
            ) : null}
            <span className="truncate">{project.name ?? "Untitled project"}</span>
          </h2>
          <AnalyzeBadge analyze={project.analyze} />
        </div>
        <dl className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-xs text-fg-muted">
          <div>
            <dt className="sr-only">Duration</dt>
            <dd className="font-mono text-fg">{duration ?? "—"}</dd>
          </div>
          <div>
            <dt className="sr-only">Resolution</dt>
            <dd>{probe !== undefined ? `${probe.width}×${probe.height}` : "—"}</dd>
          </div>
          <div>
            <dt className="sr-only">Scenes</dt>
            <dd>{sceneCount !== null ? `${sceneCount} scenes` : "—"}</dd>
          </div>
        </dl>
        <p className="mt-3 text-xs text-fg-muted">
          Created {DATE_FORMAT.format(new Date(project.created_at))}
        </p>
      </Link>

      {onUpdate !== undefined ? (
        <div className="flex items-center gap-1 px-3 pb-2 text-fg-muted">
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
              Archive this project? You can restore it later. A project with a
              running conversion can&apos;t be archived — wait for it to finish
              or cancel it first.
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
