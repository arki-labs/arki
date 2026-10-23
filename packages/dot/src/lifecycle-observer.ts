/**
 * Lifecycle observer surface for the DOT kernel.
 *
 * `DotLifecycleObserver` is the in-process companion to the OTel signals
 * emitted by {@link withPhaseSpan} / {@link withUnitHookSpan}. Where OTel
 * is the contract for cross-process tracing (consumers register an SDK
 * and ship spans to a backend), the observer is the contract for *local*
 * programmatic inspection — used by tests, CLI tooling, ASCII waterfalls,
 * and ad-hoc diagnostics that don't require an SDK to be registered.
 *
 * Both signals are emitted from the same kernel sites; neither is layered
 * under the other. A consumer can use one, both, or neither — the kernel
 * pays zero allocation for the observer fan-out when no observers are
 * registered.
 *
 * @see packages/dot/docs/observability.md — consumer-facing surface
 * @see packages/dot/docs/principles.md — principle 5 (zero optional deps)
 */

import type { Failure } from '@arki/failure';

import type { DotLifecycleHook } from './lifecycle.js';

/**
 * The single fan-out event type emitted by the kernel to every registered
 * observer. Discriminated by `kind`:
 *
 *   - `'phase'`     — boundary of a top-level lifecycle phase
 *   - `'unit-hook'`  — boundary of a single unit's hook execution
 *   - `'handler'`   — one handler call (an rpc procedure, an http route, a job, a schedule)
 *
 * Status discriminates the boundary itself:
 *
 *   - `'starting'`  — emitted *before* the work begins
 *   - `'completed'` — emitted *after* the work finished successfully
 *   - `'failed'`    — emitted *after* the work threw or rejected
 *
 * `starting` events never carry `durationMs` / `error`. `completed` events
 * carry `durationMs`. `failed` events carry both `durationMs` and `error`.
 */
export type DotLifecycleEvent = DotPhaseLifecycleEvent | DotUnitHookLifecycleEvent | DotHandlerLifecycleEvent;

/** Possible event statuses. See {@link DotLifecycleEvent}. */
export type DotLifecycleEventStatus = 'starting' | 'completed' | 'failed';

/** Boundary of a top-level lifecycle phase. */
export type DotPhaseLifecycleEvent = {
  readonly kind: 'phase';
  /** The phase the event belongs to. */
  readonly phase: DotLifecycleHook;
  readonly status: DotLifecycleEventStatus;
  /** App name (so multiplexed observers can disambiguate). */
  readonly appName: string;
  /** Wall-clock duration in milliseconds. Present on `completed` / `failed`. */
  readonly durationMs?: number;
  /** The error value, if `status === 'failed'`. */
  readonly error?: unknown;
  /** Wall-clock timestamp in ms-since-epoch (`Date.now()` semantics). */
  readonly timestamp: number;
};

/** Boundary of a single unit's hook execution. */
export type DotUnitHookLifecycleEvent = {
  readonly kind: 'unit-hook';
  /** The phase the hook belongs to. */
  readonly phase: DotLifecycleHook;
  /** The unit whose hook is being executed. */
  readonly plugin: string;
  /** Topological order of the unit within the phase (0-based). */
  readonly order: number;
  readonly status: DotLifecycleEventStatus;
  readonly appName: string;
  readonly durationMs?: number;
  readonly error?: unknown;
  readonly timestamp: number;
};

/** The transport a handler call came in on. */
export type DotHandlerTransport = 'rpc' | 'http' | 'job' | 'schedule';

/** Identity of a handler call: who ran, over which transport, as which entry. */
type DotHandlerEventBase = {
  readonly kind: 'handler';
  readonly transport: DotHandlerTransport;
  /** The unit that owns the handler: its `$unit` (the feature name, `name#instance` for an instance). */
  readonly feature: string;
  /** rpc: `path.join('.')`; http: `METHOD /path`; job: the job name; schedule: the schedule name. */
  readonly name: string;
  readonly appName: string;
  readonly timestamp: number;
};

/** A handler call is about to run. */
export type DotHandlerStartingEvent = DotHandlerEventBase & {
  readonly status: 'starting';
  readonly durationMs?: never;
  readonly outcome?: never;
  readonly failure?: never;
  readonly error?: never;
};

/**
 * A handler call ended without throwing. `outcome` is `'refused'` when it
 * returned a `Failure` (or its transport counts the throw as a refusal, as an
 * oRPC error below 500 is); `failure` carries the refusal when there is one.
 */
export type DotHandlerCompletedEvent = DotHandlerEventBase & {
  readonly status: 'completed';
  readonly durationMs: number;
  readonly outcome: 'ok' | 'refused';
  readonly failure?: Failure;
  readonly error?: never;
};

/** A handler call threw or rejected with something that is not a refusal: a bug, not traffic. */
export type DotHandlerFailedEvent = DotHandlerEventBase & {
  readonly status: 'failed';
  readonly durationMs: number;
  readonly error: unknown;
  readonly outcome?: never;
  readonly failure?: never;
};

/** One handler call, bracketed like a phase: `starting`, then `completed` or `failed`. */
export type DotHandlerLifecycleEvent = DotHandlerStartingEvent | DotHandlerCompletedEvent | DotHandlerFailedEvent;

/**
 * Observer function signature. Synchronous by contract — observers MUST
 * NOT block the lifecycle. If a long-running side effect is needed
 * (e.g. shipping events to a remote sink), the observer should buffer
 * the event and process it on a separate cadence.
 *
 * Exceptions thrown by an observer are caught and dropped on the kernel
 * floor (with a DEBUG log on `arki:dot:lifecycle`). One observer's
 * misbehaviour can never cause another observer to miss an event, nor
 * can it break the lifecycle.
 *
 * @example
 * ```ts
 * import { defineApp } from '@arki/dot';
 *
 * const events: DotLifecycleEvent[] = [];
 * const app = await defineApp('pizzeria', {
 *   observers: [(event) => events.push(event)],
 * })
 *   .infra(myUnit)
 *   .boot();
 *
 * // events now contains the full configure + boot event stream.
 * ```
 */
export type DotLifecycleObserver = (event: DotLifecycleEvent) => void;
