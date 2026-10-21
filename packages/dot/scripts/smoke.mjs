// Cross-runtime smoke test. Runs the BUILT package (dist/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser and Hermes targets.
// Covers the portable entries only: `.`, `./unit`, `./feature`, `./log`, `./runtime`.

import { defineFailure, isFailure, UnexpectedDefect } from '@arki/failure';

import { defineFeature } from '../dist/feature.js';
import {
  defineApp,
  DOT_MANIFEST_ERROR_CODE,
  DotLifecycleError,
  DotLifecycleErrorCode,
  infra,
  toJsonObject,
} from '../dist/index.js';
import { log } from '../dist/log.js';
import { infra as unitFromSubpath } from '../dist/unit.js';
import { createAppRuntime } from '../dist/runtime.js';

const events = [];
const store = infra({
  name: 'store',
  provides: { store: () => ({ get: key => `value:${key}` }) },
  start: () => {
    events.push('store.start');
  },
  stop: () => {
    events.push('store.stop');
  },
});
const consumer = infra({
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

const app = await defineApp('smoke').infra(store).infra(consumer).start();
if (isFailure(app)) throw new Error(app.code);
const looked = app.services.lookup('a');
const stateStarted = app.state;
const disposal = await app.dispose();
if (isFailure(disposal)) throw new Error(disposal.code);

const duplicateResult = await defineApp('dup').infra(store).infra(store).boot();
const duplicate =
  UnexpectedDefect.is(duplicateResult) && duplicateResult.cause instanceof DotLifecycleError
    ? duplicateResult.cause
    : { code: 'none', remediation: '', docsUrl: '' };

const Refused = defineFailure('smoke.refused');
const refusal = Refused();
const refusedStart = await defineApp('refused')
  .infra(infra({ name: 'refuses', start: () => refusal }))
  .start();
const execution = defineFeature('execution')
  .usecases({
    run: () => () => {
      throw new Error('owned defect');
    },
  })
  .entrypoints();
const executionApp = await defineApp('execution-smoke').features([execution]).boot();
if (isFailure(executionApp)) throw new Error(executionApp.code);
const invocation = executionApp.services['execution.usecases'].run();
const executionDisposal = await executionApp.dispose();
if (isFailure(executionDisposal)) throw new Error(executionDisposal.code);

let manifestCode = 'none';
try {
  toJsonObject({ when: new Date() });
} catch (error) {
  manifestCode = error.code;
}

// One start for concurrent callers: both get the same started app.
const ticker = infra({ name: 'ticker', provides: { ticker: () => 'tick' } });
const appRuntime = createAppRuntime(defineApp('runtime-smoke').infra(ticker));
const [firstRun, secondRun] = await Promise.all([appRuntime.get(), appRuntime.get()]);
if (isFailure(firstRun) || isFailure(secondRun)) throw new Error('Runtime did not start');
const runtimeSharesOneApp = firstRun === secondRun && firstRun.state === 'started';
const runtimeDisposal = await firstRun.dispose();
if (isFailure(runtimeDisposal)) throw new Error(runtimeDisposal.code);

const checks = [
  ['units boot in order and serve through needs', looked, 'value:a'],
  ['the app reports started', stateStarted, 'started'],
  ['stop runs in reverse order', events.join(','), 'store.start,consumer.start,consumer.stop,store.stop'],
  ['the app ends disposed', app.state, 'disposed'],
  ['start preserves a returned failure', refusedStart === refusal, true],
  ['usecase invocation contains defects without tracing', UnexpectedDefect.is(invocation), true],
  ['a duplicate unit is a coded error', duplicate.code, DotLifecycleErrorCode.DuplicateUnit],
  ['the coded error carries a remediation', duplicate.remediation.length > 0, true],
  ['the coded error links its docs', duplicate.docsUrl.endsWith('#arki_dot_e011'), true],
  ['non-JSON manifest data is a coded error', manifestCode, DOT_MANIFEST_ERROR_CODE],
  ['./unit re-exports the same infra()', unitFromSubpath === unit, true],
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
