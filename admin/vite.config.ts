import react from "@vitejs/plugin-react";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";

import { buildCsp } from "./src/lib/csp.ts";
import { GATEWAYS } from "./src/lib/gateways.ts";

const TEST_GATEWAY = GATEWAYS.test;

/**
 * Production builds carry the CSP as a meta tag naming this build's gateway
 * (vercel.json adds the same policy as a header, with frame-ancestors). The
 * dev server has none: Vite's hot reload needs inline scripts.
 */
function cspMeta(gateway: string): Plugin {
  return {
    name: "admin-csp-meta",
    apply: "build",
    transformIndexHtml(html) {
      const csp = buildCsp({ gateways: [gateway], forHeader: false });
      return html.replace(
        '<meta charset="utf-8" />',
        `<meta charset="utf-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      );
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const gateway = env.VITE_GATEWAY_URL || TEST_GATEWAY;
  return {
    plugins: [react(), cspMeta(gateway)],
    define: {
      "import.meta.env.VITE_GATEWAY_URL": JSON.stringify(gateway),
    },
    server: { port: 5174, strictPort: true },
    preview: {
      port: 5174,
      strictPort: true,
      headers: {
        "Content-Security-Policy": buildCsp({ gateways: [gateway], forHeader: true }),
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
      },
    },
    build: { sourcemap: false },
    test: {
      environment: "jsdom",
      globals: false,
      include: ["src/**/*.test.{ts,tsx}"],
      setupFiles: ["./src/test/setup.ts"],
    },
  };
});
