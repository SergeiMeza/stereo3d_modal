"use client";

/**
 * usePreviewPlayer — frame-accurate playback control for the project's
 * preview proxy (Project.preview_url: a 480p h264 mp4 that is frame-exact
 * 1:1 with the source, so frame n of the proxy IS source frame n).
 *
 * This hook owns the ONLY frame↔time mapping in the workspace, built purely
 * from src/lib/frames.ts helpers:
 *
 * - Seeks land MID-frame (`frameToSeconds(f) + frameToSeconds(1)/2`), never
 *   on a frame boundary — boundary times are ambiguous between two frames
 *   (the class of bug behind the frame doctrine).
 * - The current-frame readout comes from requestVideoFrameCallback's
 *   mediaTime (the exact presentation time of the displayed frame) when the
 *   browser supports it, falling back to timeupdate + currentTime; both are
 *   mapped with secondsToFrame.
 * - Pausing snaps the readout to the exact frame under the paused time and
 *   re-seeks the video to that frame's mid-point so pixels match the number.
 *
 * - Strip hover (owner 2026-11-07): while stripHoverFrameAtom holds a
 *   frame, the video shows it and the readout stays put (frames shown
 *   for a hover are never reported). One seek at a time: positions that
 *   arrive while a seek runs are dropped except the latest, which a
 *   fastSeek reaches quickly and an exact seek then lands on. A playing
 *   video holds still while hovered. When the hover ends the video goes
 *   back to its own time and plays again if it was playing.
 *
 * The video is injected as a ref of PreviewVideoLike — the minimal element
 * surface — so the mapping logic is unit-testable against a plain fake
 * object (jsdom renders <video> but never plays; that's fine).
 */

import { appStore, useAppAtom } from "@/lib/state/stores";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  frameToSeconds,
  presentationTimeToFrame,
  secondsToFrame,
  type RationalFPS,
} from "@/lib/frames";
import { mutedAtom, playbackSpeedAtom, stripHoverFrameAtom } from "@/lib/viewerPrefs";

export interface PreviewFrameMetadata {
  /** presentation time (s) of the frame just displayed */
  mediaTime: number;
}

/** The slice of HTMLVideoElement the hook needs — fakeable in unit tests. */
export interface PreviewVideoLike {
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  muted: boolean;
  play(): unknown;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  requestVideoFrameCallback?(
    callback: (now: number, metadata: PreviewFrameMetadata) => void,
  ): number;
  cancelVideoFrameCallback?(handle: number): void;
  /** Quick, keyframe-accurate seek (Safari, Firefox). */
  fastSeek?(time: number): void;
}

/** A seek that never reports `seeked` (no media yet, jsdom) stops
 * holding up the next hover position after this long. */
export const HOVER_SEEK_GIVE_UP_MS = 250;

/** One strip hover: where to go back to, and the seek in flight. */
interface HoverSession {
  /** the video's own time, to restore on leave (a click moves it) */
  restoreTime: number;
  /** play again on leave */
  resume: boolean;
  /** the latest hovered frame */
  target: number;
  /** the frame the running seek goes to, or null when none runs */
  inFlight: number | null;
  /** the running seek was a fastSeek (an exact one follows) */
  fast: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The currentTime to display frame `frame`: its start plus HALF a frame
 * duration, safely inside the frame's interval at any float precision. */
export function seekTimeForFrame(frame: number, fps: RationalFPS): number {
  return frameToSeconds(frame, fps) + frameToSeconds(1, fps) / 2;
}

/** The frame a PRESENTED frame's mediaTime names. rVFC mediaTime is a frame
 * START timestamp (microsecond-quantized by Chromium), so this rounds to
 * nearest — floor here left the stepper stuck on frames whose PTS rounds
 * down. For ARBITRARY times (currentTime mid-playback) use
 * currentTimeToFrame instead. */
export function mediaTimeToFrame(mediaTime: number, fps: RationalFPS): number {
  return presentationTimeToFrame(mediaTime, fps);
}

/** The frame an arbitrary playback time falls in (floor semantics). */
export function currentTimeToFrame(time: number, fps: RationalFPS): number {
  return secondsToFrame(time, fps);
}

export interface PreviewPlayer {
  playing: boolean;
  play(): void;
  pause(): void;
  toggle(): void;
  /** Frame-accurate seek to `frame`'s mid-point; reports the frame
   * immediately so readouts don't wait for the seek to complete. */
  seekToFrame(frame: number): void;
  /** Playback rate (video.playbackRate). Frame identity is unaffected —
   * rVFC still reports every presented frame's own timestamp. */
  speed: number;
  setSpeed(rate: number): void;
  /** Audio mute (video.muted). Defaults to TRUE — the element keeps its
   * `muted` attribute so autoplay isn't blocked; unmuting is always a user
   * gesture, which browsers allow. */
  muted: boolean;
  setMuted(muted: boolean): void;
}

export function usePreviewPlayer(
  videoRef: { current: PreviewVideoLike | null },
  fps: RationalFPS,
  onFrame: (frame: number) => void,
): PreviewPlayer {
  const [playing, setPlaying] = useState(false);
  // speed and muted are shared viewer prefs (jotai) — the tab panels
  // unmount on every switch, and these should follow the user across tabs.
  // muted defaults to true (autoplay policy) — React only applies the
  // `muted` prop on mount, so changes go through the element, like speed.
  const [speed, setSpeedState] = useAppAtom(playbackSpeedAtom);
  const [muted, setMutedState] = useAppAtom(mutedAtom);
  const onFrameRef = useRef(onFrame);
  // strip hover: the session while hovered; `restoring` until the seek
  // back to the video's own time lands (frames on the way stay unreported)
  const hoverRef = useRef<HoverSession | null>(null);
  const restoringRef = useRef(false);
  const fpsRef = useRef(fps);
  useEffect(() => {
    onFrameRef.current = onFrame;
    fpsRef.current = fps;
  });

  const setSpeed = useCallback(
    (rate: number) => {
      setSpeedState(rate);
      const video = videoRef.current;
      if (video) video.playbackRate = rate;
    },
    [videoRef, setSpeedState],
  );

  const setMuted = useCallback(
    (m: boolean) => {
      setMutedState(m);
      const video = videoRef.current;
      if (video) video.muted = m;
    },
    [videoRef, setMutedState],
  );

  // Re-apply the rate/mute if the element mounts after setSpeed/setMuted
  // (a fresh <video> always starts at 1× and its initial muted attribute).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.playbackRate !== speed) video.playbackRate = speed;
    if (video.muted !== muted) video.muted = muted;
  });

  // Current-frame readout: rVFC when available (exact mediaTime of each
  // presented frame, including after paused seeks), else timeupdate.
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const rvfc = video.requestVideoFrameCallback?.bind(video);
    if (rvfc) {
      let cancelled = false;
      let handle = 0;
      const onVideoFrame = (_now: number, metadata: PreviewFrameMetadata) => {
        if (cancelled) return;
        if (!hoverRef.current && !restoringRef.current) {
          onFrameRef.current(mediaTimeToFrame(metadata.mediaTime, fpsRef.current));
        }
        handle = rvfc(onVideoFrame);
      };
      handle = rvfc(onVideoFrame);
      return () => {
        cancelled = true;
        video.cancelVideoFrameCallback?.(handle);
      };
    }
    const onTimeUpdate = () => {
      if (hoverRef.current || restoringRef.current) return;
      onFrameRef.current(currentTimeToFrame(video.currentTime, fpsRef.current));
    };
    video.addEventListener("timeupdate", onTimeUpdate);
    return () => video.removeEventListener("timeupdate", onTimeUpdate);
  }, [videoRef]);

  // Keep `playing` honest against native state changes (ended, browser UI).
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const onPlay = () => setPlaying(true);
    // a hover holds a playing video still without it reading as paused
    const onPause = () => {
      if (!hoverRef.current) setPlaying(false);
    };
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onPause);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onPause);
    };
  }, [videoRef]);

  // ------------------------------------------------------- strip hover
  const issueHoverSeek = useCallback(
    (video: PreviewVideoLike, h: HoverSession, fast: boolean) => {
      const t = seekTimeForFrame(h.target, fpsRef.current);
      h.inFlight = h.target;
      h.fast = fast && typeof video.fastSeek === "function";
      if (h.fast) video.fastSeek!(t);
      else video.currentTime = t;
      if (h.timer !== null) clearTimeout(h.timer);
      h.timer = setTimeout(() => hoverSeekDone(video, h), HOVER_SEEK_GIVE_UP_MS);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hoverSeekDone is a stable function declaration below
    [],
  );

  /** A hover seek landed (or gave up): go on to the latest position. */
  function hoverSeekDone(video: PreviewVideoLike, h: HoverSession): void {
    if (h.inFlight === null) return;
    if (h.timer !== null) clearTimeout(h.timer);
    h.timer = null;
    const landed = h.inFlight;
    const wasFast = h.fast;
    h.inFlight = null;
    if (hoverRef.current !== h) return;
    // still moving: catch up quickly; at rest after a quick seek: land exactly
    if (h.target !== landed) issueHoverSeek(video, h, true);
    else if (wasFast) issueHoverSeek(video, h, false);
  }

  useEffect(() => {
    let restoreTimer: ReturnType<typeof setTimeout> | null = null;
    let listened: PreviewVideoLike | null = null;
    const onSeeked = () => {
      const video = videoRef.current;
      const h = hoverRef.current;
      if (video && h) hoverSeekDone(video, h);
      else restoringRef.current = false;
    };
    const unsub = appStore.sub(stripHoverFrameAtom, () => {
      const frame = appStore.get(stripHoverFrameAtom);
      const video = videoRef.current;
      if (!video) return;
      if (listened !== video) {
        listened?.removeEventListener("seeked", onSeeked);
        listened = video;
        video.addEventListener("seeked", onSeeked);
      }
      let h = hoverRef.current;
      if (frame === null) {
        if (!h) return;
        // leave: back to the video's own time, playing again if it was
        hoverRef.current = null;
        if (h.timer !== null) clearTimeout(h.timer);
        restoringRef.current = true;
        if (restoreTimer !== null) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(() => {
          restoringRef.current = false;
        }, HOVER_SEEK_GIVE_UP_MS);
        video.currentTime = h.restoreTime;
        if (h.resume) {
          const result = video.play();
          if (result instanceof Promise) result.catch(() => setPlaying(false));
        }
        return;
      }
      if (!h) {
        h = {
          restoreTime: video.currentTime,
          resume: !video.paused,
          target: frame,
          inFlight: null,
          fast: false,
          timer: null,
        };
        hoverRef.current = h;
        if (h.resume) video.pause();
      }
      h.target = frame;
      if (h.inFlight === null) issueHoverSeek(video, h, false);
    });
    return () => {
      unsub();
      if (restoreTimer !== null) clearTimeout(restoreTimer);
      const h = hoverRef.current;
      if (h?.timer) clearTimeout(h.timer);
      hoverRef.current = null;
      restoringRef.current = false;
      listened?.removeEventListener("seeked", onSeeked);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- hoverSeekDone/issueHoverSeek are stable
  }, [videoRef]);

  const seekToFrame = useCallback(
    (frame: number) => {
      const video = videoRef.current;
      if (!video) return;
      const h = hoverRef.current;
      if (h) {
        // a click or a step while hovered is where the video goes back to
        h.restoreTime = seekTimeForFrame(frame, fpsRef.current);
        h.target = frame;
        if (h.inFlight === null) issueHoverSeek(video, h, false);
      } else {
        video.currentTime = seekTimeForFrame(frame, fpsRef.current);
      }
      onFrameRef.current(frame);
    },
    [videoRef, issueHoverSeek],
  );

  const play = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const h = hoverRef.current;
    if (h) {
      // held still while hovered: plays once the pointer leaves
      h.resume = true;
      setPlaying(true);
      return;
    }
    const result = video.play();
    if (result instanceof Promise) {
      result.catch(() => setPlaying(false));
    }
    setPlaying(true);
  }, [videoRef]);

  const pause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const h = hoverRef.current;
    if (h) {
      // the video already holds still; it stays paused after the hover
      h.resume = false;
      setPlaying(false);
      return;
    }
    video.pause();
    // Snap: readout gets the exact frame under the paused time, and the
    // video re-seeks to that frame's mid-point so the pixels match.
    const frame = currentTimeToFrame(video.currentTime, fpsRef.current);
    video.currentTime = seekTimeForFrame(frame, fpsRef.current);
    onFrameRef.current(frame);
    setPlaying(false);
  }, [videoRef]);

  const toggle = useCallback(() => {
    if (playing) pause();
    else play();
  }, [playing, play, pause]);

  return useMemo(
    () => ({
      playing,
      play,
      pause,
      toggle,
      seekToFrame,
      speed,
      setSpeed,
      muted,
      setMuted,
    }),
    [playing, play, pause, toggle, seekToFrame, speed, setSpeed, muted, setMuted],
  );
}
