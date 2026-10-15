// RFC §9.2: `derivative` callers pay nothing for steps. Walks the import graph
// of the BUILT package from dist/derivative.js and fails if it reaches
// dist/derivation.js, so no bundler can include the tree, template or step
// printing code. Run by `bun run test` after the build.

import { readFileSync } from 'node:fs';

const reached = new Set();
const stack = ['derivative.js'];
for (let file = stack.pop(); file !== undefined; file = stack.pop()) {
  if (reached.has(file)) continue;
  reached.add(file);
  const source = readFileSync(new URL(`../dist/${file}`, import.meta.url), 'utf8');
  for (const match of source.matchAll(/^(?:import|export)\s[^;]*?from '\.\/([\w-]+\.js)';/gmu)) stack.push(match[1]);
}

if (!reached.has('differentiate.js')) throw new Error('entries: dist/derivative.js no longer imports differentiate.js');
if (reached.has('derivation.js')) {
  throw new Error(`entries: dist/derivative.js reaches derivation.js through ${[...reached].join(', ')}`);
}
