import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import projectFixture from "../../../fixtures/project.json";
import type { Project } from "@/lib/api/types";

import { ANALYZE_FAILED, ANALYZE_SLOW, AnalyzeNotice } from "./AnalyzeNotice";
import {
  ANALYZE_STALL_MS,
  ANALYZE_TOO_LONG_MS,
  analyzeSlow,
  watchAnalyze,
  type ProjectState,
} from "./workspaceAtoms";

afterEach(cleanup);

function running(stage: string, progress: number, createdAt = new Date().toISOString()): Project {
  const p = structuredClone(projectFixture) as unknown as Project;
  p.analyze = { state: "running", error: "", credit_cents: 0, credit_available: false, stage, progress };
  p.created_at = createdAt;
  return p;
}

function state(project: Project, analyzeWatch: ProjectState["analyzeWatch"]): ProjectState {
  return { project, loadError: null, retrying: false, retryError: null, analyzeWatch };
}

describe("watchAnalyze / analyzeSlow", () => {
  const T = Date.parse("2026-11-05T10:00:00Z");

  it("is not slow while the progress keeps moving", () => {
    let w = watchAnalyze(null, running("thumbnails", 0.5), T);
    w = watchAnalyze(w, running("thumbnails", 0.6), T + 2 * 60_000);
    w = watchAnalyze(w, running("thumbnails", 0.7), T + 4 * 60_000);
    expect(analyzeSlow(w, T + 6 * 60_000)).toBe(false);
  });

  it("is slow once the progress hasn't moved for 3 minutes", () => {
    const t0 = T + 60_000;
    let w = watchAnalyze(null, running("thumbnails", 0.7, new Date(T).toISOString()), t0);
    w = watchAnalyze(w, running("thumbnails", 0.7), t0 + 60_000);
    w = watchAnalyze(w, running("thumbnails", 0.7), t0 + 2 * 60_000);
    expect(w?.since).toBe(t0);
    expect(analyzeSlow(w, t0 + ANALYZE_STALL_MS - 1)).toBe(false);
    expect(analyzeSlow(w, t0 + ANALYZE_STALL_MS)).toBe(true);
  });

  it("is slow after 10 minutes of analysing even while it moves", () => {
    let w = watchAnalyze(null, running("analyze", 0.1, new Date(T).toISOString()), T + 1000);
    w = watchAnalyze(w, running("analyze", 0.9), T + ANALYZE_TOO_LONG_MS);
    expect(w?.since).toBe(T + ANALYZE_TOO_LONG_MS);
    expect(analyzeSlow(w, T + ANALYZE_TOO_LONG_MS)).toBe(true);
  });

  it("stops watching once the analysis is no longer running", () => {
    const w = watchAnalyze(null, running("analyze", 0.1), T);
    const done = running("analyze", 1);
    done.analyze = { ...done.analyze, state: "succeeded" };
    expect(watchAnalyze(w, done, T + ANALYZE_TOO_LONG_MS)).toBeNull();
    expect(analyzeSlow(null, T + ANALYZE_TOO_LONG_MS)).toBe(false);
  });
});

describe("AnalyzeNotice", () => {
  it("stalled progress says it's taking longer than usual, with Refresh", () => {
    const now = Date.now();
    const p = running("thumbnails", 0.7);
    const onRefresh = vi.fn();
    render(
      <AnalyzeNotice
        state={state(p, { key: "thumbnails|0.7", since: now - ANALYZE_STALL_MS - 1000, started: now - 4 * 60_000 })}
        onRefresh={onRefresh}
        onRetry={vi.fn()}
      />,
    );
    const notice = screen.getByTestId("analyze-slow");
    expect(notice.textContent).toContain(ANALYZE_SLOW);
    screen.getByRole("button", { name: "Refresh" }).click();
    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("says nothing while the progress moved recently", () => {
    const now = Date.now();
    render(
      <AnalyzeNotice
        state={state(running("thumbnails", 0.7), { key: "thumbnails|0.7", since: now - 60_000, started: now - 2 * 60_000 })}
        onRefresh={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("analyze-slow")).toBeNull();
  });

  it("a failed analysis says so, with Try again and Contact support", () => {
    const p = running("thumbnails", 0.7);
    p.analyze = { ...p.analyze, state: "failed", error: "ffmpeg exited 1" };
    const onRetry = vi.fn();
    render(<AnalyzeNotice state={state(p, null)} onRefresh={vi.fn()} onRetry={onRetry} />);
    const notice = screen.getByTestId("analyze-failed");
    expect(notice.textContent).toContain(ANALYZE_FAILED);
    expect(notice.textContent).not.toContain("ffmpeg");
    screen.getByRole("button", { name: "Try again" }).click();
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Contact support" }).getAttribute("href")).toMatch(/^mailto:/);
  });
});
