/** Identity-scoped custom OpenTelemetry instrumentation for Dot plugin and feature authors. */
import type { Attributes, MetricOptions, SpanOptions } from '@opentelemetry/api';
import { context, isSpanContextValid, metrics, trace } from '@opentelemetry/api';

import type { Fields, LevelInput } from '@arki/log';
import packageMetadata from '@arki/dot/package.json' with { type: 'json' };
import { getLogger } from '@arki/log';

import { observe, withOutcomeSpan, withSpanContext } from './kernel/otel.js';

/**
 * Scope custom instrumentation from an existing plugin, feature or hook context.
 * App-owned OTel providers supply tracing; without an SDK every call is safe.
 * Use a new span only for a new operational boundary, not one already instrumented.
 *
 * @example
 * const telemetry = telemetryFor(catalog);
 * const found = telemetry.span('cache.lookup', () => cache.get(key));
 */
export function telemetryFor(owner: { readonly name: string } | { readonly $plugin: string }) {
  const name = 'name' in owner ? owner.name : owner.$plugin;
  const scope = `@arki/dot/${name}`;
  const identity = { 'dot.plugin.name': name };
  return {
    /** Observe a custom operation, retaining its exact return value, promise and failure identity. */
    span<Value>(name: string, run: () => Value, options?: SpanOptions): Value {
      const span = observe(() =>
        trace
          .getTracer(scope, packageMetadata.version)
          .startSpan(name, { ...options, attributes: { ...options?.attributes, ...identity } }),
      );
      return withOutcomeSpan(span, () => withSpanContext(span, run));
    },
    /** Annotate the active operation without adding a span. Explicit attributes only. */
    event(name: string, attributes?: Attributes): void {
      observe(() => trace.getActiveSpan()?.addEvent(name, { ...attributes, ...identity }));
    },
    /** Create a counter. Keep explicit dimensions bounded; do not include user IDs or payloads. */
    counter(name: string, options?: MetricOptions) {
      const counter = observe(() => metrics.getMeter(scope, packageMetadata.version).createCounter(name, options));
      return {
        add(value: number, attributes?: Attributes): void {
          observe(() => counter?.add(value, { ...attributes, ...identity }, context.active()));
        },
      };
    },
    /** Create a histogram with the same identity and context as this scope. */
    histogram(name: string, options?: MetricOptions) {
      const histogram = observe(() => metrics.getMeter(scope, packageMetadata.version).createHistogram(name, options));
      return {
        record(value: number, attributes?: Attributes): void {
          observe(() => histogram?.record(value, { ...attributes, ...identity }, context.active()));
        },
      };
    },
    /** Write through the app's logging setup with the active trace stamped on the record. */
    log(level: LevelInput, template: string, fields?: Fields): void {
      observe(() => {
        const logger = getLogger(`arki:dot:${name}`);
        const spanContext = trace.getActiveSpan()?.spanContext();
        const correlated =
          spanContext !== undefined && isSpanContextValid(spanContext) ? logger.withTrace(spanContext) : logger;
        correlated.log(level, template, { ...fields, ...identity });
      });
    },
  };
}

/** The inferred custom instrumentation surface, shared by all plugin and feature contexts. */
export type DotTelemetry = ReturnType<typeof telemetryFor>;
