import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The same clock and language everywhere (CI 2026-11-07): several date
// tests read the local day, and Intl's default locale comes from LANG, so
// a run in Los Angeles or with a German system failed where CI (UTC) and
// Tokyo passed. The test workers start with these.
process.env.TZ = "UTC";
process.env.LANG = "en_US.UTF-8";
process.env.LC_ALL = "en_US.UTF-8";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: false, // tests import { describe, it, expect } from "vitest"
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
