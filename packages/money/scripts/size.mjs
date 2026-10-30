// Bundle-size budgets. Builds each entry point the way an app bundler would
// (minified, browser target, @arki/math included, optional peers external),
// gzips it, and fails when an entry grows past its budget.
//   bun run size        (needs a fresh `bun run build`)

import { gzipSync } from 'node:zlib';

// Bytes after minify + gzip, each including the core it imports.
// Re-baselined 2026-10-30 (founder decision). Rule: measured gzip size rounded
// up to the next 100 B, plus 5%, rounded up to the next 50 B.
// Why: typed parse failures from @arki/failure add the defineFailure core to
// entries that parse; money budgets were already stale since 2026-10-12.
// Commits: 5d5b7b14a1, 420db90f62, 8323e0c892, 0b70840f74.
// Raise a budget only on purpose.
const BUDGETS = {
  index: 9250,
  currency: 3900,
  errors: 1300,
  format: 1500,
  exact: 6450,
  parse: 10000,
  exchange: 9900,
  provider: 8950,
  stripe: 9350,
  rational: 13450,
  bag: 13900,
  zod: 10300,
  'drizzle/pg': 9150,
  'drizzle/mysql': 9150,
  'drizzle/sqlite': 9150,
};

async function gzipSize(entry) {
  const result = await Bun.build({
    entrypoints: [new URL(`../dist/${entry}.js`, import.meta.url).pathname],
    target: 'browser',
    minify: true,
    external: ['zod', 'drizzle-orm', 'drizzle-orm/*'],
  });
  if (!result.success) throw new AggregateError(result.logs, `bundling ${entry} failed`);
  return gzipSync(await result.outputs[0].text()).length;
}

const core = await gzipSize('index');
let failed = 0;
for (const [entry, budget] of Object.entries(BUDGETS)) {
  const size = await gzipSize(entry);
  const status = size <= budget ? 'ok  ' : 'OVER';
  if (size > budget) failed++;
  const extra = entry !== 'index' && size > core ? `  (+${size - core} over the core)` : '';
  console.log(`${status} ${entry.padEnd(9)} ${String(size).padStart(6)} B gzip, budget ${budget}${extra}`);
}
if (failed > 0) {
  console.error(`${failed} entry point(s) over budget`);
  process.exit(1);
}
