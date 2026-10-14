// @arki/log/otel: a trace source and a sink for OpenTelemetry (RFC §10).
// `@opentelemetry/api` and `@opentelemetry/api-logs` are optional peers.
// Importing does nothing: both functions do their work when called.

import type { AnyValue, AnyValueMap, LoggerProvider } from '@opentelemetry/api-logs';
import { isSpanContextValid, ROOT_CONTEXT, trace } from '@opentelemetry/api';

import type { LogRecord, Sink, TraceContext, TraceSource, Value } from '../core/types.js';
import { serializeError } from '../core/serialize.js';

/** The instrumentation scope name `otelSink` asks the provider for. */
const SCOPE_NAME = '@arki/log';

/**
 * A trace source that reads the active span from `@opentelemetry/api` when a
 * record is built. Pass it as `configure({ trace: otelTrace() })`.
 */
export function otelTrace(): TraceSource {
  return activeTrace;
}

function activeTrace(): TraceContext | undefined {
  const span = trace.getActiveSpan();
  if (span === undefined) return undefined;
  const context = span.spanContext();
  if (!isSpanContextValid(context)) return undefined;
  return { traceId: context.traceId, spanId: context.spanId, traceFlags: context.traceFlags };
}

/**
 * A sink that sends records to the OpenTelemetry Logs API. Each record keeps
 * its severity, its rendered message (or its structured body for `emit()`),
 * its fields as attributes plus `log.category` and `log.template`, its trace
 * ids, and the configured resource fields (as attributes; a record's own
 * fields win on a clash).
 */
export function otelSink(loggerProvider: LoggerProvider): Sink {
  const logger = loggerProvider.getLogger(SCOPE_NAME);
  return {
    write: record => {
      logger.emit({
        timestamp: record.time,
        severityNumber: record.level,
        severityText: record.levelName,
        body: record.eventName === undefined ? record.message() : toAnyValue(record.body),
        attributes: attributesOf(record),
        ...(record.eventName === undefined ? {} : { eventName: record.eventName }),
        ...(record.error === undefined ? {} : { exception: record.error }),
        ...(record.traceId === undefined || record.spanId === undefined
          ? {}
          : {
              context: trace.setSpanContext(ROOT_CONTEXT, {
                traceId: record.traceId,
                spanId: record.spanId,
                traceFlags: record.traceFlags ?? 0,
              }),
            }),
      });
    },
  };
}

function attributesOf(record: LogRecord): AnyValueMap {
  const attributes: AnyValueMap = {};
  for (const key in record.resource) attributes[key] = toAnyValue(record.resource[key]);
  for (const key in record.fields) attributes[key] = toAnyValue(record.fields[key]);
  attributes['log.category'] = record.category;
  if (record.template !== '') attributes['log.template'] = record.template;
  return attributes;
}

function toAnyValue(value: Value): AnyValue {
  if (value === null || value === undefined) return value;
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean': {
      return value;
    }
    case 'bigint': {
      return value.toString();
    }
    default: {
      break;
    }
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return toAnyValue(serializeError(value));
  if (isValueArray(value)) return value.map(item => toAnyValue(item));
  const map: AnyValueMap = {};
  for (const key in value) map[key] = toAnyValue(value[key]);
  return map;
}

function isValueArray(value: Value): value is readonly Value[] {
  return Array.isArray(value);
}
