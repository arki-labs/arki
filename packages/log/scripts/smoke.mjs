// Cross-runtime smoke test. Runs the BUILT core (dist/core/) under Node, Bun and
// Deno via `bun run test:runtimes`, and is bundled for the browser and Hermes.
// It imports the core entry only; the unit tests cover the details.

import { configure, getLogger, json, memorySink, serializeFailure } from '../dist/core/index.js';

// Created before configure(): late binding must make it obey the config.
const log = getLogger('smoke').child('child');
log.warn('early {n}', { n: 0 }); // kept in the pre-configure ring, replayed on configure
log.info('dropped before configure');

const memory = memorySink();
configure({ channels: { memory }, default: { level: 'debug', channels: ['memory'] } });

log.trace('{level} from {who}', { level: 'trace', who: 'smoke' });
for (const level of ['debug', 'info', 'warn', 'error', 'fatal']) {
  log[level]('{level} from {who}', { level, who: 'smoke' });
}

const records = memory.records;
const info = records.find(record => record.levelName === 'info');
const line = JSON.parse(json()(records[1]));

// A failure as `@arki/failure` makes it: the brand and `cause` live on the prototype.
const failureProto = Object.defineProperty({}, '~failure', { value: true });
Object.defineProperty(failureProto, 'cause', { get: () => new Error('disk full') });
const failure = Object.assign(Object.create(failureProto), { code: 'db.down', message: 'db down', status: 503 });
const failureFields = serializeFailure(failure);

const checks = [
  ['record count (replayed warn + 5 levels)', records.length, 6],
  ['replayed record first', records[0]?.message(), 'early 0'],
  ['category', info?.category, 'smoke:child'],
  ['rendered message', info?.message(), 'info from smoke'],
  ['disabled level wrote nothing', records.filter(record => record.levelName === 'trace').length, 0],
  ['json line', `${line.levelName}:${line.message}`, 'debug:debug from smoke'],
  ['failure cause chain', `${failureFields.code}<-${failureFields.causes?.[0]?.message}`, 'db.down<-disk full'],
];

const runtime =
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

const summary = `${runtime}: ${checks.length - failed}/${checks.length} smoke checks passed`;
if (failed > 0) {
  console.error(summary);
  if (typeof globalThis.process !== 'undefined') globalThis.process.exit(1);
  throw new Error(summary);
}
console.log(summary);
