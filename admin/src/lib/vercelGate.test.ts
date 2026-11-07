/**
 * BL-23 lifted at launch (owner): Vercel builds the admin for production
 * from main and for previews from staging, and skips every other build
 * (vercel.json ignoreCommand: exit 1 builds, exit 0 skips).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(process.cwd(), "..");
const command: string = JSON.parse(readFileSync(join(root, "vercel.json"), "utf8")).ignoreCommand;

/** "build" or "skip" for this environment and ref, run where Vercel runs it. */
function gate(env: string, ref: string, cwd = root): "build" | "skip" {
  try {
    execFileSync("sh", ["-c", command], { cwd, env: { PATH: process.env.PATH ?? "", VERCEL_ENV: env, VERCEL_GIT_COMMIT_REF: ref }, stdio: "pipe" });
    return "skip";
  } catch (e) {
    if ((e as { status?: number }).status === 1) return "build";
    throw e;
  }
}

describe("the admin's Vercel build gate (BL-23)", () => {
  it("fits Vercel's schema (ignoreCommand at most 256 characters)", () => {
    expect(command.length).toBeLessThanOrEqual(256);
  });

  it("production builds from main only", () => {
    expect(gate("production", "main")).toBe("build");
    expect(gate("production", "staging")).toBe("skip");
    expect(gate("production", "feat/lifelike-web")).toBe("skip");
  });

  it("previews build from staging only", () => {
    expect(gate("preview", "staging")).toBe("build");
    expect(gate("preview", "main")).toBe("skip");
    expect(gate("preview", "feat/lifelike-web")).toBe("skip");
  });

  it("a branch without admin/ is skipped, never failed", () => {
    const bare = mkdtempSync(join(tmpdir(), "no-admin-"));
    expect(gate("production", "main", bare)).toBe("skip");
    expect(gate("preview", "staging", bare)).toBe("skip");
  });
});
