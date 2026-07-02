/**
 * usePlayerShortcuts tests — the ONE transport-keys implementation shared
 * by the Media/Cut proxies and the Depth/Stereo output players: Space →
 * toggle (unless a button is focused — it activates itself), ←/→ →
 * step(±1), Shift-arrow → step(±secondFrames), all ignored while typing,
 * with preventDefault on handled keys (fireEvent returns false when the
 * default was prevented).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isTypingTarget,
  usePlayerShortcuts,
  type PlayerShortcuts,
} from "./usePlayerShortcuts";

afterEach(cleanup);

function Harness(props: PlayerShortcuts) {
  usePlayerShortcuts(props);
  return (
    <div>
      <input aria-label="a field" />
      <button type="button">a button</button>
    </div>
  );
}

function renderHarness(overrides: Partial<PlayerShortcuts> = {}) {
  const toggle = vi.fn();
  const step = vi.fn();
  render(
    <Harness toggle={toggle} step={step} secondFrames={24} {...overrides} />,
  );
  return { toggle, step };
}

describe("usePlayerShortcuts", () => {
  it("Space toggles play/pause and prevents the default (page scroll)", () => {
    const { toggle, step } = renderHarness();
    const notPrevented = fireEvent.keyDown(window, { key: " " });
    expect(toggle).toHaveBeenCalledTimes(1);
    expect(step).not.toHaveBeenCalled();
    expect(notPrevented).toBe(false); // preventDefault was called
  });

  it("arrows step ±1 frame, Shift-arrows ±secondFrames, both preventDefault", () => {
    const { step } = renderHarness();

    expect(fireEvent.keyDown(window, { key: "ArrowRight" })).toBe(false);
    expect(step).toHaveBeenLastCalledWith(1);
    expect(fireEvent.keyDown(window, { key: "ArrowLeft" })).toBe(false);
    expect(step).toHaveBeenLastCalledWith(-1);

    expect(
      fireEvent.keyDown(window, { key: "ArrowRight", shiftKey: true }),
    ).toBe(false);
    expect(step).toHaveBeenLastCalledWith(24);
    expect(
      fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true }),
    ).toBe(false);
    expect(step).toHaveBeenLastCalledWith(-24);
  });

  it("without a step handler (decimated output players) arrows fall through untouched", () => {
    const { toggle } = renderHarness({ step: undefined });
    // not prevented — the page keeps its native arrow behavior
    expect(fireEvent.keyDown(window, { key: "ArrowRight" })).toBe(true);
    expect(fireEvent.keyDown(window, { key: "ArrowLeft" })).toBe(true);
    // Space still toggles
    fireEvent.keyDown(window, { key: " " });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("ignores keys while typing in a field", () => {
    const { toggle, step } = renderHarness();
    const field = screen.getByLabelText("a field");
    expect(fireEvent.keyDown(field, { key: " " })).toBe(true);
    expect(fireEvent.keyDown(field, { key: "ArrowRight" })).toBe(true);
    expect(toggle).not.toHaveBeenCalled();
    expect(step).not.toHaveBeenCalled();
  });

  it("leaves Space to a focused button (it activates itself)", () => {
    const { toggle, step } = renderHarness();
    const button = screen.getByRole("button", { name: "a button" });
    expect(fireEvent.keyDown(button, { key: " " })).toBe(true);
    expect(toggle).not.toHaveBeenCalled();
    // …but arrows still step even with a button focused
    fireEvent.keyDown(button, { key: "ArrowRight" });
    expect(step).toHaveBeenCalledWith(1);
  });
});

describe("isTypingTarget", () => {
  it("names form controls and contenteditable as typing targets", () => {
    for (const tag of ["input", "textarea", "select"]) {
      expect(isTypingTarget(document.createElement(tag))).toBe(true);
    }
    // jsdom leaves isContentEditable undefined on detached elements — the
    // contract is truthy/falsy, not strict booleans
    expect(isTypingTarget(document.createElement("button"))).toBeFalsy();
    expect(isTypingTarget(document.createElement("div"))).toBeFalsy();
    expect(isTypingTarget(null)).toBeFalsy();
  });
});
