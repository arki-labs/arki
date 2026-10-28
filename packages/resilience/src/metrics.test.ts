import { context, metrics, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import { AggregationTemporality, DataPointType, InMemoryMetricExporter, MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { afterEach, expect, it, vi } from 'vitest';
import { MockClock } from '@arki/clock';
import { defineFailure, UnexpectedDefect } from '@arki/failure';
import { backoff, CircuitOpen, createCircuitBreakerPolicy, createRetryPolicy, noop, withFallback, wrap } from './index.js';

let releasePending = () => { /* No pending reporter until a test installs one. */ };
let provider: MeterProvider | undefined;
let tracerProvider: BasicTracerProvider | undefined;
function installMetrics() {
  const reader = new PeriodicExportingMetricReader({
    exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE), exportIntervalMillis: 60_000,
  });
  provider = new MeterProvider({ readers: [reader] });
  metrics.setGlobalMeterProvider(provider);
  return {
    meter: provider.getMeter('@arki/resilience'),
    async collect() {
      const result = await reader.collect();
      expect(result.errors).toEqual([]);
      return result.resourceMetrics.scopeMetrics.flatMap(scope => scope.metrics);
    },
  };
}
afterEach(async () => {
  releasePending(); await Promise.resolve();
  vi.restoreAllMocks(); vi.useRealTimers(); metrics.disable(); trace.disable(); context.disable();
  await provider?.shutdown(); await tracerProvider?.shutdown();
  provider = undefined; tracerProvider = undefined;
});

it('records one logical completion, exact attempts and bounded labels in composition', async () => {
  const telemetry = installMetrics();
  const clock = new MockClock();
  const retry = createRetryPolicy({ backoff: backoff.constant(10).upTo(1), clock });
  const breaker = createCircuitBreakerPolicy();
  const policy = withFallback(wrap(retry, breaker), () => 'recovered');
  const result = policy.execute(() => { throw new Error('private payload'); });
  await clock.advanceAsync(10);
  expect(await result).toBe('recovered');
  const collected = await telemetry.collect();
  const operations = collected.find(metric => metric.descriptor.name === 'resilience.operations');
  expect(operations?.dataPointType).toBe(DataPointType.SUM);
  expect(operations?.dataPoints.map(point => [point.attributes, point.value])).toEqual(expect.arrayContaining([
    [{ 'resilience.boundary': 'resilience.execute', 'resilience.outcome': 'success' }, 1],
    [{ 'resilience.boundary': 'resilience.attempt', 'resilience.outcome': 'throw' }, 2],
    [{ 'resilience.boundary': 'resilience.wait', 'resilience.outcome': 'success' }, 1],
    [{ 'resilience.boundary': 'resilience.circuit_breaker', 'resilience.outcome': 'throw' }, 2],
  ]));
  expect(operations?.dataPoints).toHaveLength(4);
  expect(JSON.stringify(collected)).not.toContain('private payload');
});

it('records durations in seconds and refuses negative or nonfinite clock samples', async () => {
  const telemetry = installMetrics();
  const now = vi.spyOn(performance, 'now').mockReturnValueOnce(100).mockReturnValueOnce(350);
  expect(await noop.execute(() => 1)).toBe(1);
  now.mockReturnValueOnce(100).mockReturnValueOnce(50);
  await noop.execute(() => 2);
  now.mockReturnValue(Number.NaN);
  await noop.execute(() => 3);
  now.mockRestore();
  const collected = await telemetry.collect();
  const duration = collected.find(metric => metric.descriptor.name === 'resilience.duration');
  expect(duration?.descriptor.unit).toBe('s');
  if (duration?.dataPointType !== DataPointType.HISTOGRAM) throw new Error('Missing duration histogram');
  expect(duration.dataPoints[0]?.value).toMatchObject({ count: 1, sum: 0.25 });
  expect(collected.find(metric => metric.descriptor.name === 'resilience.operations')?.dataPoints[0]?.value).toBe(3);
});

it('keeps returned failure identity without using arbitrary failure codes as metric labels', async () => {
  const telemetry = installMetrics();
  const refused = defineFailure('private.tenant_123')();
  expect(await noop.execute(() => refused)).toBe(refused);
  const collected = await telemetry.collect();
  expect(collected.find(metric => metric.descriptor.name === 'resilience.operations')?.dataPoints).toMatchObject([
    { attributes: { 'resilience.boundary': 'resilience.execute', 'resilience.outcome': 'failure' }, value: 1 },
  ]);
  expect(JSON.stringify(collected)).not.toContain('tenant_123');
});

it('counts real breaker transitions once and attaches state events to the caller span', async () => {
  const telemetry = installMetrics();
  const exporter = new InMemorySpanExporter();
  tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(tracerProvider);
  const caller = trace.getTracer('test').startSpan('caller');
  vi.spyOn(context, 'active').mockReturnValue(trace.setSpan(ROOT_CONTEXT, caller));
  vi.useFakeTimers({ toFake: ['Date'] });
  const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1, halfOpenAfter: 100 });
  expect(UnexpectedDefect.is(await breaker.execute(() => { throw new Error('secret'); }))).toBe(true);
  expect(CircuitOpen.is(await breaker.execute(() => 1))).toBe(true);
  vi.advanceTimersByTime(100);
  expect(await breaker.execute(() => 2)).toBe(2);
  expect(await breaker.execute(() => 3)).toBe(3);
  caller.end();
  const collected = await telemetry.collect();
  const transitions = collected.find(metric => metric.descriptor.name === 'resilience.circuit.transitions');
  expect(transitions?.dataPoints.map(point => [point.attributes, point.value])).toEqual([
    [{ 'resilience.circuit.state': 'open' }, 1],
    [{ 'resilience.circuit.state': 'half_open' }, 1],
    [{ 'resilience.circuit.state': 'closed' }, 1],
  ]);
  const events = exporter.getFinishedSpans().find(span => span.name === 'caller')?.events;
  expect(events?.map(event => [event.name, event.attributes])).toEqual([
    ['resilience.circuit.state_changed', { 'resilience.circuit.state': 'open' }],
    ['resilience.circuit.state_changed', { 'resilience.circuit.state': 'half_open' }],
    ['resilience.circuit.state_changed', { 'resilience.circuit.state': 'closed' }],
  ]);
  expect(JSON.stringify(events)).not.toContain('secret');
});

function throwReporter(): never { throw new Error('reporter'); }
function rejectReporter() { return Promise.reject(new Error('reporter')); }
function pendingReporter() { return new Promise<void>(resolve => { releasePending = resolve; }); }
for (const [name, reporter] of [['throws', throwReporter], ['rejects', rejectReporter], ['pending', pendingReporter]] as const) {
  it(`metric acquisition ${name} cannot replace a completed operation`, async () => {
    vi.spyOn(metrics, 'getMeter');
    Reflect.set(metrics, 'getMeter', reporter);
    const value = { private: true };
    expect(await noop.execute(() => value)).toBe(value);
  });
  it(`counter ${name} cannot retry an already completed effect`, async () => {
    const telemetry = installMetrics();
    const counter = telemetry.meter.createCounter('fault-test');
    vi.spyOn(telemetry.meter, 'createCounter').mockReturnValue(counter);
    vi.spyOn(counter, 'add');
    Object.defineProperty(counter, 'add', { configurable: true, value: reporter });
    let calls = 0;
    expect(await createRetryPolicy({ backoff: backoff.constant(0).upTo(2) }).execute(() => ++calls)).toBe(1);
    expect(calls).toBe(1);
  });
}

it('does not recursively measure operations started by a metric reporter', async () => {
  const telemetry = installMetrics();
  const counter = telemetry.meter.createCounter('reentrant-test');
  vi.spyOn(telemetry.meter, 'createCounter').mockReturnValue(counter);
  const add = vi.fn(async () => {
    await Promise.resolve();
    expect(await noop.execute(() => 'nested')).toBe('nested');
  });
  vi.spyOn(counter, 'add');
  Object.defineProperty(counter, 'add', { configurable: true, value: add });
  expect(await noop.execute(() => 'outer')).toBe('outer');
  await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
});

it('counts once when a context manager repeats execution callbacks', async () => {
  const telemetry = installMetrics();
  tracerProvider = new BasicTracerProvider();
  trace.setGlobalTracerProvider(tracerProvider);
  vi.spyOn(context, 'with').mockImplementation((_current, callback) => { callback(); return callback(); });
  let calls = 0;
  expect(await noop.execute(() => ++calls)).toBe(1);
  const collected = await telemetry.collect();
  expect(collected.find(metric => metric.descriptor.name === 'resilience.operations')?.dataPoints[0]?.value).toBe(1);
});

it('observes an opaque success without rejecting or guessing its failure status', async () => {
  const telemetry = installMetrics();
  const opaque = new Proxy({}, { getPrototypeOf: throwReporter });
  expect(await noop.execute(() => opaque)).toBe(opaque);
  const collected = await telemetry.collect();
  expect(collected.find(metric => metric.descriptor.name === 'resilience.operations')?.dataPoints[0]?.attributes['resilience.outcome']).toBe('unclassified');
});

it('preserves dispatch when timing is unavailable', async () => {
  const telemetry = installMetrics();
  vi.spyOn(performance, 'now').mockImplementation(throwReporter);
  let calls = 0;
  const result = noop.execute(() => ++calls);
  expect(calls).toBe(1);
  expect(await result).toBe(1);
  vi.restoreAllMocks();
  const collected = await telemetry.collect();
  expect(collected.map(metric => metric.descriptor.name)).toEqual(['resilience.operations']);
});

it('observes histogram rejections without changing the canonical outcome', async () => {
  const telemetry = installMetrics();
  const histogram = telemetry.meter.createHistogram('fault-duration');
  vi.spyOn(telemetry.meter, 'createHistogram').mockReturnValue(histogram);
  vi.spyOn(histogram, 'record');
  Object.defineProperty(histogram, 'record', { configurable: true, value: rejectReporter });
  const refused = defineFailure('test.refused')();
  expect(await noop.execute(() => refused)).toBe(refused);
});

it('never opens a breaker or emits transitions for returned canonical failures', async () => {
  const telemetry = installMetrics();
  const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1 });
  const refused = defineFailure('test.refused')();
  expect(await breaker.execute(() => refused)).toBe(refused);
  expect(await breaker.execute(() => 1)).toBe(1);
  const collected = await telemetry.collect();
  expect(collected.map(metric => metric.descriptor.name)).not.toContain('resilience.circuit.transitions');
});

it('preserves breaker state when event reporting throws or rejects', async () => {
  const telemetry = installMetrics();
  tracerProvider = new BasicTracerProvider();
  trace.setGlobalTracerProvider(tracerProvider);
  const caller = trace.getTracer('test').startSpan('caller');
  vi.spyOn(context, 'active').mockReturnValue(trace.setSpan(ROOT_CONTEXT, caller));
  const event = vi.spyOn(caller, 'addEvent');
  Reflect.set(caller, 'addEvent', rejectReporter);
  const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1, halfOpenAfter: 0 });
  expect(UnexpectedDefect.is(await breaker.execute(throwReporter))).toBe(true);
  Reflect.set(caller, 'addEvent', throwReporter);
  expect(await breaker.execute(() => 1)).toBe(1);
  event.mockRestore();
  caller.end();
  const collected = await telemetry.collect();
  expect(collected.find(metric => metric.descriptor.name === 'resilience.circuit.transitions')?.dataPoints).toHaveLength(3);
});


it('does not feed asynchronous span-event reporters back into breaker telemetry', async () => {
  const telemetry = installMetrics();
  tracerProvider = new BasicTracerProvider();
  trace.setGlobalTracerProvider(tracerProvider);
  const caller = trace.getTracer('test').startSpan('caller');
  vi.spyOn(context, 'active').mockReturnValue(trace.setSpan(ROOT_CONTEXT, caller));
  const breaker = createCircuitBreakerPolicy({ consecutiveFailures: 1, halfOpenAfter: 0 });
  let reports = 0;
  let effects = 0;
  let reporting: Promise<void> = Promise.resolve();
  vi.spyOn(caller, 'addEvent');
  Object.defineProperty(caller, 'addEvent', { configurable: true, value: () => {
    reports++;
    // Bound a regression so a broken guard fails instead of looping forever.
    if (reports > 3) return caller;
    reporting = Promise.resolve().then(async () => {
      expect(UnexpectedDefect.is(await breaker.execute(() => { effects++; throw new Error('nested'); }))).toBe(true);
    });
    return reporting;
  } });
  expect(UnexpectedDefect.is(await breaker.execute(throwReporter))).toBe(true);
  await reporting;
  expect(reports).toBe(1);
  expect(effects).toBe(1);
  const collected = await telemetry.collect();
  const operations = collected.find(metric => metric.descriptor.name === 'resilience.operations');
  // A pending foreign reporter can coalesce counts; its nested call never adds one.
  expect(operations?.dataPoints.every(point => point.value === 1) ?? true).toBe(true);
  caller.end();
});
