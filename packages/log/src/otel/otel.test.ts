import type { Context, ContextManager } from '@opentelemetry/api';
import type { LoggerProvider, LogRecord as OtelLogRecord } from '@opentelemetry/api-logs';
import { context, ROOT_CONTEXT, trace, TraceFlags } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLogging } from '../core/logging.js';
import { memorySink } from '../core/sinks.js';
import { otelSink, otelTrace } from './index.js';

/** A synchronous context manager: enough to make a span active inside `context.with`. */
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

const SPAN = {
  traceId: '0af7651916cd43dd8448eb211c80319c',
  spanId: 'b7ad6b7169203331',
  traceFlags: TraceFlags.SAMPLED,
};

describe('otelTrace', () => {
  beforeEach(() => {
    context.setGlobalContextManager(syncContextManager());
  });
  afterEach(() => {
    context.disable();
  });

  it('stamps the active span on records built inside it, so logs join their trace', () => {
    const logging = createLogging();
    const sink = memorySink();
    logging.configure({ channels: { mem: sink }, default: { level: 'info', channels: ['mem'] }, trace: otelTrace() });
    const log = logging.getLogger('app');

    context.with(trace.setSpan(context.active(), trace.wrapSpanContext(SPAN)), () => {
      log.info('inside');
    });
    log.info('outside');

    expect(sink.records[0]).toMatchObject({ traceId: SPAN.traceId, spanId: SPAN.spanId, traceFlags: 1 });
    expect(sink.records[1]?.traceId).toBeUndefined();
  });
});

function capturingProvider(): { provider: LoggerProvider; emitted: OtelLogRecord[]; scopes: string[] } {
  const emitted: OtelLogRecord[] = [];
  const scopes: string[] = [];
  const provider: LoggerProvider = {
    getLogger: name => {
      scopes.push(name);
      return { emit: record => emitted.push(record) };
    },
  };
  return { provider, emitted, scopes };
}

describe('otelSink', () => {
  it('maps severity, rendered message, fields, category, template and resource', () => {
    const { provider, emitted, scopes } = capturingProvider();
    const logging = createLogging();
    logging.configure({
      channels: { otel: otelSink(provider) },
      default: { level: 'info', channels: ['otel'] },
      resource: { 'service.name': 'checkout', region: 'eu' },
    });

    logging.getLogger('billing').warn('charged {amount}', { amount: 42, region: 'us', at: new Date(0), big: 1n });

    expect(scopes).toEqual(['@arki/log']);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toMatchObject({
      severityNumber: 13,
      severityText: 'warn',
      body: 'charged 42',
      attributes: {
        'service.name': 'checkout',
        region: 'us', // the record's own field wins over the resource
        amount: 42,
        at: '1970-01-01T00:00:00.000Z',
        big: '1',
        'log.category': 'billing',
        'log.template': 'charged {amount}',
      },
    });
    expect(typeof emitted[0]?.timestamp).toBe('number');
  });

  it('sends an emit() body and event name as they are, and the error as the exception', () => {
    const { provider, emitted } = capturingProvider();
    const logging = createLogging();
    logging.configure({ channels: { otel: otelSink(provider) }, default: { level: 'info', channels: ['otel'] } });
    const log = logging.getLogger('pay');

    log.emit({ level: 'info', eventName: 'payment.accepted', body: { id: 'p1', cents: 100 } });
    const failure = new Error('declined');
    log.error('charge failed', { error: failure });

    expect(emitted[0]).toMatchObject({ eventName: 'payment.accepted', body: { id: 'p1', cents: 100 } });
    expect(emitted[0]?.attributes).not.toHaveProperty('log.template');
    expect(emitted[1]).toMatchObject({ severityNumber: 17, body: 'charge failed', exception: failure });
  });

  it('carries the record trace ids in the OTel context', () => {
    const { provider, emitted } = capturingProvider();
    const logging = createLogging();
    logging.configure({ channels: { otel: otelSink(provider) }, default: { level: 'info', channels: ['otel'] } });

    logging.getLogger('app').withTrace(SPAN).info('traced');

    const carried = emitted[0]?.context === undefined ? undefined : trace.getSpanContext(emitted[0].context);
    expect(carried).toMatchObject(SPAN);
  });
});
