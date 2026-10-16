// Tarball check: what `npm pack` would publish. The built entries, the shipped
// source, the docs and the license are in; tests, benches, e2e, scripts and
// caches are out. The release tooling audits public-candidate packages only,
// so this runs here until @arki/live is classified. Run after build:
// `bun run test:pack`.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const [pack] = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8' }));
const files = new Set(pack.files.map(file => file.path));

const required = ['package.json', 'README.md', 'llms.txt', 'docs/agent-guide.md', 'LICENSE'];
for (const target of Object.values(manifest.exports)) {
  if (typeof target === 'string') continue;
  required.push(target.types.replace(/^\.\//, ''), target.import.replace(/^\.\//, ''));
}
const missing = required.filter(file => !files.has(file));
const forbidden = [...files].filter(file =>
  /\.test\.|\.spec\.|^src\/tests\/|^(?:bench|e2e|examples|scripts|\.cache|\.turbo|node_modules)\//.test(file),
);

if (missing.length > 0 || forbidden.length > 0) {
  process.stderr.write(
    `pack check failed\n  missing: ${missing.join(', ') || 'none'}\n  forbidden: ${forbidden.join(', ') || 'none'}\n`,
  );
  process.exit(1);
}
process.stdout.write(
  `pack check passed: ${files.size} files, ${pack.size} bytes packed, ${pack.unpackedSize} unpacked\n`,
);
