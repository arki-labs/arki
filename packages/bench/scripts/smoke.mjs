// Cross-runtime smoke test of the portable core (`@arki/bench/core`): define a
// suite, run it, render it. Runs the BUILT package under Node, Bun and Deno via
// `bun run test:runtimes`, and is bundled for the browser target. The unit
// tests cover the details; this proves the core has no host-only dependency.

import { compare, defineSuite, renderMarkdown, renderText, runSuite, scenario } from '../dist/core/index.js';

const suite = defineSuite({
  id: 'smoke',
  groups: [
    compare({
      id: 'sum',
      title: 'Sum an array',
      contract: { id: 'sum/v1', description: 'the sum of the numbers' },
      inputs: [[1, 2, 3], [], [-1, 1]],
      expected: xs => xs.reduce((a, b) => a + b, 0),
      baseline: 'loop',
      cases: {
        loop: {
          run: xs => {
            let total = 0;
            for (const x of xs) total += x;
            return total;
          },
        },
        reduce: { run: xs => xs.reduce((a, b) => a + b, 0) },
        wrong: { run: xs => xs.length, differs: 'counts instead of summing' },
      },
    }),
    scenario({ kind: 'scenario', id: 'misc', title: 'Misc', cases: { json: { run: () => JSON.stringify({ a: 1 }) } } }),
  ],
});

// No top-level await: the Hermes leg bundles this file as a classic script.
function report(result) {
  const text = renderText(result);
  const markdown = renderMarkdown(result);
  const sum = result.groups.find(group => group.id === 'sum');

  const checks = [
    ['contract checked', sum?.check?.status, 'passed'],
    ['three cases measured', sum?.cases.length, 3],
    ['differs row not ranked', sum?.comparisons.some(comparison => comparison.case === 'wrong'), false],
    ['quick runs never publishable', result.publishable, false],
    ['text report renders', text.includes('Sum an array'), true],
    ['markdown ends with meta', markdown.trimEnd().endsWith('-->'), true],
  ];

  const runtime =
    typeof Deno !== 'undefined'
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
      console.log(`FAIL ${name}: expected ${String(expected)}, got ${String(actual)}`);
    }
  }
  console.log(`${runtime}: ${checks.length - failed}/${checks.length} smoke checks passed`);
  globalThis.__benchSmokeDone = true;
  if (failed > 0 && typeof globalThis.process?.exit === 'function') globalThis.process.exit(1);
}

runSuite(suite, { profile: 'quick', budget: { blockMs: 2, warmupMs: 2 } }).then(report, error => {
  console.log(`FAIL run threw: ${error instanceof Error ? error.message : String(error)}`);
  globalThis.__benchSmokeDone = true;
  if (typeof globalThis.process?.exit === 'function') globalThis.process.exit(1);
});
