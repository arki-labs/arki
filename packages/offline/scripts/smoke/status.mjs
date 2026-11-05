// Smoke test of ./status, the online state and the headless banner. It reads browser online events
// and the queue of ./mutations, so this entry runs on Node, Bun, Deno and browsers only
// (package.json "arki.entryRuntimes"). Server rendering uses the stable "online" snapshot.

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OfflineBanner } from "../../dist/src/status/index.js";

const bannerHtml = renderToStaticMarkup(
  createElement(
    OfflineBanner,
    null,
    (state) => `online=${state.online} queued=${state.queued}`,
  ),
);

const checks = [
  [
    "banner renders the online state without a queue provider",
    bannerHtml,
    "online=true queued=0",
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
