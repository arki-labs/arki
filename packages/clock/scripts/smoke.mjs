// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser target.

import { CLOCK_ERROR_CODES, ClockError, MockClock, SystemClock } from '../dist/index.js';

const clock = new MockClock(new Date('2026-01-01T00:00:00.000Z'));
clock.advance(1500);
const afterAdvance = clock.now().toISOString();
clock.setNow(new Date('2025-06-01T00:00:00.000Z'));
const afterSet = clock.now().toISOString();
const copy = clock.now();
copy.setTime(0);
let code = 'none';
try {
  clock.advance(-1);
} catch (error) {
  code = error instanceof ClockError ? error.code : error.name;
}
const system = new SystemClock().now().getTime();

const checks = [
  ['advance moves forward', afterAdvance, '2026-01-01T00:00:01.500Z'],
  ['setNow may go back', afterSet, '2025-06-01T00:00:00.000Z'],
  ['now returns a fresh Date', clock.now().getTime() === 0, false],
  ['negative advance is coded', code, CLOCK_ERROR_CODES.invalidAdvance],
  ['system clock is current', Math.abs(system - Date.now()) < 1000, true],
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
