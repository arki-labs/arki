/**
 * Tests for the OTel-first observability wiring.
 *
 * Registers an InMemorySpanExporter + SimpleSpanProcessor globally,
 * drives a DOT app through its 5-hook lifecycle, and asserts that:
 *
 *   - Each public phase emits exactly one `dot.app.<phase>` root span
 *     (`configure`, `boot`, `start`, `stop`, `dispose`).
 *   - Each unit with a hook emits exactly one matching `dot.unit.<hook>`
 *     child span with stable attributes (`dot.app.name`, `dot.unit.name`,
 *     `dot.hook`, `dot.unit.order`).
 *   - On a failed boot, the failing unit's span is marked ERROR and an
 *     `exception` event is recorded; the parent phase span is also ERROR.
 *
 * Tests do NOT depend on histogram/metrics output — the in-memory metrics
 * SDK is a separate dependency. Span coverage is the load-bearing
 * assertion for this commit.
 */

import type { Context, ContextManager } from '@opentelemetry/api';
import type { ReadableSpan } from '@opentelemetry/sdk-trace-base';
import { context, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import packageMetadata from '@arki/dot/package.json' with { type: 'json' };
import { defineFailure, orThrow, UnexpectedDefect } from '@arki/failure';
import { configure, getLogger, memorySink } from '@arki/log';
import { otelTrace } from '@arki/log/otel';
import { fakeLog } from '@arki/log/testing';

import { defineApp } from '../define-app.js';
import { infra, service } from '../unit-contract.js';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
});

afterEach(() => {
  exporter.reset();
});

afterAll(async () => {
  await provider.shutdown();
  trace.disable();
});

/** A synchronous context manager: makes a span active inside `context.with` (enough for `configure`). */
function syncContextManager(): ContextManager {
  let current: Context = ROOT_CONTEXT;
  const manager: ContextManager = {
    active: () => current,
    with: (next, fn, thisArg, ...args) => {
      const previous = current;
      current = next;
      try {
        return fn.apply(thisArg, args);
      } finally {
        current = previous;
      }
    },
    bind: (_context, target) => target,
    enable: () => manager,
    disable: () => manager,
  };
  return manager;
}

/** Find spans by name. Order is insertion order from the in-memory exporter. */
function spansByName(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter(s => s.name === name);
}

describe('@arki/dot OTel instrumentation', () => {
  it('emits a dot.app.configure root span and per-unit dot.unit.configure children', async () => {
    const envUnit = infra({
      name: 'env',
      configure(ctx) {
        ctx.registerService('env', 'env');
      },
    });
    const dbUnit = infra({
      name: 'db',
      configure(ctx) {
        ctx.registerService('db', 'db');
      },
    });

    orThrow(await defineApp('otel-configure-test').infra(envUnit).infra(dbUnit).boot());

    const phaseSpans = spansByName('dot.app.configure');
    expect(phaseSpans).toHaveLength(1);
    expect(phaseSpans[0]?.instrumentationScope.version).toBe(packageMetadata.version);
    expect(phaseSpans[0]?.attributes['dot.app.name']).toBe('otel-configure-test');
    expect(phaseSpans[0]?.attributes['dot.app.unit.count']).toBe(2);

    const unitSpans = spansByName('dot.unit.configure');
    expect(unitSpans).toHaveLength(2);
    const unitNames = unitSpans.map(s => s.attributes['dot.unit.name']).sort();
    expect(unitNames).toEqual(['db', 'env']);
    for (const span of unitSpans) {
      expect(span.attributes['dot.hook']).toBe('configure');
      expect(span.attributes['dot.app.name']).toBe('otel-configure-test');
    }
    // Note: parent-context linkage between phase and unit spans requires
    // a context manager (e.g. AsyncLocalStorageContextManager from
    // @opentelemetry/context-async-hooks). Real consumers register one
    // via the OTel SDK; this test asserts shape only, not linkage.
  });

  it('emits a dot.app.boot root span and per-unit dot.unit.boot children', async () => {
    const envUnit = infra({
      name: 'env',
      configure(ctx) {
        ctx.registerService('env', 'env');
      },
      provides: {
        env: () => ({ PORT: 3000 }),
      },
    });

    orThrow(await defineApp('otel-boot-test').infra(envUnit).boot());

    const bootPhaseSpans = spansByName('dot.app.boot');
    expect(bootPhaseSpans).toHaveLength(1);
    expect(bootPhaseSpans[0]?.attributes['dot.app.name']).toBe('otel-boot-test');

    const bootUnitSpans = spansByName('dot.unit.boot');
    expect(bootUnitSpans).toHaveLength(1);
    const envSpan = bootUnitSpans[0]!;
    expect(envSpan.attributes['dot.unit.name']).toBe('env');
    expect(envSpan.attributes['dot.hook']).toBe('boot');
    // Note: parent-context linkage across async/await boundaries requires
    // AsyncLocalStorageContextManager from @opentelemetry/context-async-hooks.
    // Without it, child spans in async paths are root spans rather than
    // children of the phase span. Real consumers register a context
    // manager via the OTel SDK; we don't pull that dep into the test.
  });

  it('emits phase + per-unit spans for the full configure→boot→start→stop→dispose cascade', async () => {
    type Svc = { web: { listening: boolean } };
    const envUnit = infra({
      name: 'env',
      configure(ctx) {
        ctx.registerService('env', 'env');
      },
      provides: {
        env: () => ({ PORT: 3000 }),
      },
    });
    const webUnit = infra({
      name: 'web',
      needs: { env: service<{ PORT: number }>() },
      configure(ctx) {
        ctx.registerService('web', 'custom');
      },
      provides: { web: (): Svc['web'] => ({ listening: false }) },
      start({ web }) {
        web.listening = true;
      },
      stop({ web }) {
        web.listening = false;
      },
      dispose() {
        /* drain */
      },
    });

    const app = orThrow(await defineApp('otel-full-lifecycle-test').infra(envUnit).infra(webUnit).start());
    expect(await app.stop()).toBeUndefined();
    orThrow(await app.dispose());

    // One root phase span per public phase call.
    for (const phase of ['configure', 'boot', 'start', 'stop', 'dispose'] as const) {
      const phaseSpans = spansByName(`dot.app.${phase}`);
      expect(phaseSpans, `expected exactly one dot.app.${phase} span`).toHaveLength(1);
      expect(phaseSpans[0]?.attributes['dot.app.name']).toBe('otel-full-lifecycle-test');
      expect(phaseSpans[0]?.attributes['dot.app.phase']).toBe(phase);
      expect(phaseSpans[0]?.status.code).toBe(1); // OK
    }

    // Per-unit hook spans: configure × 2, boot × 2, start × 1, stop × 1, dispose × 1.
    // (only `web` declared start/stop/dispose; env has none of those hooks.)
    expect(spansByName('dot.unit.configure')).toHaveLength(2);
    expect(spansByName('dot.unit.boot')).toHaveLength(2);
    expect(spansByName('dot.unit.start')).toHaveLength(1);
    expect(spansByName('dot.unit.stop')).toHaveLength(1);
    expect(spansByName('dot.unit.dispose')).toHaveLength(1);

    const webStart = spansByName('dot.unit.start')[0]!;
    expect(webStart.attributes['dot.unit.name']).toBe('web');
    expect(webStart.attributes['dot.hook']).toBe('start');
    expect(webStart.attributes['dot.unit.order']).toBe(1);
    expect(webStart.status.code).toBe(1); // OK
  });

  it('stamps the phase span and each unit hook span on the kernel lifecycle records', async () => {
    using log = fakeLog();
    const app = orThrow(
      await defineApp('trace-thread-test')
        .infra(
          infra({
            name: 'p',
            boot: () => {
              /* side effects only */
            },
          }),
        )
        .boot(),
    );
    orThrow(await app.dispose());

    const phase = spansByName('dot.app.boot')[0]?.spanContext();
    const hook = spansByName('dot.unit.boot')[0]?.spanContext();
    const complete = log.records.find(record => record.template === 'boot: complete');
    const done = log.records.find(record => record.template === 'boot: done');
    expect(phase?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(complete).toMatchObject({ traceId: phase?.traceId, spanId: phase?.spanId });
    // Records written after a unit's hook keep that hook's span, so they group with it.
    expect(done).toMatchObject({ traceId: hook?.traceId, spanId: hook?.spanId });
  });

  it('a boot hook inside an active span logs with its traceId after logging activates', async () => {
    context.setGlobalContextManager(syncContextManager());
    const sink = memorySink();
    try {
      const app = orThrow(
        await defineApp('active-span-test')
          .infra(
            infra({
              name: 'logging',
              logging: () => {
                const handle = configure({
                  channels: { mem: sink },
                  default: { level: 'info', channels: ['mem'] },
                  trace: otelTrace(),
                });
                return {
                  async close() {
                    await handle.close();
                  },
                };
              },
            }),
          )
          .infra(
            infra({
              name: 'web',
              boot: () => {
                getLogger('test:web').info('registering routes');
              },
            }),
          )
          .boot(),
      );
      orThrow(await app.dispose());
    } finally {
      context.disable();
    }

    const hook = spansByName('dot.unit.boot')
      .find(span => span.attributes['dot.unit.name'] === 'web')
      ?.spanContext();
    const record = sink.records.find(entry => entry.template === 'registering routes');
    expect(hook?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(sink.records.map(entry => entry.template)).toContain('registering routes');
    expect(record?.traceId).toBe(hook?.traceId);
  });

  it('reports a returned refusal without inventing an exception event', async () => {
    const Refused = defineFailure('otel_test.refused');
    const refusal = Refused();
    const result = await defineApp('otel-refusal')
      .infra(infra({ name: 'refused', boot: () => refusal }))
      .boot();
    expect(result).toBe(refusal);
    for (const name of ['dot.unit.boot', 'dot.app.boot']) {
      const span = spansByName(name)[0];
      expect(span?.status.code).toBe(2);
      expect(span?.attributes['failure.code']).toBe(Refused.code);
      expect(span?.events.some(event => event.name === 'exception')).toBe(false);
    }
  });

  it('marks the failing unit span ERROR when boot throws', async () => {
    const goodUnit = infra({
      name: 'good',
      boot() {
        /* side effects only */
      },
    });
    const badUnit = infra({
      name: 'bad',
      boot() {
        throw new Error('intentional boot failure');
      },
    });

    expect(await defineApp('otel-boot-fail-test').infra(goodUnit).infra(badUnit).boot()).toMatchObject({
      code: UnexpectedDefect.code,
      cause: new Error('intentional boot failure'),
    });

    const bootUnitSpans = spansByName('dot.unit.boot');
    expect(bootUnitSpans).toHaveLength(2);
    const goodSpan = bootUnitSpans.find(s => s.attributes['dot.unit.name'] === 'good');
    const badSpan = bootUnitSpans.find(s => s.attributes['dot.unit.name'] === 'bad');
    // OK / unset = 0, ERROR = 2 per OTel SpanStatusCode.
    expect(goodSpan?.status.code).toBe(1); // OK
    expect(badSpan?.status.code).toBe(2); // ERROR
    expect(badSpan?.events.some(e => e.name === 'exception')).toBe(true);

    const bootPhaseSpans = spansByName('dot.app.boot');
    expect(bootPhaseSpans).toHaveLength(1);
    expect(bootPhaseSpans[0]?.status.code).toBe(2); // ERROR
  });
});
