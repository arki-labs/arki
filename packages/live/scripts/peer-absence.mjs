// Peer-absence check: the BUILT entries with every optional peer missing.
// `.` and `/testing` must load and run; each adapter entry must fail only
// because its own peer is missing, never on something else. Run after build:
// `bun run test:peers` (Node, so the resolve hooks apply).

import { readFileSync } from 'node:fs';
import { register } from 'node:module';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const optional = Object.keys(manifest.peerDependenciesMeta ?? {}).filter(
  name => manifest.peerDependenciesMeta[name].optional === true,
);
// `@orpc/*` peers come in through the oRPC entries; block the whole scope.
const peers = [...optional, '@orpc'];
register('./peer-absence-hooks.mjs', import.meta.url, { data: { peers } });

const entries = Object.entries(manifest.exports).filter(([subpath]) => subpath !== './package.json');
const portable = new Set(['.', './testing']);
const failures = [];

for (const [subpath, target] of entries) {
  const url = new URL(`../${target.import.replace(/^\.\//, '')}`, import.meta.url);
  try {
    const module = await import(url.href);
    if (!portable.has(subpath)) failures.push(`${subpath} loaded with its peers absent: it should need one`);
    else if (subpath === '.') {
      const meta = module.live({ reads: [{ schema: 'public', table: 'posts' }] });
      if (meta.live.reads.length !== 1) failures.push('. : live() did not run');
    } else if (typeof module.fakeSource().start !== 'function') failures.push('./testing: fakeSource() did not run');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (portable.has(subpath)) failures.push(`${subpath} needs a peer: ${message}`);
    else if (!/an optional peer, absent on purpose/.test(message))
      failures.push(`${subpath} failed otherwise: ${message}`);
  }
}

if (failures.length > 0) {
  process.stderr.write(`peer-absence check failed:\n${failures.map(line => `  ${line}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(
  `peer-absence check passed: . and ./testing load with ${optional.length} optional peers absent; ${entries.length - 2} adapter entries each fail on their own peer\n`,
);
