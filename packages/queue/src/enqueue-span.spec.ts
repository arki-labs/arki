/** Producer telemetry observes acceptance without owning or replaying it. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Context, ContextManager } from '@opentelemetry/api';
import type * as BullMQ from 'bullmq';
import { PGlite } from '@electric-sql/pglite';
import { context, propagation, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { PgBoss } from 'pg-boss';
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest';

import { RandomSourceUnavailable, z } from '@arki/contracts';
import { InvalidInput, orThrow, UnexpectedDefect, ValidatorDefect } from '@arki/failure';

import type { FlowEnqueueFailure } from './flow-jobs.ts';
import type { QueueJobId } from './job-id.ts';
import type { JobTriggerResult } from './trigger.ts';
import type { FlowEnqueueResult } from './types/builder.ts';
import { withEnqueueSpan } from './enqueue-span.ts';
import { QueueAcceptanceUnknown, QueueUnavailable } from './errors.ts';
import { initQueue } from './init.ts';
import { createQueueClient } from './queue-client.ts';
import { createRuntimeLocalQueueInstance } from './runtime-local/create-queue.ts';
import { triggerValidated } from './trigger.ts';

const transport = vi.hoisted(() => ({
  add: vi.fn<
    (
      name: string,
      data: unknown,
      options: { jobId: string; telemetry?: { metadata?: string } },
    ) => Promise<{ id: string }>
  >(),
  addBulk: vi.fn<BullMQ.FlowProducer['addBulk']>(),
}));
vi.mock('bullmq', async original => {
  const module = await original<typeof BullMQ>();
  return {
    ...module,
    Queue: class {
      add = transport.add;
      close() {
        return Promise.resolve();
      }
    },
    Worker: class {
      on() {
        return this;
      }
      close() {
        return Promise.resolve();
      }
    },
    FlowProducer: class {
      addBulk = transport.addBulk;
      close() {
        return Promise.resolve();
      }
    },
  };
});

class TestContextManager implements ContextManager {
  readonly storage = new AsyncLocalStorage<Context>();
  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    current: Context,
    callback: F,
    receiver?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(current, () => callback.apply(receiver, args));
  }
  bind<T>(_current: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    this.storage.disable();
    return this;
  }
}

let provider: BasicTracerProvider | undefined;
function installTelemetry() {
  const exporter = new InMemorySpanExporter();
  provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  trace.setGlobalTracerProvider(provider);
  context.setGlobalContextManager(new TestContextManager());
  propagation.setGlobalPropagator({
    inject(current, carrier, setter) {
      const active = trace.getSpanContext(current);
      if (active !== undefined) {
        setter.set(carrier, 'span-id', active.spanId);
        setter.set(carrier, 'trace-id', active.traceId);
      }
    },
    extract(current) {
      return current;
    },
    fields() {
      return ['span-id', 'trace-id'];
    },
  });
  return exporter;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  transport.add.mockReset();
  transport.addBulk.mockReset();
  context.disable();
  propagation.disable();
  trace.disable();
  await provider?.shutdown();
  provider = undefined;
});

const schema = z.object({ n: z.number() });
const q = initQueue.context<Record<string, never>>().create();
function job() {
  return q.job
    .name('declared-job')
    .input(schema)
    .handler(() => Promise.resolve('done'));
}

it('traces flow validation refusals before transport with the exact public result type', async () => {
  const exporter = installTelemetry();
  const flow = q.flow
    .name('declared-flow')
    .input(schema)
    .step('one', { job: job(), data: value => value })
    .build();
  const handle = createQueueClient({ connection: 'redis://localhost:6379' });
  try {
    const _enqueue = () => handle.client.enqueue(flow, { n: 1 });
    expectTypeOf<ReturnType<typeof _enqueue>>().toEqualTypeOf<Promise<FlowEnqueueResult | FlowEnqueueFailure>>();
    // @ts-expect-error Untyped callers must fail before opening the transport.
    const result = handle.client.enqueue(flow, { n: 'private input' });
    expect(await result).toMatchObject({ code: InvalidInput.code });
    expect(transport.addBulk).not.toHaveBeenCalled();
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('queue.flow.enqueue');
    expect(spans[0]?.kind).toBe(SpanKind.PRODUCER);
    expect(spans[0]?.attributes).toEqual({
      'messaging.destination.name': 'declared-flow',
      'failure.code': InvalidInput.code,
    });
    expect(spans[0]?.status).toEqual({ code: SpanStatusCode.ERROR });
    expect(spans[0]?.events).toEqual([]);
  } finally {
    await handle.close();
  }
});

it('propagates one flow producer context through the tree while preserving explicit telemetry', async () => {
  const exporter = installTelemetry();
  const parent = trace.getTracer('test').startSpan('caller');
  const mapper = vi.fn((value: z.output<typeof schema>) => value);
  const flow = q.flow
    .name('declared-flow')
    .input(schema)
    .step('child', { job: job(), data: mapper })
    .step('root', { job: job(), data: mapper, dependsOn: ['child'] })
    .step('explicit', { job: job(), data: mapper, opts: { telemetry: { metadata: 'explicit' } } })
    .build();
  transport.addBulk.mockRejectedValue(new Error('private transport defect'));
  const handle = createQueueClient({ connection: 'redis://localhost:6379' });
  try {
    const result = await context.with(trace.setSpan(context.active(), parent), () =>
      handle.client.enqueue(flow, { n: 1 }),
    );
    expect(result).toMatchObject({ code: QueueAcceptanceUnknown.code });
    expect(transport.addBulk).toHaveBeenCalledTimes(1);
    expect(mapper).toHaveBeenCalledTimes(3);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0];
    expect(span?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    const roots = transport.addBulk.mock.calls[0]?.[0];
    const metadata = JSON.stringify({
      'span-id': span?.spanContext().spanId,
      'trace-id': parent.spanContext().traceId,
    });
    expect(roots?.[0]?.opts?.telemetry?.metadata).toBe(metadata);
    expect(roots?.[0]?.children?.[0]?.opts?.telemetry?.metadata).toBe(metadata);
    expect(roots?.[1]?.opts?.telemetry?.metadata).toBe('explicit');
    expect(span?.attributes).toEqual({
      'messaging.destination.name': 'declared-flow',
      'failure.code': QueueAcceptanceUnknown.code,
    });
    expect(span?.events).toEqual([]);
  } finally {
    parent.end();
    await handle.close();
  }
});

it('never repeats flow mapping or submission when context callbacks repeat and reporters reject', async () => {
  installTelemetry();
  vi.spyOn(context, 'with').mockImplementation((_current, callback) => {
    callback();
    callback();
    return Promise.reject(new Error('private reporter'));
  });
  const mapper = vi.fn((value: z.output<typeof schema>) => value);
  const flow = q.flow.name('declared-flow').input(schema).step('one', { job: job(), data: mapper }).build();
  transport.addBulk.mockRejectedValue(new Error('private acceptance'));
  const handle = createQueueClient({ connection: 'redis://localhost:6379' });
  try {
    expect(await handle.client.enqueue(flow, { n: 1 })).toMatchObject({ code: QueueAcceptanceUnknown.code });
    expect(mapper).toHaveBeenCalledTimes(1);
    expect(transport.addBulk).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 0));
  } finally {
    await handle.close();
  }
});

it('keeps generic results and public enqueue success/failure inference exact', async () => {
  const value = { accepted: true };
  const observed = withEnqueueSpan(() => value);
  expectTypeOf(observed).toEqualTypeOf<Promise<typeof value | ReturnType<typeof UnexpectedDefect>>>();
  expect(await observed).toBe(value);
  expectTypeOf<ReturnType<ReturnType<typeof job>['trigger']>>().toEqualTypeOf<Promise<JobTriggerResult>>();
  const handle = createQueueClient({ connection: 'redis://localhost:6379' });
  expectTypeOf(handle.client.enqueue(job(), { n: 1 })).toEqualTypeOf<Promise<JobTriggerResult>>();
  await handle.close();
});

it('returns exact failure identity and ends one producer span with safe fields', async () => {
  const exporter = installTelemetry();
  const failure = InvalidInput({ issues: [{ message: 'private data' }] });
  expect(await withEnqueueSpan(() => failure, 'declared-job')).toBe(failure);
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  expect(spans[0]?.name).toBe('queue.enqueue');
  expect(spans[0]?.kind).toBe(SpanKind.PRODUCER);
  expect(spans[0]?.attributes).toEqual({ 'messaging.destination.name': 'declared-job', 'failure.code': failure.code });
  expect(spans[0]?.status).toEqual({ code: SpanStatusCode.ERROR });
  expect(spans[0]?.events).toEqual([]);
});

it.each([
  'invalid-input',
  'validator-defect',
  'invalid-key',
  'entropy',
  'missing-ack',
  'bad-ack',
  'send-rejection',
] as const)('covers %s within one acceptance span without repeating send', async scenario => {
  const exporter = installTelemetry();
  const send = vi.fn<(key: QueueJobId) => Promise<string | undefined>>(key => Promise.resolve(key));
  let input: z.ZodType<unknown> = schema;
  let data: unknown = { n: 1 };
  let key: string | undefined = 'private-id';
  let code: string = InvalidInput.code;
  if (scenario === 'invalid-input') data = { n: 'private-value' };
  if (scenario === 'validator-defect') {
    input = z.number().transform(() => {
      throw new Error('private defect');
    });
    data = 1;
    code = ValidatorDefect.code;
  }
  if (scenario === 'invalid-key') {
    // @ts-expect-error Runtime callers can hand the boundary a non-string key.
    key = 42;
  }
  if (scenario === 'entropy') {
    key = undefined;
    vi.stubGlobal('crypto', null);
    code = RandomSourceUnavailable.code;
  }
  // The typed transport mock requires its missing acknowledgement as an explicit argument.
  // eslint-disable-next-line unicorn/no-useless-undefined
  if (scenario === 'missing-ack') send.mockResolvedValue(undefined);
  if (scenario === 'bad-ack') {
    // @ts-expect-error A defective transport can acknowledge with malformed data.
    send.mockResolvedValue(42);
  }
  if (scenario === 'send-rejection') send.mockRejectedValue(new Error('private lost ack'));
  if (['missing-ack', 'bad-ack', 'send-rejection'].includes(scenario)) code = QueueAcceptanceUnknown.code;
  const result = await triggerValidated(input, data, key, send, 'declared-job');
  expect(result).toMatchObject({ code });
  expect(send).toHaveBeenCalledTimes(['missing-ack', 'bad-ack', 'send-rejection'].includes(scenario) ? 1 : 0);
  expect(exporter.getFinishedSpans()).toHaveLength(1);
  expect(exporter.getFinishedSpans()[0]?.attributes).toEqual({
    'messaging.destination.name': 'declared-job',
    'failure.code': code,
  });
});

it('owns one operation under repeated, synchronously reentrant context calls that then throw', async () => {
  installTelemetry();
  let reenter: (() => void) | undefined;
  vi.spyOn(context, 'with').mockImplementation((_current, callback) => {
    reenter = () => {
      callback();
    };
    callback();
    callback();
    throw new Error('broken telemetry');
  });
  const send = vi.fn((key: QueueJobId) => {
    reenter?.();
    return Promise.resolve(key);
  });
  expect(await triggerValidated(schema, { n: 1 }, 'key', send)).toBe('key');
  expect(send).toHaveBeenCalledTimes(1);
});

it.each(['before-callback', 'rejected-reporter', 'pending-reporter', 'tracer'] as const)(
  'ignores %s faults without hanging acceptance',
  async fault => {
    installTelemetry();
    if (fault === 'tracer')
      vi.spyOn(trace, 'getTracer').mockImplementation(() => {
        throw new Error('provider');
      });
    else
      vi.spyOn(context, 'with').mockImplementation((_current, callback) => {
        if (fault === 'before-callback') throw new Error('context');
        callback();
        return callback();
      });
    // The runtime can violate the declared context API by returning a promise unrelated to work.
    if (fault === 'rejected-reporter')
      vi.spyOn(context, 'with').mockImplementation((_current, callback) => {
        callback();
        return Promise.reject(new Error('reporter'));
      });
    if (fault === 'pending-reporter')
      vi.spyOn(context, 'with').mockImplementation((_current, callback) => {
        callback();
        return new Promise(() => {
          // A broken reporter never settles; enqueue still must.
        });
      });
    const run = vi.fn(() => 'accepted');
    expect(await withEnqueueSpan(run)).toBe('accepted');
    expect(run).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 0));
  },
);

it('preserves rejected owned work when context repeats it and finishing reporters reject', async () => {
  installTelemetry();
  const tracer = trace.getTracer('@arki/queue');
  const start = tracer.startSpan.bind(tracer);
  vi.spyOn(tracer, 'startSpan').mockImplementation((...args) => {
    const span = start(...args);
    vi.spyOn(span, 'setAttribute').mockImplementation(() => {
      throw new Error('attribute');
    });
    vi.spyOn(span, 'setStatus').mockImplementation(() => {
      throw new Error('status');
    });
    Object.defineProperty(span, 'end', { value: () => Promise.reject(new Error('exporter')) });
    return span;
  });
  vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
  vi.spyOn(context, 'with').mockImplementation((_current, callback) => {
    callback();
    return callback();
  });
  const error = new Error('owned rejection');
  const run = vi.fn(() => Promise.reject(error));
  expect(await withEnqueueSpan(run)).toMatchObject({ code: UnexpectedDefect.code });
  expect(run).toHaveBeenCalledTimes(1);
  await new Promise(resolve => setTimeout(resolve, 0));
});

it.each(['registered', 'producer'] as const)(
  'propagates caller -> %s producer -> BullMQ carrier exactly once',
  async mode => {
    const exporter = installTelemetry();
    const parent = trace.getTracer('test').startSpan('caller');
    const definition = job();
    transport.add.mockImplementation((_name, _data, options) => Promise.resolve({ id: options.jobId }));
    const handle = createQueueClient({ connection: 'redis://localhost:6379' });
    const instance = q.createQueue({ connection: 'redis://localhost:6379', createContext: () => ({}) });
    if (mode === 'registered') await instance.register({ definition });
    try {
      const result = await context.with(trace.setSpan(context.active(), parent), () =>
        mode === 'registered'
          ? instance.enqueue(definition, { n: 1 }, { jobId: 'private-id' })
          : handle.client.enqueue(definition, { n: 1 }, { jobId: 'private-id' }),
      );
      expect(result).toBe('private-id');
      expect(transport.add).toHaveBeenCalledTimes(1);
      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);
      const span = spans[0];
      expect(span?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
      expect(span?.attributes).toEqual({ 'messaging.destination.name': 'declared-job' });
      expect(JSON.parse(transport.add.mock.calls[0]?.[2].telemetry?.metadata ?? '{}')).toEqual({
        'span-id': span?.spanContext().spanId,
        'trace-id': parent.spanContext().traceId,
      });
    } finally {
      parent.end();
      await handle.close();
      await instance.stop();
    }
  },
);

it('preserves explicitly supplied BullMQ telemetry precedence', async () => {
  installTelemetry();
  const handle = createQueueClient({ connection: 'redis://localhost:6379' });
  transport.add.mockImplementation((_name, _data, options) => Promise.resolve({ id: options.jobId }));
  try {
    orThrow(
      await handle.client.enqueue(
        job(),
        { n: 1 },
        { jobId: 'key', bullmqOptions: { telemetry: { metadata: 'caller-owned' } } },
      ),
    );
    expect(transport.add.mock.calls[0]?.[2].telemetry?.metadata).toBe('caller-owned');
  } finally {
    await handle.close();
  }
});

it('traces every unavailable entry without changing unavailable-before-validation precedence', async () => {
  const exporter = installTelemetry();
  const definition = job();
  const instance = q.createQueue({ connection: 'redis://localhost:6379', createContext: () => ({}) });
  expect(await definition.trigger({ n: Number.NaN })).toMatchObject({ code: QueueUnavailable.code });
  expect(await instance.enqueue(definition, { n: Number.NaN })).toMatchObject({ code: QueueUnavailable.code });
  const db = new PGlite();
  const local = createRuntimeLocalQueueInstance({ pglite: db, createContext: () => ({}) });
  try {
    await local.register({ definition });
    expect(await definition.trigger({ n: Number.NaN })).toMatchObject({ code: QueueUnavailable.code });
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(3);
    for (const span of spans)
      expect(span.attributes).toEqual({
        'messaging.destination.name': 'declared-job',
        'failure.code': QueueUnavailable.code,
      });
    expect(transport.add).not.toHaveBeenCalled();
  } finally {
    await db.close();
  }
});

it('propagates caller -> local producer -> pg-boss envelope once', async () => {
  const exporter = installTelemetry();
  const db = new PGlite();
  const instance = createRuntimeLocalQueueInstance({ pglite: db, createContext: () => ({}) });
  const definition = job();
  const parent = trace.getTracer('test').startSpan('caller');
  try {
    await instance.register({ definition });
    await instance.start();
    const send = vi.spyOn(PgBoss.prototype, 'send').mockResolvedValue('accepted');
    expect(
      await context.with(trace.setSpan(context.active(), parent), () =>
        definition.trigger({ n: 1 }, { jobId: 'private-id' }),
      ),
    ).toBe('private-id');
    expect(send).toHaveBeenCalledTimes(1);
    const envelope = z.object({ trace: z.string() }).parse(send.mock.calls[0]?.[1]);
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.parentSpanContext?.spanId).toBe(parent.spanContext().spanId);
    expect(spans[0]?.attributes).toEqual({ 'messaging.destination.name': 'declared-job' });
    expect(JSON.parse(envelope.trace)).toEqual({
      'span-id': spans[0]?.spanContext().spanId,
      'trace-id': parent.spanContext().traceId,
    });
  } finally {
    parent.end();
    await instance.stop();
    await db.close();
  }
}, 20_000);

it('normalizes unexpected owned synchronous defects without exporting their cause', async () => {
  const exporter = installTelemetry();
  const cause = new Error('private owned defect');
  const run = vi.fn(() => {
    throw cause;
  });
  expect(await withEnqueueSpan(run, 'declared-job')).toMatchObject({ code: UnexpectedDefect.code });
  expect(run).toHaveBeenCalledTimes(1);
  expect(exporter.getFinishedSpans()[0]?.attributes).toEqual({
    'messaging.destination.name': 'declared-job',
    'failure.code': UnexpectedDefect.code,
  });
  expect(exporter.getFinishedSpans()[0]?.events).toEqual([]);
});

it('keeps flow enqueue outside the single-job span boundary', async () => {
  const exporter = installTelemetry();
  const flow = q.flow
    .name('declared-flow')
    .input(schema)
    .step('one', { job: job(), data: input => input })
    .build();
  const handle = createQueueClient({ connection: 'redis://localhost:6379' });
  const instance = q.createQueue({ connection: 'redis://localhost:6379', createContext: () => ({}) });
  try {
    expect(await handle.client.enqueue(flow, { n: Number.NaN })).toMatchObject({ code: InvalidInput.code });
    expect(await instance.enqueue(flow, { n: Number.NaN })).toMatchObject({ code: InvalidInput.code });
    expect(exporter.getFinishedSpans().map(span => span.name)).toEqual(['queue.flow.enqueue', 'queue.flow.enqueue']);
    expect(transport.add).not.toHaveBeenCalled();
    expect(transport.addBulk).not.toHaveBeenCalled();
  } finally {
    await handle.close();
    await instance.stop();
  }
});

it('observes rejected span-creation reporters despite a defective tracer return type', async () => {
  installTelemetry();
  const tracer = trace.getTracer('@arki/queue');
  Object.defineProperty(tracer, 'startSpan', { value: () => Promise.reject(new Error('broken tracer')) });
  vi.spyOn(trace, 'getTracer').mockReturnValue(tracer);
  const run = vi.fn(() => 'accepted');
  expect(await withEnqueueSpan(run)).toBe('accepted');
  expect(run).toHaveBeenCalledTimes(1);
  await new Promise(resolve => setTimeout(resolve, 0));
});

it('observes rejected tracer-acquisition reporters despite a defective API return type', async () => {
  installTelemetry();
  vi.spyOn(trace, 'getTracer');
  Object.defineProperty(trace, 'getTracer', { value: () => Promise.reject(new Error('broken acquisition')) });
  const run = vi.fn(() => 'accepted');
  expect(await withEnqueueSpan(run)).toBe('accepted');
  expect(run).toHaveBeenCalledTimes(1);
  await new Promise(resolve => setTimeout(resolve, 0));
});

it.each(['active', 'setSpan'] as const)(
  'observes rejected %s context reporters without changing owned acceptance',
  async method => {
    installTelemetry();
    if (method === 'active') {
      vi.spyOn(context, 'active');
      Object.defineProperty(context, 'active', { value: () => Promise.reject(new Error('broken active context')) });
    } else {
      vi.spyOn(trace, 'setSpan');
      Object.defineProperty(trace, 'setSpan', { value: () => Promise.reject(new Error('broken span context')) });
    }
    const run = vi.fn(() => 'accepted');
    expect(await withEnqueueSpan(run)).toBe('accepted');
    expect(run).toHaveBeenCalledTimes(1);
    await new Promise(resolve => setTimeout(resolve, 0));
  },
);
