// Smoke test of ./devtools, the dev panel. It renders DOM elements (`div`, `button`) over the queue
// of ./mutations, so this entry runs on Node, Bun, Deno and browsers only (package.json
// "arki.entryRuntimes").

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { OfflineDevPanel } from "../../dist/src/devtools/index.js";

// Outside a Vite dev build there is no import.meta.env.DEV, so the panel renders nothing.
const devPanelHtml = renderToStaticMarkup(createElement(OfflineDevPanel));

const checks = [
  ["the dev panel renders nothing outside a Vite dev build", devPanelHtml, ""],
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
