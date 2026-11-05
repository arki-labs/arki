// Cross-runtime smoke test. Runs the BUILT entries under Node, Bun and Deno via
// `bun run test:runtimes`. No Docker, Postgres or Ollama: the checks use the pure helpers,
// a real local HTTP fixture server, and the code-based AI scorers (no judge model).
// The entries that need a test runner or a browser (./vitest-setup, ./ai/vitest,
// ./ai/playwright, ./e2e, ./containers, ./services/*) are imported to prove they load.

import { metrics, trace } from '@opentelemetry/api';
import { z } from 'zod';

import { containsFacts, cosine, scoreMatch, shape, UnscorableError } from '../dist/ai/index.js';
import { isDebugEnabled } from '../dist/debug.js';
import {
  assertArrayLength,
  assertContainsId,
  assertErrorThrown,
  assertPaginationValid,
  assertPerformance,
  assertTimestamps,
  assertUpdatedAfterCreated,
  createFactory,
  createMany,
  createSequence,
  timeOperation,
} from '../dist/index.js';
import { http, HttpResponse } from '../dist/msw.js';
import { captureSpans } from '../dist/otel.js';
import { httpFixtures } from '../dist/services/http-fixtures.js';
import { newRunId } from '../dist/stack/contract.js';
import { service } from '../dist/stack/index.js';

import '../dist/vitest-setup.js';
import '../dist/ai/vitest.js';
import '../dist/ai/playwright.js';
import '../dist/e2e/index.js';
import '../dist/containers.js';
import '../dist/services/mailpit.js';
import '../dist/services/ollama.js';
import '../dist/services/postgres.js';
import '../dist/services/redis.js';
import '../dist/integration-tester.js';
import '../dist/tester-builder.js';

const refusal = async fn => {
  try {
    await fn();
    return 'no error';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
};

const userFactory = createFactory(() => ({ id: 'usr_1', name: 'Ada', age: 30 }), { age: 40 });
const users = createMany(userFactory, 2, index => ({ id: `usr_${index + 2}` }));
const sequence = createSequence(userFactory, 'name', ['A', 'B']);

const paginationRefusal = await refusal(() => assertPaginationValid({ items: [1, 2] }, { itemsCount: 3 }));
const missingId = await refusal(() => assertContainsId([{ id: 'a' }], 'b'));
const timestampRefusal = await refusal(() =>
  assertUpdatedAfterCreated({ createdAt: new Date('2026-01-02'), updatedAt: new Date('2026-01-01') }),
);
const slow = await refusal(() =>
  assertPerformance('slow op', () => new Promise(resolve => setTimeout(resolve, 60)), 5),
);
const fast = await assertPerformance('fast op', async () => 'done', 1000);
const thrown = await assertErrorThrown(async () => {
  throw new Error('boom here');
}, /boom/);
const timer = timeOperation('noop');
timer.end();

const stringShape = shape(z.object({ n: z.number() }));
const goodShape = await stringShape.score({ output: { n: 1 }, input: null, expected: null }, {});
const badShape = await stringShape.score({ output: { n: 'x' }, input: null, expected: null }, {});
const facts = containsFacts(['Paris', 'France']);
const factsScore = await facts.score({ output: 'Paris is in France.', input: null, expected: null }, {});
const unscorable = await scoreMatch('x', containsFacts([]), {}).then(
  () => 'no error',
  error => (error instanceof UnscorableError ? 'unscorable' : 'wrong error'),
);

const handler = http.get('http://smoke.local/x', () => HttpResponse.json({ ok: true }));
const mswBody = await HttpResponse.json({ ok: true }).json();

const fixture = httpFixtures({ handle: request => new Response(`hello ${new URL(request.url).pathname}`) });
const started = await fixture.start({ runId: newRunId() });
const fetched = await fetch(`${started.value.url}/world`).then(response => response.text());
await started.stop();
await started.stop();

// Real OpenTelemetry API calls: the parent must survive an await on every engine.
const spans = captureSpans();
const tracer = trace.getTracer('smoke');
await tracer.startActiveSpan('smoke.outer', async outer => {
  await Promise.resolve();
  tracer.startSpan('smoke.inner').end();
  outer.end();
});
metrics.getMeter('smoke').createCounter('smoke.operations').add(3);
const otelParent = spans.named('smoke.inner').parent?.name;
const otelCounter = (await spans.collectMetrics()).find(metric => metric.descriptor.name === 'smoke.operations');
const otelMissing = await refusal(() => spans.named('smoke.absent'));
spans[Symbol.dispose]();
const otelAfterDispose = trace.getTracer('smoke').startSpan('smoke.after').isRecording();

const checks = [
  ['factory applies defaults', userFactory(undefined).age, 40],
  ['factory overrides win', userFactory({ age: 1 }).age, 1],
  ['createMany applies per-index overrides', users.map(user => user.id).join(','), 'usr_2,usr_3'],
  ['createSequence sets the field per item', sequence.map(user => user.name).join(','), 'A,B'],
  ['array length helper passes on match', (assertArrayLength([1], 1), true), true],
  ['pagination helper names the length mismatch', paginationRefusal, 'Expected items array to have length 3, got 2'],
  ['assertContainsId fails for a missing id', missingId.includes('b'), true],
  ['timestamps helper accepts dates', (assertTimestamps({ createdAt: new Date(), updatedAt: new Date() }), true), true],
  ['updatedAt before createdAt is refused', timestampRefusal.startsWith('Expected updatedAt'), true],
  ['assertPerformance returns the result in time', fast, 'done'],
  ['assertPerformance fails a slow operation', slow.startsWith('Performance assertion failed: slow op'), true],
  ['assertErrorThrown returns the error', thrown.message, 'boom here'],
  ['debug flag is readable', typeof isDebugEnabled(), 'boolean'],
  ['shape scorer passes a match', goodShape.status === 'scored' && goodShape.pass, true],
  ['shape scorer fails a mismatch', badShape.status === 'scored' && badShape.pass, false],
  ['containsFacts scores full coverage', factsScore.status === 'scored' && factsScore.value, 1],
  ['scoreMatch refuses a scorer with no facts', unscorable, 'unscorable'],
  ['cosine of equal vectors', Math.round(cosine([1, 2], [1, 2]) * 1000), 1000],
  [
    'cosine refuses different lengths',
    await refusal(() => cosine([1], [1, 2])),
    'COSINE_LENGTH_MISMATCH: 1 against 2.',
  ],
  ['msw handler is built and its response parses', `${typeof handler.info}:${mswBody.ok}`, 'object:true'],
  [
    'stack service helper returns the spec',
    service({ name: 's', scope: 'run', start: async () => ({ value: 1, stop: async () => {} }) }).name,
    's',
  ],
  ['http fixture serves a real request', fetched, 'hello /world'],
  ['captureSpans links a span to its parent across await', otelParent, 'smoke.outer'],
  ['captureSpans collects a counter', otelCounter?.dataPoints[0]?.value, 3],
  ['captureSpans names a missing span', otelMissing.includes('found 0'), true],
  ['captureSpans dispose leaves no recording provider', otelAfterDispose, false],
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
