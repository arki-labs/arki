/**
 * OpenTelemetry instrumentation for the DOT kernel.
 *
 * DOT is OTel-first: every lifecycle phase and every per-plugin hook
 * automatically emits a span and a duration histogram. When no SDK is
 * registered, the OTel API returns no-op implementations and the kernel
 * pays zero allocation per call — the discipline that makes "OTel-first"
 * compatible with principle 5 (zero optional dependencies in the kernel).
 *
 * Consumers wire the SDK however they like (`@opentelemetry/sdk-node`,
 * `@arki/meter`, etc.); the kernel never touches the SDK directly.
 *
 * Span / attribute conventions:
 *
 *   - Phase span: `dot.app.<phase>` — one root span per `configure()` /
 *     `boot()` / `start()` / `stop()` / `dispose()` call. Children
 *     auto-link via async-context.
 *   - Hook span:  `dot.plugin.<hook>` — one child span per plugin's hook
 *     execution. The plugin name lives on `dot.plugin.name`, not in the span
 *     name, so backends can aggregate by hook across plugins.
 *   - Attributes (`dot.app.name`, `dot.plugin.name`, `dot.plugin.version`,
 *     `dot.hook`, `dot.plugin.order`) follow the OTel convention of
 *     namespacing under the library's prefix.
 *
 * @see packages/dot/docs/principles.md — principle 3 (deterministic) +
 *      principle 4 (agent-discoverable).
 */

import { metrics, SpanStatusCode, trace, type Span } from '@opentelemetry/api';
import type { Logger } from '@arki/log';

import type { DotLifecycleHook } from '../lifecycle.js';

const INSTRUMENTATION_NAME = '@arki/dot';
const INSTRUMENTATION_VERSION = '0.1.0';

/** OTel tracer for the DOT kernel. No-op when no SDK is registered. */
export const tracer = trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);

/** OTel meter for the DOT kernel. No-op when no SDK is registered. */
export const meter = metrics.getMeter(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);

/**
 * Histogram recording per-plugin per-hook execution duration in milliseconds.
 *
 * Attributes:
 *   - `dot.app.name` — app name
 *   - `dot.plugin.name` — plugin name
 *   - `dot.hook`     — which lifecycle hook (`configure` | `boot` | ...)
 *   - `dot.status`   — `ok` | `failed`
 */
export const hookDurationHistogram = meter.createHistogram('dot.plugin.hook.duration', {
  description: 'Wall-clock duration of a single plugin lifecycle hook execution.',
  unit: 'ms',
});

/**
 * Histogram recording per-phase (app-level) execution duration.
 *
 * Attributes:
 *   - `dot.app.name`  — app name
 *   - `dot.app.phase` — which phase (`configure` | `boot` | `start` | `stop` | `dispose`)
 *   - `dot.status`    — `ok` | `failed`
 */
export const phaseDurationHistogram = meter.createHistogram('dot.app.phase.duration', {
  description: 'Wall-clock duration of a complete app-level lifecycle phase.',
  unit: 'ms',
});

/**
 * Sanitize attribute values — OTel rejects `undefined` and strips out
 * keys whose values aren't primitives or arrays of primitives. We drop
 * `undefined` here so call sites can pass optional fields without
 * branching.
 */
function attrs(
  source: Readonly<Record<string, string | number | boolean | undefined>>,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(source)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** Stringify any thrown value for span status / exception recording. */
function stringifyForSpan(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Wrap a single plugin-hook execution in a child span and record its
 * duration in the histogram. The span auto-links to the active phase
 * span (set by {@link withPhaseSpan}) so traces show a clean parent-child
 * hierarchy:
 *
 *     dot.app.boot
 *     ├── dot.plugin.boot   (dot.plugin.name=env, dot.hook=boot)
 *     ├── dot.plugin.boot   (dot.plugin.name=db,  dot.hook=boot)
 *     └── dot.plugin.boot   (dot.plugin.name=kv,  dot.hook=boot)
 *
 * Re-throws on failure after marking the span ERROR so the caller's
 * existing error-handling path stays intact.
 */
export function withPluginHookSpan<R>(
  opts: {
    readonly appName: string;
    readonly pluginName: string;
    readonly pluginVersion?: string;
    readonly hook: DotLifecycleHook;
    readonly order: number;
    /**
     * Optional plugin-scoped logger. When present, the helper threads the
     * span's `traceId` + `spanId` onto the logger via `setTraceContext`
     * before invoking the body — every log line emitted from within the
     * plugin's hook is automatically correlated with this span in the
     * `traceId`/`spanId` fields of `LogRecord`.
     */
    readonly logger?: Logger;
  },
  fn: (span: Span) => R,
): R {
  const span = tracer.startSpan(`dot.plugin.${opts.hook}`, {
    attributes: attrs({
      'dot.app.name': opts.appName,
      'dot.plugin.name': opts.pluginName,
      'dot.plugin.version': opts.pluginVersion,
      'dot.hook': opts.hook,
      'dot.plugin.order': opts.order,
    }),
  });
  if (opts.logger) {
    const sc = span.spanContext();
    opts.logger.setTraceContext(sc.traceId, sc.spanId);
  }
  const started = performance.now();
  let status: 'ok' | 'failed' = 'ok';
  const finish = (): void => {
    const durationMs = performance.now() - started;
    hookDurationHistogram.record(durationMs, {
      'dot.app.name': opts.appName,
      'dot.plugin.name': opts.pluginName,
      'dot.hook': opts.hook,
      'dot.status': status,
    });
    span.end();
  };
  try {
    const result = fn(span);
    if (result instanceof Promise) {
      return result.then(
        v => {
          span.setStatus({ code: SpanStatusCode.OK });
          finish();
          return v;
        },
        (e: unknown) => {
          status = 'failed';
          span.setStatus({ code: SpanStatusCode.ERROR, message: stringifyForSpan(e) });
          if (e instanceof Error) span.recordException(e);
          finish();
          throw e;
        },
      ) as R;
    }
    span.setStatus({ code: SpanStatusCode.OK });
    finish();
    return result;
  } catch (e) {
    status = 'failed';
    span.setStatus({ code: SpanStatusCode.ERROR, message: stringifyForSpan(e) });
    if (e instanceof Error) span.recordException(e);
    finish();
    throw e;
  }
}

/**
 * Wrap an entire app-level phase (`configure`/`boot`/`start`/`stop`/`dispose`)
 * in an active span. Children created by {@link withPluginHookSpan} inherit
 * this span as their parent via async-context.
 *
 * The callback's return value (sync or Promise) is propagated unchanged
 * to preserve the kernel's existing control flow.
 */
export function withPhaseSpan<R>(
  opts: {
    readonly appName: string;
    readonly appVersion?: string;
    readonly phase: DotLifecycleHook;
    readonly pluginCount: number;
    /**
     * Optional phase-scoped logger. When present, the helper threads
     * the span's `traceId` + `spanId` onto the logger before invoking
     * the body — every log line written during the phase carries the
     * trace context so it's groupable with the corresponding span in
     * any OTel-compatible backend.
     */
    readonly logger?: Logger;
  },
  fn: (span: Span) => R,
): R {
  return tracer.startActiveSpan(
    `dot.app.${opts.phase}`,
    {
      attributes: attrs({
        'dot.app.name': opts.appName,
        'dot.app.version': opts.appVersion,
        'dot.app.phase': opts.phase,
        'dot.app.plugin.count': opts.pluginCount,
      }),
    },
    (span): R => {
      if (opts.logger) {
        const sc = span.spanContext();
        opts.logger.setTraceContext(sc.traceId, sc.spanId);
      }
      const started = performance.now();
      let status: 'ok' | 'failed' = 'ok';
      const finish = (): void => {
        const durationMs = performance.now() - started;
        phaseDurationHistogram.record(durationMs, {
          'dot.app.name': opts.appName,
          'dot.app.phase': opts.phase,
          'dot.status': status,
        });
        span.end();
      };
      try {
        const result = fn(span);
        if (result instanceof Promise) {
          return result.then(
            v => {
              span.setStatus({ code: SpanStatusCode.OK });
              finish();
              return v;
            },
            (e: unknown) => {
              status = 'failed';
              span.setStatus({ code: SpanStatusCode.ERROR, message: stringifyForSpan(e) });
              if (e instanceof Error) span.recordException(e);
              finish();
              throw e;
            },
          ) as R;
        }
        span.setStatus({ code: SpanStatusCode.OK });
        finish();
        return result;
      } catch (e) {
        status = 'failed';
        span.setStatus({ code: SpanStatusCode.ERROR, message: stringifyForSpan(e) });
        if (e instanceof Error) span.recordException(e);
        finish();
        throw e;
      }
    },
  );
}
