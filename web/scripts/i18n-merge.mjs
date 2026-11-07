#!/usr/bin/env node
/**
 * Merges a fragment of English messages into messages/en.json, under a
 * lock, so several people (or agents) can add their namespaces at once:
 *
 *   node scripts/i18n-merge.mjs path/to/fragment.json
 *
 * The fragment is { "<namespace>": { ...keys } }; it is deep-merged (its
 * values win), keeping en.json's order and adding new keys at the end.
 */
import { mkdirSync, readFileSync, rmdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "messages", "en.json");
const lock = join(root, "messages", ".en.lock");
const frag = process.argv[2];
if (!frag) {
  console.error("usage: node scripts/i18n-merge.mjs fragment.json");
  process.exit(2);
}
const add = JSON.parse(readFileSync(frag, "utf8"));

function merge(into, from) {
  for (const [k, v] of Object.entries(from)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      if (typeof into[k] !== "object" || into[k] === null) into[k] = {};
      merge(into[k], v);
    } else if (typeof v === "string") {
      into[k] = v;
    } else {
      throw new Error(`${k}: messages are strings or objects`);
    }
  }
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let held = false;
for (let i = 0; i < 400 && !held; i++) {
  try {
    mkdirSync(lock);
    held = true;
  } catch {
    sleep(50);
  }
}
if (!held) {
  console.error("en.json is locked (messages/.en.lock); remove it if nothing is merging");
  process.exit(1);
}
try {
  const en = JSON.parse(readFileSync(target, "utf8"));
  merge(en, add);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(en, null, 2)}\n`);
  renameSync(tmp, target);
  const count = (o) => Object.values(o).reduce((n, v) => n + (typeof v === "string" ? 1 : count(v)), 0);
  console.log(`en.json: ${count(en)} messages`);
} finally {
  rmdirSync(lock);
}
