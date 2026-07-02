"use client";

/**
 * usePlayerShortcuts — the ONE implementation of the transport keyboard
 * shortcuts, shared by every page that mounts a player:
 *
 * - Space      → toggle() (play/pause)
 * - ←/→        → step(∓1 / ±1) — only when `step` is provided (the Cut and
 *                Media pages, where the frame-exact proxy makes frame
 *                stepping meaningful; the Depth/Stereo output players are
 *                decimated, so they pass no `step`)
 * - Shift ←/→  → step(±secondFrames) (±1 timecode second)
 *
 * Space on a focused BUTTON is left to the button (it activates itself);
 * mouse clicks blur transport buttons via blurAfterMouseClick so Space
 * reliably means play/pause after mouse interactions. Keys are ignored
 * while typing in a field (same guard as the page-switch keys).
 */

import { useEffect, useRef } from "react";

/** True when key events belong to a form control the user is operating. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return (
    !!el &&
    (el.tagName === "INPUT" ||
      el.tagName === "TEXTAREA" ||
      el.tagName === "SELECT" ||
      el.isContentEditable)
  );
}

export interface PlayerShortcuts {
  /** Space — play/pause. */
  toggle: () => void;
  /** Step the playhead ±n frames (←/→). Omit on decimated output players. */
  step?: (deltaFrames: number) => void;
  /** Frames in one timecode second — the Shift-arrow step. Default 1. */
  secondFrames?: number;
}

export function usePlayerShortcuts({
  toggle,
  step,
  secondFrames = 1,
}: PlayerShortcuts): void {
  const optsRef = useRef({ toggle, step, secondFrames });
  useEffect(() => {
    optsRef.current = { toggle, step, secondFrames };
  });

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent): void {
      if (isTypingTarget(e.target)) return;
      const { toggle, step, secondFrames } = optsRef.current;
      if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && step) {
        e.preventDefault();
        const magnitude = e.shiftKey ? secondFrames : 1;
        step(e.key === "ArrowRight" ? magnitude : -magnitude);
      } else if (e.key === " ") {
        // a focused <button> already toggles itself on Space
        const el = e.target as HTMLElement | null;
        if (el && el.tagName === "BUTTON") return;
        e.preventDefault();
        toggle();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
