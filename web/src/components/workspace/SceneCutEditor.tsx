"use client";

/**
 * Scene-cut editor — owns the LOCAL cut list, playhead, and selection, and
 * the save/versioning flow against PATCH /v1/projects/{id}/scenes.
 *
 * Frame doctrine: every value handled here is an integer source-frame
 * index; the only conversions are through src/lib/frames.ts helpers (the
 * video mapping lives in usePreviewPlayer, the zoom windowing in ./utils —
 * both compose those helpers).
 *
 * Playback: usePreviewPlayer drives the frame-exact preview proxy. While
 * playing, the playhead (readout + timeline) follows the video; scrubbing,
 * stepping (pause + seek), scene-card clicks and marker drags seek the
 * video — marker drags throttled to ~100 ms so the viewer live-shows the
 * actual cut frame while adjusting.
 *
 * Editing affordances are deliberately redundant (the hidden-gesture-only
 * version lost users): double-click the strip OR "+ Add cut at playhead";
 * marker × / Delete key / "− Remove cut" button / a scene card's "Merge ←"
 * (removes the cut starting that scene) all edit the same local list.
 *
 * Edits stay local until "Save cuts" sends {cuts, expect_version}; a 409
 * conflict surfaces a banner offering "Reload & reapply" (fetch the new
 * server version, keep the local edits on top, save again).
 *
 * Import/export (src/lib/cutlist.ts): "Export cuts" downloads the WORKING
 * list as a PySceneDetect-style scene CSV; "Import cuts…" parses a CSV or
 * plain frame list and — after an explicit confirm — replaces the local
 * list through the SAME local-edit → Save path, keeping the versioned
 * PATCH semantics intact.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GatewayError } from "@/lib/api/client";
import type { Probe, Scenes, Thumb } from "@/lib/api/types";
import { useGateway } from "@/lib/api/useGateway";
import { exportCutsCSV, parseCutList } from "@/lib/cutlist";
import {
  frameLabel,
  frameToTimecode,
  parseRational,
  validateCuts,
} from "@/lib/frames";
import { blurAfterMouseClick } from "@/lib/interactions";

import { FilmstripTimeline } from "./FilmstripTimeline";
import { PageHeader } from "./PageHeader";
import { PreviewViewer } from "./PreviewViewer";
import { SceneList } from "./SceneList";
import { isTypingTarget, usePlayerShortcuts } from "./usePlayerShortcuts";
import { usePreviewPlayer } from "./usePreviewPlayer";
import { clampFrame, sameCuts } from "./utils";

/** Marker drags seek the preview at most every ~100 ms (with a trailing
 * seek so the final position always lands). */
const DRAG_SEEK_THROTTLE_MS = 100;

export interface SceneCutEditorProps {
  projectId: string;
  /** For the export filename ("<project-name>-cuts.csv"). */
  projectName?: string;
  probe: Probe;
  scenes: Scenes;
  crop?: string;
  /** frame-exact 1:1 playable proxy of the source (Project.preview_url) */
  previewUrl?: string;
  stripThumbs: Thumb[];
  sceneThumbs: Thumb[];
  /** Refetch the project (after a save, or to resolve a conflict). */
  onProjectChanged: () => void | Promise<void>;
}

export function SceneCutEditor({
  projectId,
  projectName,
  probe,
  scenes,
  crop,
  previewUrl,
  stripThumbs,
  sceneThumbs,
  onProjectChanged,
}: SceneCutEditorProps) {
  const gateway = useGateway();
  const numFrames = probe.num_frames;
  const fps = useMemo(() => parseRational(probe.fps_rational), [probe.fps_rational]);
  /** Frames in one timecode second — the Shift-arrow step (exact rational). */
  const secondFrames = Math.max(1, Math.round(fps.num / fps.den));

  const serverCuts = scenes.cuts;
  const [cuts, setCuts] = useState<number[]>(serverCuts);
  const [snapshot, setSnapshot] = useState<number[]>(serverCuts);
  // Adopt server changes when the local list has no unsaved edits
  // (render-phase state adjustment, per React's derived-state guidance).
  if (snapshot !== serverCuts) {
    setSnapshot(serverCuts);
    if (sameCuts(cuts, snapshot)) setCuts(serverCuts);
  }

  const [playhead, setPlayhead] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editNote, setEditNote] = useState<string | null>(null);

  const dirty = !sameCuts(cuts, serverCuts);
  const validationError = validateCuts(cuts, numFrames);

  // ------------------------------------------------------------- playback
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const playheadRef = useRef(playhead);
  useEffect(() => {
    playheadRef.current = playhead;
  }, [playhead]);

  const handleVideoFrame = useCallback(
    (frame: number) => setPlayhead(clampFrame(frame, numFrames)),
    [numFrames],
  );
  const player = usePreviewPlayer(videoRef, fps, handleVideoFrame);

  /** Move the playhead AND the video (playback keeps going if playing). */
  const scrub = useCallback(
    (frame: number) => {
      const f = clampFrame(frame, numFrames);
      setPlayhead(f);
      player.seekToFrame(f);
    },
    [numFrames, player],
  );

  /** Frame stepper: pause, then seek exactly ±delta frames. */
  const step = useCallback(
    (delta: number) => {
      player.pause();
      const f = clampFrame(playheadRef.current + delta, numFrames);
      setPlayhead(f);
      player.seekToFrame(f);
    },
    [numFrames, player],
  );

  // Throttled preview seek for marker drags: leading seek immediately, then
  // at most one trailing seek per window (always landing on the last frame).
  const dragSeek = useRef<{
    last: number;
    timer: ReturnType<typeof setTimeout> | null;
    frame: number;
  }>({ last: 0, timer: null, frame: 0 });
  useEffect(() => {
    const state = dragSeek.current;
    return () => {
      if (state.timer !== null) clearTimeout(state.timer);
    };
  }, []);

  function seekPreviewThrottled(frame: number) {
    const state = dragSeek.current;
    state.frame = frame;
    if (state.timer !== null) return; // trailing seek already scheduled
    const elapsed = Date.now() - state.last;
    if (elapsed >= DRAG_SEEK_THROTTLE_MS) {
      state.last = Date.now();
      player.pause();
      player.seekToFrame(frame);
    } else {
      state.timer = setTimeout(() => {
        state.timer = null;
        state.last = Date.now();
        player.pause();
        player.seekToFrame(state.frame);
      }, DRAG_SEEK_THROTTLE_MS - elapsed);
    }
  }

  // ---------------------------------------------------------- cut editing
  function addCut(frame: number) {
    scrub(frame);
    if (!Number.isInteger(frame) || frame <= 0 || frame >= numFrames) {
      setEditNote(`Cannot cut at frame ${frame} — cuts must be inside (0, ${numFrames}).`);
      return;
    }
    if (cuts.includes(frame)) {
      setEditNote(`There is already a cut at frame ${frame}.`);
      return;
    }
    const next = [...cuts, frame].sort((a, b) => a - b);
    setCuts(next);
    setSelectedIndex(next.indexOf(frame));
    setEditNote(null);
  }

  const removeSelected = useCallback(() => {
    if (selectedIndex === null) return;
    setCuts((cs) => cs.filter((_, i) => i !== selectedIndex));
    setSelectedIndex(null);
    setEditNote(null);
  }, [selectedIndex]);

  /** Merge a scene into its predecessor: remove the cut at the scene's
   * start frame (SceneList's "Merge ←"). Same local-edit → Save flow as
   * every other change. */
  function mergeScene(startFrame: number) {
    setCuts((cs) => cs.filter((c) => c !== startFrame));
    setSelectedIndex(null);
    setEditNote(null);
  }

  // -------------------------------------------------- cut import / export
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  /** Parsed-but-unconfirmed import; the confirm dialog is open while set. */
  const [importPending, setImportPending] = useState<number[] | null>(null);

  /** Download the WORKING cut list (local edits included) as the
   * PySceneDetect-style scene CSV via a Blob URL. */
  function exportCuts() {
    const csv = exportCutsCSV(cuts, numFrames, fps);
    const name = `${(projectName ?? "").trim().replace(/[/\\]/g, "-") || "project"}-cuts.csv`;
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** Parse the picked file; errors surface via the inline edit note. The
   * replacement itself waits for the confirm dialog. */
  async function importCutsFile(file: File) {
    try {
      const parsed = parseCutList(await file.text(), numFrames);
      setImportPending(parsed);
      setEditNote(null);
    } catch (e) {
      setEditNote(e instanceof Error ? e.message : "Could not read the cut list.");
    }
  }

  /** Confirmed import: replace the LOCAL working list — the same
   * state/save path as manual add/remove, so the versioned PATCH
   * ({cuts, expect_version}) semantics stay intact. */
  function applyImport() {
    if (importPending === null) return;
    setCuts(importPending);
    setSelectedIndex(null);
    setEditNote(null);
    setImportPending(null);
  }

  /** Why "Add cut at playhead" is disabled right now, or null when legal.
   * (The playhead is always clamped to [0, numFrames), so only the two
   * user-reachable cases need naming.) */
  const addAtPlayheadReason =
    playhead <= 0
      ? "Cuts must be after frame 0 — move the playhead first"
      : cuts.includes(playhead)
        ? `There is already a cut at frame ${playhead}`
        : null;

  function moveCut(index: number, frame: number) {
    const lo = (index > 0 ? cuts[index - 1] : 0) + 1;
    const hi = (index + 1 < cuts.length ? cuts[index + 1] : numFrames) - 1;
    const clamped = Math.min(Math.max(frame, lo), hi);
    if (clamped !== cuts[index]) {
      const next = [...cuts];
      next[index] = clamped;
      setCuts(next);
    }
    setEditNote(null);
    // live-preview the dragged cut frame in the viewer (throttled)
    seekPreviewThrottled(clamped);
  }

  // Transport keys via the SHARED hook (Media uses the same one); the
  // Cut-only editing key (Delete/Backspace removes the selected cut) is
  // layered on top with its own listener.
  usePlayerShortcuts({ toggle: player.toggle, step, secondFrames });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isTypingTarget(e.target)) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeSelected();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [removeSelected]);

  async function save() {
    setSaving(true);
    setSaveError(null);
    try {
      await gateway.updateScenes(projectId, {
        cuts,
        expect_version: scenes.version,
      });
      await onProjectChanged();
      setConflict(false);
    } catch (e) {
      if (e instanceof GatewayError && e.code === "conflict") {
        setConflict(true);
      } else {
        setSaveError(e instanceof Error ? e.message : "failed to save cuts");
      }
    } finally {
      setSaving(false);
    }
  }

  async function reloadAndReapply() {
    // Refetching brings in the new scenes.version; the local (dirty) cut
    // list is kept on top, ready to save against the fresh version.
    await onProjectChanged();
    setConflict(false);
  }

  function resetToSaved() {
    setCuts(serverCuts);
    setSelectedIndex(null);
    setEditNote(null);
  }

  const selectedCut = selectedIndex !== null ? cuts[selectedIndex] : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="Scene cuts"
        description="Frame-exact scene boundaries — every later step maps depth per scene. Edits stay local until saved."
        meta={
          <>
            <span
              data-testid="scenes-version"
              className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg-muted"
            >
              v{scenes.version}
            </span>
            <span
              data-testid="duration"
              className="font-mono text-[11px] text-fg-muted"
            >
              {frameToTimecode(numFrames, fps)}
            </span>
            <span className="text-[11px] text-fg-muted">
              {numFrames} frames · {probe.fps_rational} fps
            </span>
            {dirty ? (
              <span
                data-testid="dirty-indicator"
                className="flex items-center gap-1 text-[11px] text-amber-400"
              >
                <span
                  aria-hidden
                  className="h-1.5 w-1.5 rounded-full bg-amber-400"
                />
                Unsaved changes
              </span>
            ) : null}
          </>
        }
        actions={
          <>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,.txt"
              aria-label="Cut list file"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = ""; // re-picking the same file must re-fire
                if (file) void importCutsFile(file);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                blurAfterMouseClick(e);
                fileInputRef.current?.click();
              }}
            >
              Import cuts…
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={(e) => {
                blurAfterMouseClick(e);
                exportCuts();
              }}
            >
              Export cuts
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!dirty || saving}
              onClick={(e) => {
                blurAfterMouseClick(e);
                resetToSaved();
              }}
            >
              Reset to detected
            </Button>
            <Button
              size="sm"
              disabled={!dirty || saving || validationError !== null}
              onClick={(e) => {
                blurAfterMouseClick(e);
                void save();
              }}
            >
              {saving ? "Saving…" : "Save cuts"}
            </Button>
          </>
        }
      />

      {conflict ? (
        <div
          role="alert"
          data-testid="conflict-banner"
          className="flex items-center gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-300"
        >
          <span>
            The scene list changed on the server since you loaded it. Reload
            the latest version and reapply your edits, then save again.
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto shrink-0 border-amber-400/50 text-amber-300 hover:bg-amber-500/20 hover:text-amber-200"
            onClick={() => void reloadAndReapply()}
          >
            Reload &amp; reapply
          </Button>
        </div>
      ) : null}
      {saveError ? (
        <p role="alert" className="text-sm text-red-400">
          {saveError}
        </p>
      ) : null}
      {validationError ? (
        <p role="alert" data-testid="validation-error" className="text-sm text-red-400">
          {validationError}
        </p>
      ) : null}

      <PreviewViewer
        probe={probe}
        fps={fps}
        playhead={playhead}
        previewUrl={previewUrl}
        thumbs={stripThumbs}
        crop={crop}
        player={player}
        videoRef={videoRef}
        onStep={step}
      />

      <div className="flex min-h-6 flex-wrap items-center gap-2 text-[12px]">
        <Button
          variant="outline"
          size="xs"
          disabled={addAtPlayheadReason !== null}
          title={
            addAtPlayheadReason ??
            `Add a scene cut at frame ${playhead} (the playhead)`
          }
          onClick={(e) => {
            blurAfterMouseClick(e);
            addCut(playhead);
          }}
        >
          + Add cut at playhead
        </Button>
        <Button
          variant="outline"
          size="xs"
          disabled={selectedIndex === null}
          title={
            selectedIndex === null
              ? "Select a cut marker on the timeline first"
              : "Remove the selected cut (Delete)"
          }
          onClick={(e) => {
            blurAfterMouseClick(e);
            removeSelected();
          }}
        >
          − Remove cut
        </Button>
        {selectedCut !== null ? (
          <>
            <span data-testid="selected-cut" className="font-mono text-fg">
              Cut {(selectedIndex ?? 0) + 1} · {frameLabel(selectedCut, fps)}
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Remove selected cut"
              className="text-fg-muted hover:text-fg"
              onClick={(e) => {
                blurAfterMouseClick(e);
                removeSelected();
              }}
            >
              ×
            </Button>
          </>
        ) : (
          <span className="text-fg-muted">
            Click the strip to scrub · double-click to add a cut · click a
            marker to select, drag to move · Delete removes
          </span>
        )}
        {editNote ? (
          <span data-testid="edit-note" className="text-amber-400">
            {editNote}
          </span>
        ) : null}
      </div>

      <FilmstripTimeline
        thumbs={stripThumbs}
        numFrames={numFrames}
        fps={fps}
        playhead={playhead}
        cuts={cuts}
        previewUrl={previewUrl}
        aspect={probe.width / probe.height}
        selectedIndex={selectedIndex}
        onScrub={scrub}
        onAddCut={addCut}
        onSelectCut={setSelectedIndex}
        onMoveCut={moveCut}
      />

      <p
        data-testid="timeline-legend"
        className="flex items-center gap-1.5 text-[11px] text-fg-muted"
      >
        <span aria-hidden className="h-3 w-[2px] shrink-0 bg-amber-400/80" />
        scene cut — the first frame of a new scene
        <span aria-hidden className="ml-2 h-3 w-[2px] shrink-0 bg-fg" />
        playhead
      </p>

      <SceneList
        cuts={cuts}
        numFrames={numFrames}
        fps={fps}
        sceneThumbs={sceneThumbs}
        playhead={playhead}
        onSelectScene={scrub}
        onMergeScene={mergeScene}
      />

      <Dialog
        open={importPending !== null}
        onOpenChange={(open) => {
          if (!open) setImportPending(null);
        }}
      >
        <DialogContent data-testid="import-cuts-dialog">
          <DialogHeader>
            <DialogTitle>Import scene cuts</DialogTitle>
            <DialogDescription>
              Replace {cuts.length} cuts with {importPending?.length ?? 0}{" "}
              imported cuts? The replacement stays local until you save.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter showCloseButton>
            <Button type="button" onClick={applyImport}>
              Replace
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
