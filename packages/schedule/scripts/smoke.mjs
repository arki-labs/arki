// Cross-runtime smoke test. Runs the BUILT entries under Node, Bun and Deno via
// `bun run test:runtimes`. Entries: root (definitions and parsing), ./runtime (a host-clocked
// runtime that runs handlers on trigger), ./projection, ./orpc (cron contract helpers),
// ./dot (the scheduler plugin booted in a Dot app).

import { z } from 'zod';

import { defineApp } from '@arki/dot';
import { isFailure } from '@arki/failure';

import { schedule, SCHEDULE_ACTION_META_SCHEMA } from '../dist/dot.js';
import {
  defineSchedule,
  lockDurationMs,
  parseEveryInterval,
  SCHEDULE_ERROR_CODES,
  ScheduleError,
} from '../dist/index.js';
import { defineCronContract, fail, ok, skipped } from '../dist/orpc.js';
import { project } from '../dist/projection.js';
import { createScheduleRuntime } from '../dist/runtime.js';

const refused = fn => {
  try {
    fn();
    return 'no error';
  } catch (error) {
    return error instanceof ScheduleError ? error.code : 'wrong error';
  }
};

let runs = 0;
const nightly = defineSchedule({ name: 'nightly', cron: '0 3 * * *', handler: () => ({ runs: ++runs }) });
const every = defineSchedule({ name: 'ticker', every: '30s', handler: () => 'tick' });
const boom = defineSchedule({
  name: 'boom',
  every: '1m',
  handler: () => {
    throw new Error('handler defect');
  },
});

const runtime = createScheduleRuntime({ schedules: [nightly, every, boom], clock: 'host' });
const ran = await runtime.trigger('nightly');
const defective = await runtime.trigger('boom');
const unknown = await runtime.trigger('missing').then(
  () => 'no error',
  error => (error instanceof ScheduleError ? error.code : 'wrong error'),
);
await runtime.stop();
const afterStop = await runtime.trigger('nightly');

const duplicate = refused(() => createScheduleRuntime({ schedules: [nightly, nightly], clock: 'host' }));

const projected = project({
  actions: [
    {
      id: 'nightly.fire',
      binding: 'schedule',
      plugin: 'schedule',
      metaSchema: SCHEDULE_ACTION_META_SCHEMA,
      address: 'POST /cron/nightly',
      meta: { kind: 'cron', overlap: 'skip', locked: false, durable: false },
    },
    { id: 'other', binding: 'http', plugin: 'http', metaSchema: 'x' },
  ],
});

const contract = defineCronContract({ nightly: z.object({ done: z.boolean() }) });

const app = await defineApp('schedule-smoke')
  .entrypoints(schedule({ schedules: [every], clock: 'host' }))
  .boot();
const fromDot = isFailure(app) ? app.code : await app.services.scheduler.trigger('ticker');
const unknownFromDot = isFailure(app) ? app.code : await app.services.scheduler.trigger('nope');
if (!isFailure(app)) await app.dispose();

const checks = [
  ['every interval parses to milliseconds', parseEveryInterval('5m'), 300_000],
  ['lock duration parses a string', lockDurationMs('2s'), 2000],
  [
    'bad interval is refused with the invalid-definition code',
    refused(() => parseEveryInterval('0s')),
    SCHEDULE_ERROR_CODES.invalidDefinition,
  ],
  [
    'bad cron is refused',
    refused(() => defineSchedule({ name: 'bad', cron: 'not a cron', handler: () => 1 })),
    SCHEDULE_ERROR_CODES.invalidDefinition,
  ],
  [
    'cron and every together are refused',
    refused(() => defineSchedule({ name: 'both', cron: '* * * * *', every: '1s', handler: () => 1 })),
    SCHEDULE_ERROR_CODES.invalidDefinition,
  ],
  ['trigger runs the handler', `${ran.status}:${ran.value?.runs}`, 'ran:1'],
  ['a throwing handler is reported, not thrown', defective.status, 'handler-failed'],
  [
    'triggering an unregistered name throws the invalid-definition error',
    unknown,
    SCHEDULE_ERROR_CODES.invalidDefinition,
  ],
  ['stopped runtime refuses triggers', afterStop.status, 'unavailable'],
  ['handler failure counter', runtime.handlerFailures, 1],
  ['duplicate names are refused', duplicate, SCHEDULE_ERROR_CODES.duplicateSchedule],
  [
    'projection keeps only schedule actions',
    projected.schedules.map(entry => `${entry.name}:${entry.kind}`).join(','),
    'nightly:cron',
  ],
  ['cron contract has one procedure per name', Object.keys(contract).join(','), 'nightly'],
  ['reply helpers', `${ok(1).ok}|${skipped().ok}|${fail(500, 'x').status}`, 'true|skipped|500'],
  ['dot scheduler runs a handler on trigger', fromDot.status, 'ran'],
  ['dot scheduler reports an unknown name', unknownFromDot.status, 'unknown'],
];

const engine =
  typeof HermesInternal !== 'undefined'
    ? 'hermes'
    : typeof Deno !== 'undefined'
      ? `deno ${Deno.version.deno}`
      : typeof Bun !== 'undefined'
        ? `bun ${Bun.version}`
        : typeof navigator !== 'undefined' && navigator.userAgent && !navigator.userAgent.includes('Node')
          ? `browser ${navigator.userAgent}`
          : `node ${globalThis.process?.version ?? ''}`;

let failed = 0;
for (const [name, actual, expected] of checks) {
  if (actual !== expected) {
    failed++;
    console.error(`FAIL ${name}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

const summary = `${engine}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
// Timers of the query client and the queue keep some engines alive after the checks end.
if (typeof globalThis.process !== 'undefined') globalThis.process.exit(0);
