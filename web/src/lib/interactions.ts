/**
 * Tiny interaction helpers shared by the workspace and step pages.
 */

import type { MouseEvent } from "react";

/**
 * Blur a control after MOUSE activation so the global Space shortcut keeps
 * meaning play/pause instead of re-activating the last clicked button
 * (clicking Play/step/Add-cut left focus on the button, and the focused
 * button swallowed the next Space press). Keyboard activations dispatch
 * click with detail 0, so tab users keep focus and Space still activates
 * the focused control.
 */
export function blurAfterMouseClick(e: MouseEvent<HTMLElement>): void {
  if (e.detail > 0) e.currentTarget.blur();
}
