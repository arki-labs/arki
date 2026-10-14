// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser target.

import { lazyObject, once, resolveLazy } from '../dist/index.js';

import '../dist/prettify.js';
import '../dist/utils.js';

let calls = 0;
const memo = once(() => ++calls);
memo();
memo();
let built = 0;
const lazy = lazyObject(() => {
  built++;
  return { value: 7 };
});
const beforeRead = built;

const checks = [
  ['once computes one time', calls, 1],
  ['resolveLazy calls a function', resolveLazy(() => 5), 5],
  ['resolveLazy passes a value', resolveLazy(5), 5],
  ['lazyObject waits for first read', beforeRead, 0],
  ['lazyObject builds on read', lazy.value, 7],
  ['lazyObject builds once', built, 1],
];

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual === expected) continue;
  failed++;
  console.log(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const runtime =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? 'deno'
      : typeof Bun !== 'undefined'
        ? 'bun'
        : typeof window !== 'undefined'
          ? 'browser'
          : 'node';
if (failed > 0) {
  console.log(`${runtime}: ${failed} smoke checks FAILED`);
  throw new Error('smoke failed');
}
console.log(`${runtime}: ${checks.length} smoke checks passed`);
