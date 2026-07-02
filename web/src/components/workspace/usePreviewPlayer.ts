"use client";

/**
 * usePreviewPlayer — frame-accurate playback control for the project's
 * preview proxy (Project.preview_url: a 360p h264 mp4 that is frame-exact
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
 * The video is injected as a ref of PreviewVideoLike — the minimal element
 * surface — so the mapping logic is unit-testable against a plain fake
 * object (jsdom renders <video> but never plays; that's fine).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  frameToSeconds,
  presentationTimeToFrame,
  secondsToFrame,
  type RationalFPS,
} from "@/lib/frames";

export interface PreviewFrameMetadata {
  /** presentation time (s) of the frame just displayed */
  mediaTime: number;
}

/** The slice of HTMLVideoElement the hook needs — fakeable in unit tests. */
export interface PreviewVideoLike {
  currentTime: number;
  paused: boolean;
  playbackRate: number;
  play(): unknown;
  pause(): void;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  requestVideoFrameCallback?(
    callback: (now: number, metadata: PreviewFrameMetadata) => void,
  ): number;
  cancelVideoFrameCallback?(handle: number): void;
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
}

export function usePreviewPlayer(
  videoRef: { current: PreviewVideoLike | null },
  fps: RationalFPS,
  onFrame: (frame: number) => void,
): PreviewPlayer {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(1);
  const onFrameRef = useRef(onFrame);
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
    [videoRef],
  );

  // Re-apply the rate if the element mounts after setSpeed (a fresh
  // <video> always starts at 1×).
  useEffect(() => {
    const video = videoRef.current;
    if (video && video.playbackRate !== speed) video.playbackRate = speed;
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
        onFrameRef.current(mediaTimeToFrame(metadata.mediaTime, fpsRef.current));
        handle = rvfc(onVideoFrame);
      };
      handle = rvfc(onVideoFrame);
      return () => {
        cancelled = true;
        video.cancelVideoFrameCallback?.(handle);
      };
    }
    const onTimeUpdate = () => {
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
    const onPause = () => setPlaying(false);
    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onPause);
    return () => {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onPause);
    };
  }, [videoRef]);

  const seekToFrame = useCallback(
    (frame: number) => {
      const video = videoRef.current;
      if (!video) return;
      video.currentTime = seekTimeForFrame(frame, fpsRef.current);
      onFrameRef.current(frame);
    },
    [videoRef],
  );

  const play = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const result = video.play();
    if (result instanceof Promise) {
      result.catch(() => setPlaying(false));
    }
    setPlaying(true);
  }, [videoRef]);

  const pause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
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
    () => ({ playing, play, pause, toggle, seekToFrame, speed, setSpeed }),
    [playing, play, pause, toggle, seekToFrame, speed, setSpeed],
  );
}
