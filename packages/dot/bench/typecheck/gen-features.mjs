// Generates N chained features for the typecheck budget: feature i needs features i-1 and i-2
// through the graph, defines one usecase and one provide, and the app mounts all N.
// Usage: node bench/typecheck/gen-features.mjs <N> [--domain-services]  → bench/typecheck/.generated/features-<N>.ts
// --domain-services: each feature also declares `.domainServices({ h<i> })` after `.needs()`, and its usecase reads it.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const N = Number(process.argv[2] ?? 50);
const domainServices = process.argv.includes('--domain-services');
const here = dirname(fileURLToPath(import.meta.url));
const deps = i => [i - 1, i - 2].filter(j => j >= 0);

let out = `import { isFailure } from '@arki/failure';\nimport type { DepsOf } from '../../../src/feature.js';\nimport { defineFeature } from '../../../src/feature.js';\nimport { defineApp, infra } from '../../../src/index.js';\n\n`;
out += `export const clock = infra({ name: 'clock', provides: { now: () => ({ ms: () => Date.now() }) } });\n`;
for (let i = 0; i < N; i++) {
  const needs = [`now: clock.provides.now`, ...deps(i).map(j => `s${j}: f${j}.provides.svc${j}`)].join(', ');
  const own = domainServices ? [`h${i}`] : [];
  const picks = ['now', ...own, ...deps(i).map(j => `s${j}`)].map(k => `'${k}'`).join(' | ');
  const uses =
    deps(i)
      .map(j => `s${j}Result.length`)
      .join(' + ') || '0';
  const step = domainServices ? `.domainServices({ h${i}: () => ({ ok: true }) })` : '';
  out += `const d${i} = defineFeature('f${i}').needs({ ${needs} })${step};\n`;
  out += `const run${i} = ({ ${['now', ...own, ...deps(i).map(j => `s${j}`)].join(', ')} }: Pick<DepsOf<typeof d${i}>, ${picks}>) => () => { ${deps(
    i,
  )
    .map(j => `const s${j}Result = s${j}.run(); if (isFailure(s${j}Result)) return s${j}Result;`)
    .join(' ')} return String(now.ms() + ${uses}${domainServices ? ` + Number(h${i}.ok)` : ''}); };\n`;
  out += `export const f${i} = d${i}.usecases({ run: run${i} }).provides({ svc${i}: ({ usecases }) => ({ run: usecases.run }) }).entrypoints();\n`;
}
out += `\nexport const app = defineApp('scale').infra(clock).features([${Array.from({ length: N }, (_, i) => `f${i}`).join(', ')}]);\n`;
mkdirSync(join(here, '.generated'), { recursive: true });
writeFileSync(join(here, '.generated', `features-${N}.ts`), out);
