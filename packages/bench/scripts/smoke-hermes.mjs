// Runs the smoke test on Hermes, the engine React Native uses. Hermes has no
// ES modules and no `console`, so the test is bundled into one script and
// given a small console shim. Uses $HERMES_BIN, or `hermes` on the PATH;
// without either it reports a loud skip.
//
// To get a binary matching React Native 0.86 (Hermes V1):
//   git clone --depth 1 --branch hermes-v250829098.0.17 https://github.com/facebook/hermes
//   cmake -S hermes -B hermes-build -G Ninja -DCMAKE_BUILD_TYPE=Release -DHERMES_ENABLE_INTL=ON
//   ninja -C hermes-build hermes      # → hermes-build/bin/hermes

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const bin = process.env.HERMES_BIN ?? 'hermes';
try {
  execFileSync(bin, ['-version'], { stdio: 'ignore' });
} catch {
  console.log(`hermes: NOT RUN — no Hermes binary (set HERMES_BIN). React Native support is unverified in this run.`);
  process.exit(0);
}

const out = new URL('../.cache/hermes/', import.meta.url);
mkdirSync(out, { recursive: true });
execFileSync(
  'bun',
  [
    'build',
    'scripts/smoke.mjs',
    '--target=browser',
    '--format=iife',
    '--external',
    'bun:jsc',
    '--outfile=.cache/hermes/bundle.js',
  ],
  {
    stdio: 'ignore',
  },
);
const shim = 'globalThis.console = { log: print, warn: print, error: print };\n';
const script = new URL('smoke.js', out);
writeFileSync(script, shim + readFileSync(new URL('bundle.js', out), 'utf8'));

const output = execFileSync(bin, [script.pathname], { encoding: 'utf8' });
process.stdout.write(output);
if (!/^hermes\b.*smoke checks passed$/m.test(output) || /^FAIL/m.test(output)) {
  console.error('hermes smoke FAILED');
  process.exit(1);
}
