// Cross-runtime smoke test. Runs the BUILT helper entries on the bare Hermes runner via
// `bun run test:runtimes` (the only engine this package claims): class merging, colours,
// initials, debounce. The components need Fabric and native modules, which that runner
// does not have; `app/` renders them in a release iOS app instead (`ARKI_RN_APP=1`).

import { cn } from "../dist/src/lib/cn.js";
import {
  debounce,
  formatFileSize,
  getInitials,
  truncate,
} from "../dist/src/lib/utils.js";
import {
  darkenColor,
  hexToRgba,
  isValidHexColor,
  lightenColor,
} from "../dist/src/lib/colors.js";

let debounced = 0;
const bump = debounce(() => {
  debounced += 1;
}, 10);
bump();
bump();
bump.cancel();
const fired = debounce(() => {
  debounced += 10;
}, 5);
fired();
await new Promise((resolve) => setTimeout(resolve, 40));

const throwsRange = (run) => {
  try {
    run();
    return "no throw";
  } catch (error) {
    return error instanceof RangeError ? "RangeError" : "other";
  }
};

const checks = [
  [
    "cn keeps the last conflicting utility",
    cn("px-2 py-1", "px-4"),
    "py-1 px-4",
  ],
  ["cn drops falsy values", cn("a", false && "b", undefined, "c"), "a c"],
  ["cn merges a conditional class", cn("p-1", { "m-2": true }), "p-1 m-2"],
  ["initials of two words", getInitials("Ada Lovelace"), "AL"],
  ["initials of one word", getInitials("ada"), "AD"],
  ["truncate shortens text", truncate("abcdefghij", 5).length <= 5, true],
  ["file size is formatted", typeof formatFileSize(2048), "string"],
  ["debounce cancel stops a call and a later call fires once", debounced, 10],
  ["valid hex colour", isValidHexColor("#a1b2c3"), true],
  ["invalid hex colour is refused", isValidHexColor("#zzz"), false],
  ["hex to rgba", hexToRgba("#ff0000", 0.5), "rgba(255, 0, 0, 0.5)"],
  ["hex to rgba reads #rgb", hexToRgba("#f00"), "rgba(255, 0, 0, 1)"],
  ["hex to rgba reads #rrggbbaa", hexToRgba("#ff000080"), "rgba(255, 0, 0, 0.502)"],
  ["lighten reads #rgb", lightenColor("#abc", 10), "#c4d5e6"],
  ["lighten keeps the alpha pair", lightenColor("#ff000080", 10), "#ff1a1a80"],
  ["darken reads #rgb", darkenColor("#abc", 10), "#91a2b3"],
  ["lighten refuses non-hex text", throwsRange(() => lightenColor("zzz", 10)), "RangeError"],
  ["darken refuses text without #", throwsRange(() => darkenColor("aabbcc", 10)), "RangeError"],
  ["hex to rgba refuses non-hex text", throwsRange(() => hexToRgba("red")), "RangeError"],
  [
    "lighten and darken are inverse at the ends",
    `${lightenColor("#000000", 100)}/${darkenColor("#ffffff", 100)}`,
    "#ffffff/#000000",
  ],
];

const engine =
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

const summary = `${engine}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== "undefined") globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
// Timers of the query client and the queue keep some engines alive after the checks end.
if (typeof globalThis.process !== "undefined") globalThis.process.exit(0);
