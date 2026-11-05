// Smoke test of ./error. The entry is bundler-only (package.json "arki.bundlerOnly": it imports
// @arki/ui and @arki/icons, which ship TypeScript source), so `arki-runtimes` runs this file as a
// bundle on every engine. It renders inside a Vite app (it reads `import.meta.env.DEV`), so this
// checks that the bundled entry loads and exports the component.

import { RootErrorComponent } from '../../dist/src/error.js';

const checks = [['the root error component loads', typeof RootErrorComponent, 'function']];

const engine =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? `deno ${Deno.version.deno}`
      : typeof Bun !== 'undefined'
        ? `bun ${Bun.version}`
        : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
          ? `browser ${navigator.userAgent}`
          : `node ${globalThis.process?.version ?? ''}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${engine}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
// Timers of the query client and the queue keep some engines alive after the checks end.
if (typeof globalThis.process !== 'undefined') globalThis.process.exit(0);
