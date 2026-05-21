/**
 * Tests for the OTel-first observability wiring.
 *
 * Registers an InMemorySpanExporter + SimpleSpanProcessor globally,
 * drives a DOT app through its 5-hook lifecycle, and asserts that:
 *
 *   - Each public phase emits exactly one `dot.app.<phase>` root span
 *     (`configure`, `boot`, `start`, `stop`, `dispose`).
 *   - Each pip with a hook emits exactly one matching `dot.pip.<hook>`
 *     child span with stable attributes (`dot.app.name`, `dot.pip.name`,
 *     `dot.pip.version`, `dot.hook`, `dot.pip.order`).
 *   - On a failed boot, the failing pip's span is marked ERROR and an
 *     `exception` event is recorded; the parent phase span is also ERROR.
 *
 * Tests do NOT depend on histogram/metrics output — the in-memory metrics
 * SDK is a separate dependency. Span coverage is the load-bearing
 * assertion for this commit.
 */

import { context, trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from '@opentelemetry/sdk-trace-base';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { defineApp } from '../define-app.js';
import { defineDotPip } from '../pip-contract.js';

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

/** Find spans by name. Order is insertion order from the in-memory exporter. */
function spansByName(name: string): ReadableSpan[] {
  return exporter.getFinishedSpans().filter(s => s.name === name);
}

describe('@arki/dot OTel instrumentation', () => {
  it('emits a dot.app.configure root span and per-pip dot.pip.configure children', async () => {
    const envPip = defineDotPip({
      name: 'env',
      version: '0.1.0',
      configure(ctx) {
        ctx.registerService('env', 'env');
      },
    });
    const dbPip = defineDotPip({
      name: 'db',
      version: '0.1.0',
      configure(ctx) {
        ctx.registerService('db', 'db');
      },
    });

    await defineApp('otel-configure-test').use(envPip).use(dbPip).boot();

    const phaseSpans = spansByName('dot.app.configure');
    expect(phaseSpans).toHaveLength(1);
    expect(phaseSpans[0]?.attributes['dot.app.name']).toBe('otel-configure-test');
    expect(phaseSpans[0]?.attributes['dot.app.pip.count']).toBe(2);

    const pipSpans = spansByName('dot.pip.configure');
    expect(pipSpans).toHaveLength(2);
    const pipNames = pipSpans.map(s => s.attributes['dot.pip.name']).sort();
    expect(pipNames).toEqual(['db', 'env']);
    for (const span of pipSpans) {
      expect(span.attributes['dot.hook']).toBe('configure');
      expect(span.attributes['dot.app.name']).toBe('otel-configure-test');
    }
    // Note: parent-context linkage between phase and pip spans requires
    // a context manager (e.g. AsyncLocalStorageContextManager from
    // @opentelemetry/context-async-hooks). Real consumers register one
    // via the OTel SDK; this test asserts shape only, not linkage.
  });

  it('emits a dot.app.boot root span and per-pip dot.pip.boot children', async () => {
    const envPip = defineDotPip<{ env: { PORT: number } }>({
      name: 'env',
      version: '0.1.0',
      configure(ctx) {
        ctx.registerService('env', 'env');
      },
      boot() {
        return { services: { env: { PORT: 3000 } } };
      },
    });

    await defineApp('otel-boot-test').use(envPip).boot();

    const bootPhaseSpans = spansByName('dot.app.boot');
    expect(bootPhaseSpans).toHaveLength(1);
    expect(bootPhaseSpans[0]?.attributes['dot.app.name']).toBe('otel-boot-test');

    const bootPipSpans = spansByName('dot.pip.boot');
    expect(bootPipSpans).toHaveLength(1);
    const envSpan = bootPipSpans[0]!;
    expect(envSpan.attributes['dot.pip.name']).toBe('env');
    expect(envSpan.attributes['dot.hook']).toBe('boot');
    expect(envSpan.attributes['dot.pip.version']).toBe('0.1.0');
    // Note: parent-context linkage across async/await boundaries requires
    // AsyncLocalStorageContextManager from @opentelemetry/context-async-hooks.
    // Without it, child spans in async paths are root spans rather than
    // children of the phase span. Real consumers register a context
    // manager via the OTel SDK; we don't pull that dep into the test.
  });

  it('emits phase + per-pip spans for the full configure→boot→start→stop→dispose cascade', async () => {
    type Svc = { web: { listening: boolean } };
    const envPip = defineDotPip<{ env: { PORT: number } }>({
      name: 'env',
      version: '0.1.0',
      configure(ctx) {
        ctx.registerService('env', 'env');
      },
      boot() {
        return { services: { env: { PORT: 3000 } } };
      },
    });
    const webPip = defineDotPip<Svc>({
      name: 'web',
      version: '0.2.0',
      dependencies: ['env'],
      configure(ctx) {
        ctx.registerService('web', 'custom');
      },
      boot() {
        return { services: { web: { listening: false } } };
      },
      start(ctx) {
        (ctx.services as Svc).web.listening = true;
      },
      stop(ctx) {
        (ctx.services as Svc).web.listening = false;
      },
      dispose() {
        /* drain */
      },
    });

    const app = await defineApp('otel-full-lifecycle-test').use(envPip).use(webPip).start();
    await app.stop();
    await app.dispose();

    // One root phase span per public phase call.
    for (const phase of ['configure', 'boot', 'start', 'stop', 'dispose'] as const) {
      const phaseSpans = spansByName(`dot.app.${phase}`);
      expect(phaseSpans, `expected exactly one dot.app.${phase} span`).toHaveLength(1);
      expect(phaseSpans[0]?.attributes['dot.app.name']).toBe('otel-full-lifecycle-test');
      expect(phaseSpans[0]?.attributes['dot.app.phase']).toBe(phase);
      expect(phaseSpans[0]?.status.code).toBe(1); // OK
    }

    // Per-pip hook spans: configure × 2, boot × 2, start × 1, stop × 1, dispose × 1.
    // (only `web` declared start/stop/dispose; env has none of those hooks.)
    expect(spansByName('dot.pip.configure')).toHaveLength(2);
    expect(spansByName('dot.pip.boot')).toHaveLength(2);
    expect(spansByName('dot.pip.start')).toHaveLength(1);
    expect(spansByName('dot.pip.stop')).toHaveLength(1);
    expect(spansByName('dot.pip.dispose')).toHaveLength(1);

    const webStart = spansByName('dot.pip.start')[0]!;
    expect(webStart.attributes['dot.pip.name']).toBe('web');
    expect(webStart.attributes['dot.pip.version']).toBe('0.2.0');
    expect(webStart.attributes['dot.hook']).toBe('start');
    expect(webStart.attributes['dot.pip.order']).toBe(1);
    expect(webStart.status.code).toBe(1); // OK
  });

  it('marks the failing pip span ERROR when boot throws', async () => {
    const goodPip = defineDotPip({
      name: 'good',
      version: '0.1.0',
      boot() {
        return { services: {} };
      },
    });
    const badPip = defineDotPip({
      name: 'bad',
      version: '0.1.0',
      boot() {
        throw new Error('intentional boot failure');
      },
    });

    await expect(
      defineApp('otel-boot-fail-test').use(goodPip).use(badPip).boot(),
    ).rejects.toThrow();

    const bootPipSpans = spansByName('dot.pip.boot');
    expect(bootPipSpans).toHaveLength(2);
    const goodSpan = bootPipSpans.find(s => s.attributes['dot.pip.name'] === 'good');
    const badSpan = bootPipSpans.find(s => s.attributes['dot.pip.name'] === 'bad');
    // OK / unset = 0, ERROR = 2 per OTel SpanStatusCode.
    expect(goodSpan?.status.code).toBe(1); // OK
    expect(badSpan?.status.code).toBe(2);  // ERROR
    expect(badSpan?.events.some(e => e.name === 'exception')).toBe(true);

    const bootPhaseSpans = spansByName('dot.app.boot');
    expect(bootPhaseSpans).toHaveLength(1);
    expect(bootPhaseSpans[0]?.status.code).toBe(2); // ERROR
  });
});

/** Touch `context` so the import isn't elided in case future tests need it. */
void context;
