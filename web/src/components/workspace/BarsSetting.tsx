"use client";

/**
 * Black bars (owner request 2026-11-04): "we at least should prompt the
 * user when bars are detected (overview tab). The setting should be
 * available in make 3D tab as well." The Overview tab says where the bars
 * are and offers Remove bars (recommended) / Keep them, with a small
 * before/after of the frame; Make 3D has the same setting as a toggle with
 * the size it makes. Both save remove_bars on the project at once (PATCH
 * /v1/projects/{id}); the quote follows the project. Hidden when the
 * gateway doesn't say has_bars.
 */

import { useState } from "react";
import type { CSSProperties, JSX } from "react";

import { Button } from "@/components/ui/button";
import type { Project } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { barSides, barsNotice, removesBars, sizeWithoutBars } from "@/lib/bars";

import { parseCrop } from "./utils";

/** Saves remove_bars at once, showing the new value while it saves. */
function useRemoveBars(project: Project, onSaved: (p: Project) => void) {
  const gateway = useGateway();
  // the person's choice, shown until the project carries it
  const [chosen, setChosen] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const value = chosen ?? removesBars(project);

  async function set(next: boolean): Promise<void> {
    if (next === value) return;
    const before = chosen;
    setChosen(next);
    setSaving(true);
    setError(null);
    try {
      const saved = await gateway.updateProject(project.project_id, { remove_bars: next });
      onSaved(saved);
    } catch {
      setChosen(before);
      setError("Couldn't save that. Try again.");
    } finally {
      setSaving(false);
    }
  }
  return { value, saving, error, set };
}

/** Overview: the notice and the choice. */
export function BarsNotice({
  project,
  onProjectChanged,
}: {
  project: Project;
  onProjectChanged: (p: Project) => void;
}): JSX.Element | null {
  const sides = barSides(project);
  const { value, saving, error, set } = useRemoveBars(project, onProjectChanged);
  if (sides === null) return null;
  return (
    <section
      data-testid="bars-notice"
      className="flex flex-col gap-3 rounded-xl border border-edge bg-surface-1 p-4 sm:flex-row sm:items-center"
    >
      <BeforeAfter project={project} removing={value} />
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <p className="text-sm text-fg">{barsNotice(sides, value)}</p>
        <div role="group" aria-label="Black bars" className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant={value ? "default" : "outline"}
            aria-pressed={value}
            disabled={saving}
            onClick={() => void set(true)}
          >
            Remove bars (recommended)
          </Button>
          <Button
            size="sm"
            variant={value ? "outline" : "default"}
            aria-pressed={!value}
            disabled={saving}
            onClick={() => void set(false)}
          >
            Keep them
          </Button>
        </div>
        {error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

/** Make 3D: the same setting as a toggle, with the size it makes. */
export function BarsToggle({
  project,
  fullSize,
  onProjectChanged,
}: {
  project: Project;
  /** the chosen quality's size per eye with the bars */
  fullSize: { width: number; height: number } | null;
  onProjectChanged: (p: Project) => void;
}): JSX.Element | null {
  const sides = barSides(project);
  const { value, saving, error, set } = useRemoveBars(project, onProjectChanged);
  if (sides === null || !project.probe) return null;
  const without = fullSize ? sizeWithoutBars(project.probe, project.crop, fullSize) : null;
  const dims = (d: { width: number; height: number }) => `${d.width}×${d.height}`;
  return (
    <div data-testid="bars-toggle" className="flex flex-col gap-1">
      <label className="flex items-start gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={value}
          disabled={saving}
          onChange={(e) => void set(e.target.checked)}
          className="mt-0.5 accent-primary"
        />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">Remove black bars</span>
          <span data-testid="bars-toggle-help" className="text-xs text-fg-muted">
            {value
              ? without && fullSize
                ? `Your video has black bars. The 3D fills the frame, so its size changes to fit the picture: ${dims(without)} instead of ${dims(fullSize)}.`
                : "Your video has black bars. The 3D fills the frame, so its size changes to fit the picture."
              : fullSize
                ? `The 3D keeps the black bars, at ${dims(fullSize)}.`
                : "The 3D keeps the black bars."}
          </span>
        </span>
      </label>
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Two small frames: the video now, and what the 3D shows. */
function BeforeAfter({ project, removing }: { project: Project; removing: boolean }): JSX.Element | null {
  const probe = project.probe;
  const c = parseCrop(project.crop);
  if (!probe || !c) return null;
  const thumb = project.scene_thumbs?.[0]?.url ?? project.strip_thumbs?.[0]?.url;
  const frame = (aspect: number, inner: CSSProperties | null, label: string) => (
    <figure className="flex flex-col items-center gap-1">
      <div
        className="relative w-24 overflow-hidden rounded bg-black ring-1 ring-edge"
        style={{ aspectRatio: String(aspect) }}
      >
        {thumb ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={thumb} alt="" className="absolute max-w-none" style={inner ?? { inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />
        ) : (
          <div
            className="absolute bg-surface-2"
            style={{
              left: `${(c.x / probe.width) * 100}%`,
              top: `${(c.y / probe.height) * 100}%`,
              width: `${(c.width / probe.width) * 100}%`,
              height: `${(c.height / probe.height) * 100}%`,
            }}
          />
        )}
      </div>
      <figcaption className="text-[11px] text-fg-muted">{label}</figcaption>
    </figure>
  );
  // the picture area only, from the full frame
  const croppedImg: CSSProperties = {
    width: `${(probe.width / c.width) * 100}%`,
    height: `${(probe.height / c.height) * 100}%`,
    left: `${(-c.x / c.width) * 100}%`,
    top: `${(-c.y / c.height) * 100}%`,
  };
  return (
    <div data-testid="bars-before-after" className="flex shrink-0 items-end gap-2" aria-hidden="true">
      {frame(probe.width / probe.height, null, "Your video")}
      <span className="pb-5 text-fg-muted">→</span>
      {removing ? frame(c.width / c.height, croppedImg, "Your 3D") : frame(probe.width / probe.height, null, "Your 3D")}
    </div>
  );
}
