"use client";

/**
 * Scene-scoped playback for the step output players (the Depth compare view
 * and the Stereo output player). Users review outputs SCENE BY SCENE to
 * match the per-scene workflow: picking a scene seeks the MASTER player to
 * the scene's start and loops within [startT, endT); "Whole video" clears
 * the loop without seeking.
 *
 * Frame doctrine: scene bounds are integer SOURCE-frame ranges — preferring
 * scene_profile.shots ([first_src, last_src), the exact ranges the pipeline
 * rendered), falling back to cutsToRanges(scenes.cuts, probe.num_frames) —
 * converted to seconds ONCE via frameToSeconds with the source rational
 * fps. Output videos are decimated (different fps) but preserve wall-clock
 * duration, so source-time bounds are correct for them; frame math never
 * touches an output file.
 */

import { useRef, useState } from "react";
import type { RefObject } from "react";

import type { Project } from "@/lib/api/types";
import {
  cutsToRanges,
  frameToSeconds,
  frameToTimecode,
  parseRational,
  type RationalFPS,
} from "@/lib/frames";

/** One scene option: half-open [first, last) in SOURCE-frame space. */
export interface SceneRange {
  index: number;
  first: number;
  last: number;
  /** e.g. "Scene 12 · f1205–f1224 · 00:00:50:05" */
  label: string;
}

/** Scene ranges for a playback picker. Prefers the profiled shots when the
 * profile matches the current cuts; a STALE profile (scenes_version moved)
 * is ignored — the cut list is the truth for the ranges on screen. */
export function sceneRangesForPlayback(project: Project): SceneRange[] {
  if (!project.probe) return [];
  const fps = parseRational(project.probe.fps_rational);
  const profileFresh =
    project.scene_profile !== undefined &&
    (project.scenes === undefined ||
      project.scene_profile.scenes_version === project.scenes.version);
  const ranges: Array<[number, number]> = profileFresh
    ? project.scene_profile!.shots.map((s) => [s.first_src, s.last_src])
    : project.scenes
      ? cutsToRanges(project.scenes.cuts, project.probe.num_frames)
      : [];
  return ranges.map(([first, last], i) => ({
    index: i,
    first,
    last,
    label: `Scene ${i + 1} · f${first}–f${last} · ${frameToTimecode(first, fps)}`,
  }));
}

/** Loop tolerance in seconds: timeupdate fires a few times a second, so a
 * tick can land shy of the exact boundary — anything within EPS of the
 * scene end counts as "reached the end". */
const LOOP_EPSILON_S = 0.05;

export interface ScenePlayback {
  scenes: SceneRange[];
  /** null = whole video */
  selected: SceneRange | null;
  selectScene: (index: number | null) => void;
  /** ‹ steps back; from Scene 1 it returns to Whole video. */
  prevScene: () => void;
  /** › steps forward; from Whole video it goes to Scene 1. */
  nextScene: () => void;
  /** Attach to the MASTER <video>: loops inside the selected scene. */
  onTimeUpdate: () => void;
  /** Attach to the MASTER <video>: applies a seek requested before the
   * video had metadata. */
  onLoadedMetadata: () => void;
}

export function useScenePlayback(
  videoRef: RefObject<HTMLVideoElement | null>,
  scenes: SceneRange[],
  fps: RationalFPS,
): ScenePlayback {
  const [index, setIndex] = useState<number | null>(null);
  // seek requested before the video had metadata — re-applied on loadedmetadata
  const pendingSeekRef = useRef<number | null>(null);

  const selected = index === null ? null : (scenes[index] ?? null);

  function selectScene(next: number | null): void {
    setIndex(next);
    if (next === null) {
      // Whole video: clear the loop, DON'T seek — keep reviewing from here.
      pendingSeekRef.current = null;
      return;
    }
    const scene = scenes[next];
    if (!scene) return;
    const startT = frameToSeconds(scene.first, fps);
    pendingSeekRef.current = null;
    const v = videoRef.current;
    if (!v) return;
    // Seek now (a paused player stays paused — we never call play());
    // pre-metadata the browser may drop it, so re-apply on loadedmetadata.
    v.currentTime = startT;
    if (v.readyState < HTMLMediaElement.HAVE_METADATA) {
      pendingSeekRef.current = startT;
    }
  }

  function prevScene(): void {
    if (index === null) return; // Whole video sits before Scene 1
    selectScene(index === 0 ? null : index - 1);
  }

  function nextScene(): void {
    if (index === null) {
      if (scenes.length > 0) selectScene(0);
      return;
    }
    if (index + 1 < scenes.length) selectScene(index + 1);
  }

  function onTimeUpdate(): void {
    const v = videoRef.current;
    if (!v || selected === null) return;
    const endT = frameToSeconds(selected.last, fps);
    if (v.currentTime >= endT - LOOP_EPSILON_S) {
      // loop back to the scene start and KEEP PLAYING — no pause
      v.currentTime = frameToSeconds(selected.first, fps);
    }
  }

  function onLoadedMetadata(): void {
    const t = pendingSeekRef.current;
    if (t === null) return;
    pendingSeekRef.current = null;
    const v = videoRef.current;
    if (v) v.currentTime = t;
  }

  return {
    scenes,
    selected,
    selectScene,
    prevScene,
    nextScene,
    onTimeUpdate,
    onLoadedMetadata,
  };
}
