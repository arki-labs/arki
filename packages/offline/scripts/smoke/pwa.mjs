// Smoke test of ./pwa, the Workbox strategy handlers. Workbox reads the worker global `self`
// when it loads, so this entry runs where `self` exists (package.json "arki.entryRuntimes"), and,
// being bundler-only, as a bundle.

import { createStrategy } from "../../dist/src/pwa/index.js";

const strategy = createStrategy("networkFirst", {
  cacheName: "smoke-api",
  maxEntries: 5,
});

const checks = [
  ["workbox strategy keeps its cache name", strategy.cacheName, "smoke-api"],
];

const runtime =
  typeof HermesInternal !== "undefined"
    ? "hermes"
    : typeof Deno !== "undefined"
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
