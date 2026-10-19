// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser and Hermes targets.
// Covers the portable entries only: `.`, `./plugin`, `./feature`, `./log`, `./runtime`.

import { isFailure } from '@arki/failure';
import { defineFeature } from '../dist/feature.js';
import {
  defineApp,
  DOT_MANIFEST_ERROR_CODE,
  DotLifecycleError,
  DotLifecycleErrorCode,
  plugin,
  toJsonObject,
} from '../dist/index.js';
import { log } from '../dist/log.js';
import { plugin as pluginFromSubpath } from '../dist/plugin.js';
import { createAppRuntime } from '../dist/runtime.js';

const events = [];
const store = plugin({
  name: 'store',
  provides: { store: () => ({ get: key => `value:${key}` }) },
  start: () => {
    events.push('store.start');
  },
  stop: () => {
    events.push('store.stop');
  },
});
const consumer = plugin({
  name: 'consumer',
  needs: { store: store.provides.store },
  provides: {
    lookup:
      ({ store: s }) =>
      key =>
        s.get(key),
  },
  start: () => {
    events.push('consumer.start');
  },
  stop: () => {
    events.push('consumer.stop');
  },
});

const app = await defineApp('smoke').use(store).use(consumer).start();
if (isFailure(app)) throw new Error(app.code);
const looked = app.services.lookup('a');
const stateStarted = app.state;
const disposal = await app.dispose();
if (isFailure(disposal)) throw new Error(disposal.code);

let duplicate = { code: 'none', remediation: '', docsUrl: '' };
try {
  await defineApp('dup').use(store).use(store).boot();
} catch (error) {
  if (error instanceof DotLifecycleError) duplicate = error;
}

let manifestCode = 'none';
try {
  toJsonObject({ when: new Date() });
} catch (error) {
  manifestCode = error.code;
}

// One start for concurrent callers: both get the same started app.
const ticker = plugin({ name: 'ticker', provides: { ticker: () => 'tick' } });
const appRuntime = createAppRuntime(defineApp('runtime-smoke').use(ticker));
const [firstRun, secondRun] = await Promise.all([appRuntime.get(), appRuntime.get()]);
if (isFailure(firstRun) || isFailure(secondRun)) throw new Error('Runtime did not start');
const runtimeSharesOneApp = firstRun === secondRun && firstRun.state === 'started';
const runtimeDisposal = await firstRun.dispose();
if (isFailure(runtimeDisposal)) throw new Error(runtimeDisposal.code);

const checks = [
  ['plugins boot in order and serve through needs', looked, 'value:a'],
  ['the app reports started', stateStarted, 'started'],
  ['stop runs in reverse order', events.join(','), 'store.start,consumer.start,consumer.stop,store.stop'],
  ['the app ends disposed', app.state, 'disposed'],
  ['a duplicate plugin is a coded error', duplicate.code, DotLifecycleErrorCode.DuplicatePlugin],
  ['the coded error carries a remediation', duplicate.remediation.length > 0, true],
  ['the coded error links its docs', duplicate.docsUrl.endsWith('#arki_dot_e011'), true],
  ['non-JSON manifest data is a coded error', manifestCode, DOT_MANIFEST_ERROR_CODE],
  ['./plugin re-exports the same plugin()', pluginFromSubpath === plugin, true],
  ['./feature loads', typeof defineFeature, 'function'],
  ['./log loads', typeof log, 'function'],
  ['./runtime starts one app for concurrent callers', runtimeSharesOneApp, true],
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
