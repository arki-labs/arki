// Smoke test of ./preset, the one-call offline runtime. It builds the IndexedDB query cache and the
// queue of ./mutations, so this entry runs on Node, Bun, Deno and browsers only (package.json
// "arki.entryRuntimes").

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { createOfflineRuntime } from "../../dist/src/preset/index.js";

const isBrowser = typeof window !== "undefined";

const offline = createOfflineRuntime({
  tier: "cache-only",
  appId: "smoke-app",
});
let queryClientOutcome;
try {
  queryClientOutcome =
    offline.queryClient instanceof Object ? "client" : "none";
} catch (error) {
  queryClientOutcome = /only in the browser/.test(String(error.message))
    ? "refused"
    : String(error.message);
}
const providerHtml = renderToStaticMarkup(
  createElement(offline.Provider, null, "inside"),
);
offline.dispose();

const checks = [
  [
    "runtime query client: refused on the server, real in the browser",
    queryClientOutcome,
    isBrowser ? "client" : "refused",
  ],
  ["the provider renders its children", providerHtml, "inside"],
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
