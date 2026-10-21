import type { Span } from '@opentelemetry/api';
import { context, INVALID_SPAN_CONTEXT, metrics, SpanStatusCode, trace } from '@opentelemetry/api';

import packageMetadata from '@arki/dot/package.json' with { type: 'json' };
import { isFailure, UnexpectedDefect } from '@arki/failure';

import type { DotLifecycleHook } from '../lifecycle.js';
import { nowMs } from './now.js';
import { chainNativePromise } from './usecase.js';

/**
 * OpenTelemetry instrumentation for the DOT kernel.
 *
 * DOT is OTel-first: every lifecycle phase and every per-unit hook
 * automatically emits a span and a duration histogram. When no SDK is
 * registered, the OTel API returns no-op implementations. Instruments are
 * acquired inside the observation boundary so late or defective SDK setup
 * cannot prevent application loading or change execution.
 *
 * Consumers wire the SDK however they like (`@opentelemetry/sdk-node`,
 * `@fleet/meter`, etc.); the kernel never touches the SDK directly.
 *
 * Span / attribute conventions:
 *
 *   - Phase span: `dot.app.<phase>` — one root span per `configure()` /
 *     `boot()` / `start()` / `stop()` / `dispose()` call. Children
 *     auto-link via async-context.
 *   - Hook span:  `dot.unit.<hook>` — one child span per unit's hook
 *     execution. The unit name lives on `dot.unit.name`, not in the span
 *     name, so backends can aggregate by hook across units.
 *   - Usecase span: `feature.<feature>.<usecase>` — one active span per call
 *     of a `defineFeature(...).usecases(...)` function (see {@link traceUsecase}).
 *   - Attributes (`dot.app.name`, `dot.unit.name`, `dot.hook`,
 *     `dot.unit.order`) follow the OTel convention of
 *     namespacing under the library's prefix.
 *
 * @see packages/dot/docs/principles.md — principle 3 (deterministic) +
 *      principle 4 (agent-discoverable).
 */

const INSTRUMENTATION_NAME = '@arki/dot';
const INSTRUMENTATION_VERSION = packageMetadata.version;

/** Acquire instruments inside the observation boundary, after the app can install its SDK. */
function tracer() {
  return trace.getTracer(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION);
}

function duration(name: string, description: string) {
  return metrics
    .getMeter(INSTRUMENTATION_NAME, INSTRUMENTATION_VERSION)
    .createHistogram(name, { description, unit: 'ms' });
}

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

/** Record returned outcomes without manufacturing exceptions for expected refusals. */
function recordOutcome(span: Span, outcome: unknown): 'ok' | 'failed' {
  if (!isFailure(outcome)) {
    span.setStatus({ code: SpanStatusCode.OK });
    return 'ok';
  }
  span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.code });
  span.setAttributes({ 'failure.code': outcome.code, 'failure.status': outcome.status });
  if (UnexpectedDefect.is(outcome) && outcome.cause instanceof Error) span.recordException(outcome.cause);
  return 'failed';
}

/**
 * Wrap a single unit-hook execution in a child span and record its
 * duration in the histogram. The span auto-links to the active phase
 * span (set by {@link withPhaseSpan}) so traces show a clean parent-child
 * hierarchy:
 *
 *     dot.app.boot
 *     ├── dot.unit.boot   (dot.unit.name=env, dot.hook=boot)
 *     ├── dot.unit.boot   (dot.unit.name=db,  dot.hook=boot)
 *     └── dot.unit.boot   (dot.unit.name=kv,  dot.hook=boot)
 *
 * Re-throws on failure after marking the span ERROR so the caller's
 * existing error-handling path stays intact.
 */
export function withUnitHookSpan<R>(
  opts: {
    readonly appName: string;
    readonly unitName: string;
    readonly hook: DotLifecycleHook;
    readonly order: number;
  },
  fn: (span: Span) => R,
): R {
  const span = observe(() =>
    tracer().startSpan(`dot.unit.${opts.hook}`, {
      attributes: attrs({
        'dot.app.name': opts.appName,
        'dot.unit.name': opts.unitName,
        'dot.hook': opts.hook,
        'dot.unit.order': opts.order,
      }),
    }),
  );
  const started = nowMs();
  return withOutcomeSpan(
    span,
    () => fnWithSpan(span, fn),
    status => {
      duration('dot.unit.hook.duration', 'Wall-clock duration of a single unit lifecycle hook execution.').record(
        nowMs() - started,
        {
          'dot.app.name': opts.appName,
          'dot.unit.name': opts.unitName,
          'dot.hook': opts.hook,
          'dot.status': status,
        },
      );
    },
  );
}

/**
 * Wrap an entire app-level phase (`configure`/`boot`/`start`/`stop`/`dispose`)
 * in an active span. Children created by {@link withUnitHookSpan} inherit
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
    readonly unitCount: number;
  },
  fn: (span: Span) => R,
): R {
  const span = observe(() =>
    tracer().startSpan(`dot.app.${opts.phase}`, {
      attributes: attrs({
        'dot.app.name': opts.appName,
        'dot.app.version': opts.appVersion,
        'dot.app.phase': opts.phase,
        'dot.app.unit.count': opts.unitCount,
      }),
    }),
  );
  const started = nowMs();
  return withOutcomeSpan(
    span,
    () => fnWithSpan(span, fn),
    status => {
      duration('dot.app.phase.duration', 'Wall-clock duration of a complete app-level lifecycle phase.').record(
        nowMs() - started,
        {
          'dot.app.name': opts.appName,
          'dot.app.phase': opts.phase,
          'dot.status': status,
        },
      );
    },
  );
}

/** Reporting is best effort: its own failure cannot replace or report the primary outcome. */
export function observe<Value>(report: () => Value): Value | undefined {
  try {
    return report();
  } catch {
    return undefined;
  }
}

function fnWithSpan<Value>(span: Span | undefined, fn: (span: Span) => Value): Value {
  // The API's no-op span keeps the callback contract when a reporter cannot start a span.
  const activeSpan = span ?? trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
  return withSpanContext(span, () => fn(activeSpan));
}

/**
 * Activate app-owned context without letting a defective context manager control execution.
 * The local outcome retains the one callback invocation when a manager skips, repeats,
 * swallows or throws after it. Reporter failures never become application failures.
 */
export function withSpanContext<Value>(span: Span | undefined, run: () => Value): Value {
  if (span === undefined) return run();
  const invocation: { outcome?: { value: Value } | { cause: unknown } } = {};
  const invoke = (): Value => {
    if (invocation.outcome === undefined) {
      try {
        invocation.outcome = { value: run() };
      } catch (error) {
        invocation.outcome = { cause: error };
      }
    }
    if ('cause' in invocation.outcome) throw invocation.outcome.cause;
    return invocation.outcome.value;
  };
  observe(() => context.with(trace.setSpan(context.active(), span), invoke));
  return invoke();
}

/** Observe settlement without replacing the callback's value or promise identity. */
export function withOutcomeSpan<Value>(
  span: Span | undefined,
  run: () => Value,
  recordDuration?: (status: 'ok' | 'failed') => void,
): Value {
  const returned = (value: unknown): void => {
    const status = observe(() => (isFailure(value) ? 'failed' : 'ok'));
    observe(() => {
      if (span !== undefined) recordOutcome(span, value);
    });
    if (status !== undefined) observe(() => recordDuration?.(status));
    observe(() => span?.end());
  };
  const thrown = (cause: unknown): void => {
    observe(() => span?.setStatus({ code: SpanStatusCode.ERROR, message: stringifyForSpan(cause) }));
    observe(() => {
      if (cause instanceof Error) span?.recordException(cause);
    });
    observe(() => recordDuration?.('failed'));
    observe(() => span?.end());
  };
  try {
    const result = run();
    if (chainNativePromise(result, returned, thrown) === undefined) returned(result);
    return result;
  } catch (error) {
    thrown(error);
    throw error;
  }
}

/**
 * Wrap one usecase so each call runs in an active span named
 * `feature.<featureName>.<usecaseName>`. A value that is not a function is
 * returned as is. Invocation supervision is a separate boundary.
 *
 * - Returns (or resolves to) an `@arki/failure` failure: status ERROR with
 *   `failure.code` and `failure.status`, and no exception event — a failure
 *   is an expected outcome, not a bug.
 * - Throws (or rejects): the exception is recorded, status ERROR, and the
 *   same value is rethrown.
 * - Anything else: status OK, like the kernel's hook spans.
 *
 * With no SDK registered (or a sampler that drops the span) the call goes
 * straight through: same `this`, same arguments, the very same return value
 * (a promise is not re-wrapped). Sync usecases stay sync; an async one ends
 * its span when its promise settles.
 */
export function traceUsecase(featureName: string, usecaseName: string, usecase: unknown): unknown {
  if (typeof usecase !== 'function') return usecase;
  // A const keeps the narrowing inside `traced` (a parameter's would not survive the hoisted function).
  const call = usecase;
  const spanName = `feature.${featureName}.${usecaseName}`;
  function traced(this: unknown, ...args: unknown[]): unknown {
    const span = observe(() => tracer().startSpan(spanName));
    return withOutcomeSpan(span, () => withSpanContext(span, () => Reflect.apply(call, this, args)));
  }
  return Object.defineProperties(traced, Object.getOwnPropertyDescriptors(usecase));
}
