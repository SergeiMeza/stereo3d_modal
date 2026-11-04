/**
 * QA 2026-11-05: the layout's title template adds the brand ("%s — Spatial
 * Video Studio"), so no page title may carry it again ("Set up Business or
 * Studio · Spatial Video Studio — Spatial Video Studio").
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { SITE_NAME } from "@/lib/site";

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return pages(path);
    return /^(page|layout)\.tsx?$/.test(name) && path !== join(__dirname, "layout.tsx") ? [path] : [];
  });
}

describe("page titles", () => {
  it("never repeat the brand the layout template adds", () => {
    const offenders = pages(__dirname).filter((file) => {
      const src = readFileSync(file, "utf8");
      return [...src.matchAll(/title:\s*(["`])([^"`]*)\1/g)].some(
        (m) => m[2].includes(SITE_NAME) || m[2].includes("${SITE_NAME}"),
      );
    });
    expect(offenders).toEqual([]);
  });
});
