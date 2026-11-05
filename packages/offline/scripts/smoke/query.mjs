// Smoke test of ./query, the persisted query client. It stores to IndexedDB, which React Native
// lacks, so this entry runs on Node, Bun, Deno and browsers only (package.json "arki.entryRuntimes").
// IndexedDB exists only in the browser leg: there the cache is saved, elsewhere saving returns a
// typed failure (never a throw).

import { createPersistedQueryClient } from "../../dist/src/query/index.js";

const hasIndexedDb = typeof indexedDB !== "undefined";

// Outside Vite there is no import.meta.env: the default buster is "".
const defaultBuster = createPersistedQueryClient({
  storageKey: "smoke-default",
});
const persisted = createPersistedQueryClient({
  storageKey: "smoke-query",
  buster: "v1",
});
persisted.queryClient.setQueryData(["k"], "v");
const persistOutcome = await persisted.persistNow();

const checks = [
  ["the default buster is empty outside Vite", defaultBuster.buster, ""],
  [
    "persisted client holds queries",
    persisted.queryClient.getQueryData(["k"]),
    "v",
  ],
  [
    "persisting needs IndexedDB, else a typed failure",
    hasIndexedDb ? persistOutcome === undefined : persistOutcome?.code,
    hasIndexedDb ? true : "offline.query_cache_persist_failed",
  ],
];

const runtime =
  typeof Deno !== "undefined"
    ? `deno ${Deno.version.deno}`
    : typeof Bun !== "undefined"
      ? `bun ${Bun.version}`
      : typeof navigator !== "undefined" &&
          navigator.userAgent &&
          !navigator.userAgent.includes("Node")
        ? `browser ${navigator.userAgent}`
        : `node ${globalThis.process?.version ?? ""}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(
      `FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

const summary = `${runtime}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== "undefined") globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
// Timers of the query client and the queue keep some engines alive after the checks end.
if (typeof globalThis.process !== "undefined") globalThis.process.exit(0);
