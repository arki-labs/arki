/**
 * Tests for the OTel-first observability wiring.
 *
 * Registers an InMemorySpanExporter + SimpleSpanProcessor globally,
 * drives a DOT app through its 5-hook lifecycle, and asserts that:
 *
 *   - Each public phase emits exactly one `dot.app.<phase>` root span
 *     (`configure`, `boot`, `start`, `stop`, `dispose`).
 *   - Each plugin with a hook emits exactly one matching `dot.plugin.<hook>`
 *     child span with stable attributes (`dot.app.name`, `dot.plugin.name`,
 *     `dot.plugin.version`, `dot.hook`, `dot.plugin.order`).
 *   - On a failed boot, the failing plugin's span is marked ERROR and an
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

import { configure, getLogger, memorySink } from '@arki/log';
import { otelTrace } from '@arki/log/otel';
import { fakeLog } from '@arki/log/testing';

import { defineApp } from '../define-app.js';
import { plugin, service } from '../plugin-contract.js';

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
  it('emits a dot.app.configure root span and per-plugin dot.plugin.configure children', async () => {
    const envPlugin = plugin({
      name: 'env',
      version: '0.1.0',
      configure(ctx) {
        ctx.registerService('env', 'env');
      },
    });
    const dbPlugin = plugin({
      name: 'db',
      version: '0.1.0',
      configure(ctx) {
        ctx.registerService('db', 'db');
      },
    });

    await defineApp('otel-configure-test').use(envPlugin).use(dbPlugin).boot();

    const phaseSpans = spansByName('dot.app.configure');
    expect(phaseSpans).toHaveLength(1);
    expect(phaseSpans[0]?.attributes['dot.app.name']).toBe('otel-configure-test');
    expect(phaseSpans[0]?.attributes['dot.app.plugin.count']).toBe(2);

    const pluginSpans = spansByName('dot.plugin.configure');
    expect(pluginSpans).toHaveLength(2);
    const pluginNames = pluginSpans.map(s => s.attributes['dot.plugin.name']).sort();
    expect(pluginNames).toEqual(['db', 'env']);
    for (const span of pluginSpans) {
      expect(span.attributes['dot.hook']).toBe('configure');
      expect(span.attributes['dot.app.name']).toBe('otel-configure-test');
    }
    // Note: parent-context linkage between phase and plugin spans requires
    // a context manager (e.g. AsyncLocalStorageContextManager from
    // @opentelemetry/context-async-hooks). Real consumers register one
    // via the OTel SDK; this test asserts shape only, not linkage.
  });

  it('emits a dot.app.boot root span and per-plugin dot.plugin.boot children', async () => {
    const envPlugin = plugin({
      name: 'env',
      version: '0.1.0',
      configure(ctx) {
        ctx.registerService('env', 'env');
      },
      boot() {
        return { env: { PORT: 3000 } };
      },
    });

    await defineApp('otel-boot-test').use(envPlugin).boot();

    const bootPhaseSpans = spansByName('dot.app.boot');
    expect(bootPhaseSpans).toHaveLength(1);
    expect(bootPhaseSpans[0]?.attributes['dot.app.name']).toBe('otel-boot-test');

    const bootPluginSpans = spansByName('dot.plugin.boot');
    expect(bootPluginSpans).toHaveLength(1);
    const envSpan = bootPluginSpans[0]!;
    expect(envSpan.attributes['dot.plugin.name']).toBe('env');
    expect(envSpan.attributes['dot.hook']).toBe('boot');
    expect(envSpan.attributes['dot.plugin.version']).toBe('0.1.0');
    // Note: parent-context linkage across async/await boundaries requires
    // AsyncLocalStorageContextManager from @opentelemetry/context-async-hooks.
    // Without it, child spans in async paths are root spans rather than
    // children of the phase span. Real consumers register a context
    // manager via the OTel SDK; we don't pull that dep into the test.
  });

  it('emits phase + per-plugin spans for the full configure→boot→start→stop→dispose cascade', async () => {
    type Svc = { web: { listening: boolean } };
    const envPlugin = plugin({
      name: 'env',
      version: '0.1.0',
      configure(ctx) {
        ctx.registerService('env', 'env');
      },
      boot() {
        return { env: { PORT: 3000 } };
      },
    });
    const webPlugin = plugin({
      name: 'web',
      version: '0.2.0',
      needs: { env: service<{ PORT: number }>() },
      configure(ctx) {
        ctx.registerService('web', 'custom');
      },
      boot(): Svc {
        return { web: { listening: false } };
      },
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

    const app = await defineApp('otel-full-lifecycle-test').use(envPlugin).use(webPlugin).start();
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

    // Per-plugin hook spans: configure × 2, boot × 2, start × 1, stop × 1, dispose × 1.
    // (only `web` declared start/stop/dispose; env has none of those hooks.)
    expect(spansByName('dot.plugin.configure')).toHaveLength(2);
    expect(spansByName('dot.plugin.boot')).toHaveLength(2);
    expect(spansByName('dot.plugin.start')).toHaveLength(1);
    expect(spansByName('dot.plugin.stop')).toHaveLength(1);
    expect(spansByName('dot.plugin.dispose')).toHaveLength(1);

    const webStart = spansByName('dot.plugin.start')[0]!;
    expect(webStart.attributes['dot.plugin.name']).toBe('web');
    expect(webStart.attributes['dot.plugin.version']).toBe('0.2.0');
    expect(webStart.attributes['dot.hook']).toBe('start');
    expect(webStart.attributes['dot.plugin.order']).toBe(1);
    expect(webStart.status.code).toBe(1); // OK
  });

  it('stamps the phase span and each plugin hook span on the kernel lifecycle records', async () => {
    using log = fakeLog();
    const app = await defineApp('trace-thread-test')
      .use(plugin({ name: 'p', boot: () => ({}) }))
      .boot();
    await app.dispose();

    const phase = spansByName('dot.app.boot')[0]?.spanContext();
    const hook = spansByName('dot.plugin.boot')[0]?.spanContext();
    const complete = log.records.find(record => record.template === 'boot: complete');
    const done = log.records.find(record => record.template === 'boot: done');
    expect(phase?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(complete).toMatchObject({ traceId: phase?.traceId, spanId: phase?.spanId });
    // Records written after a plugin's hook keep that hook's span, so they group with it.
    expect(done).toMatchObject({ traceId: hook?.traceId, spanId: hook?.spanId });
  });

  it('a hook inside an active span logs with its traceId when logging reads the trace from OTel', () => {
    context.setGlobalContextManager(syncContextManager());
    const sink = memorySink();
    try {
      defineApp('active-span-test')
        .use(
          plugin({
            name: 'logging',
            logging: () =>
              configure({ channels: { mem: sink }, default: { level: 'info', channels: ['mem'] }, trace: otelTrace() }),
          }),
        )
        .use(
          plugin({
            name: 'web',
            configure: () => {
              getLogger('test:web').info('registering routes');
            },
          }),
        )
        .configure();
    } finally {
      context.disable();
    }

    const phase = spansByName('dot.app.configure')[0]?.spanContext();
    const record = sink.records.find(entry => entry.template === 'registering routes');
    expect(phase?.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(record?.traceId).toBe(phase?.traceId);
  });

  it('marks the failing plugin span ERROR when boot throws', async () => {
    const goodPlugin = plugin({
      name: 'good',
      version: '0.1.0',
      boot() {
        return {};
      },
    });
    const badPlugin = plugin({
      name: 'bad',
      version: '0.1.0',
      boot() {
        throw new Error('intentional boot failure');
      },
    });

    await expect(defineApp('otel-boot-fail-test').use(goodPlugin).use(badPlugin).boot()).rejects.toThrow();

    const bootPluginSpans = spansByName('dot.plugin.boot');
    expect(bootPluginSpans).toHaveLength(2);
    const goodSpan = bootPluginSpans.find(s => s.attributes['dot.plugin.name'] === 'good');
    const badSpan = bootPluginSpans.find(s => s.attributes['dot.plugin.name'] === 'bad');
    // OK / unset = 0, ERROR = 2 per OTel SpanStatusCode.
    expect(goodSpan?.status.code).toBe(1); // OK
    expect(badSpan?.status.code).toBe(2); // ERROR
    expect(badSpan?.events.some(e => e.name === 'exception')).toBe(true);

    const bootPhaseSpans = spansByName('dot.app.boot');
    expect(bootPhaseSpans).toHaveLength(1);
    expect(bootPhaseSpans[0]?.status.code).toBe(2); // ERROR
  });
});
