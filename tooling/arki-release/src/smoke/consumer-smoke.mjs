// Consumer smoke for a release wave. Copy this file into a clean consumer
// folder OUTSIDE the monorepo (bare imports resolve from the script's own
// folder), install the wave tarballs there, then run it with node AND bun:
//   node consumer-smoke.mjs && bun consumer-smoke.mjs
// It imports every `exports` entry of every installed @arki/* package.
// A missing optional peer, a Bun-only entry under node, an entry the
// package lists in `arki.bundlerOnly` (it loads only inside a bundler or a
// worker; the release smoke's Vite build checks it), or a package whose
// `arki.runtimes` claim leaves out this runtime (a React Native package claims
// only `hermes`) is reported as SKIP; any other failure exits 1.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(process.cwd(), 'node_modules', '@arki');
const runtimeName = typeof Bun === 'undefined' ? 'node' : 'bun';
const runtime = typeof Bun === 'undefined' ? `node ${process.version}` : `bun ${Bun.version}`;
let failures = 0;

for (const dir of readdirSync(root).sort()) {
  const manifest = JSON.parse(readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
  const optionalPeers = Object.entries(manifest.peerDependenciesMeta ?? {})
    .filter(([, meta]) => meta.optional === true)
    .map(([name]) => name);
  const bundlerOnly = new Set(manifest.arki?.bundlerOnly ?? []);
  const claimedRuntimes = manifest.arki?.runtimes;
  const unclaimed = claimedRuntimes !== undefined && !claimedRuntimes.includes(runtimeName);
  const entries = Object.keys(manifest.exports ?? { '.': null })
    .filter(key => key !== './package.json' && !key.includes('*'));
  for (const entry of entries) {
    const spec = entry === '.' ? manifest.name : `${manifest.name}/${entry.slice(2)}`;
    if (unclaimed) {
      console.log(`SKIP ${runtime} ${spec} (runtime not claimed: arki.runtimes is ${claimedRuntimes.join(', ')})`);
      continue;
    }
    if (bundlerOnly.has(entry)) {
      console.log(`SKIP ${runtime} ${spec} (bundler-only entry; checked by the Vite build)`);
      continue;
    }
    try {
      await import(spec);
      console.log(`PASS ${runtime} ${spec}`);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split('\n')[0] ?? '';
      const missingPeer = optionalPeers.find(peer => message.includes(`'${peer}'`));
      if (missingPeer) {
        console.log(`SKIP ${runtime} ${spec} (optional peer ${missingPeer} not installed)`);
      } else if (typeof Bun === 'undefined' && message.includes(`package 'bun'`)) {
        console.log(`SKIP ${runtime} ${spec} (Bun-only entry)`);
      } else {
        failures += 1;
        console.log(`FAIL ${runtime} ${spec}: ${message}`);
      }
    }
  }
}

process.exit(failures === 0 ? 0 : 1);
