## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## State (web app)

Shared state on the web app lives in jotai atoms (ADR 0138; see the
"State" section of `web/README.md`):

- jotai for anything two components read and for every server answer;
  `useState` only for local, short-lived UI; no React context for state.
- Atoms sit next to their feature in `*Atoms.ts`; the app store holds the
  session's state (`useApp*` hooks), each project page has its own store
  (`ProjectStateProvider`); per-item atoms use `jotai-family`.
- Async atoms are latest-wins (sequence number or per-request cache),
  debounced, with a timeout and an error state; no tokens or clients in
  atoms; persist only plain UI state with `atomWithStorage`.
- ESLint enforces it; `STATE_ALLOWLIST` in `web/eslint.config.mjs` only
  shrinks.
