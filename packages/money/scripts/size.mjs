// Bundle-size budgets. Builds each entry point the way an app bundler would
// (minified, browser target, @arki/math included, optional peers external),
// gzips it, and fails when an entry grows past its budget.
//   bun run size        (needs a fresh `bun run build`)

import { gzipSync } from 'node:zlib';

// Bytes after minify + gzip, each including the core it imports. Measured
// 2026-10-12 plus about 8% headroom. Raise a budget only on purpose.
const BUDGETS = {
  index: 6800,
  currency: 2500,
  errors: 600,
  format: 1200,
  exact: 4400,
  parse: 7800,
  exchange: 7500,
  provider: 6600,
  stripe: 7000,
  rational: 10_200,
  bag: 10_700,
  zod: 8300,
  drizzle: 6700,
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
