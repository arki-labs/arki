/**
 * Lifecycle primitives for the DOT kernel.
 *
 * The kernel uses a 5-hook lifecycle that runs in declaration order
 * (providers are `.use()`d before their consumers — the app builder's
 * type-level guard enforces this at compile time):
 *
 *  - `configure` — synchronous registration of metadata, routes, services
 *  - `boot`       — async open of resources, publishes services into `app.services`
 *  - `start`      — async start of active work (workers, schedulers, listeners)
 *  - `stop`       — async stop of active work, runs in reverse declaration order
 *  - `dispose`    — async release of booted resources, runs in reverse declaration order
 *
 * Hook semantics, failure ordering, and idempotency rules are documented on the
 * public `DotApp` interface in `./define-app.ts`.
 */

/** Identifier of a single hook in the DOT lifecycle. */
export type DotLifecycleHook = 'configure' | 'boot' | 'start' | 'stop' | 'dispose';

/**
 * The complete set of lifecycle hooks in execution order.
 * `stop` and `dispose` run in reverse declaration order across pips, but the
 * sequence of hooks themselves is always `configure -> boot -> start -> stop -> dispose`.
 */
export const DOT_LIFECYCLE_HOOKS: readonly DotLifecycleHook[] = [
  'configure',
  'boot',
  'start',
  'stop',
  'dispose',
] as const;

/**
 * Macro-states the DotApp can occupy.
 *
 * State transitions:
 *
 *   defined -> configured -> booted -> started -> stopped -> disposed
 *                                                 |
 *                                                 +-> disposed (skip stopped if never started)
 *
 *   any-of(configure|boot|start) failure -> failed
 *
 * `failed` and `disposed` are terminal — callers must create a new instance.
 */
export type DotLifecycleState = 'defined' | 'configured' | 'booted' | 'started' | 'stopped' | 'disposed' | 'failed';

/** Stable error codes for lifecycle failures. */
export const DotLifecycleErrorCode = {
  /** A `configure` hook attempted async work (returned a Promise). */
  ConfigureAsync: 'DOT_LIFECYCLE_E001',
  /** A `configure` hook threw. */
  ConfigureFailed: 'DOT_LIFECYCLE_E002',
  /** A `boot` hook threw. */
  BootFailed: 'DOT_LIFECYCLE_E003',
  /** A `start` hook threw. */
  StartFailed: 'DOT_LIFECYCLE_E004',
  /** One or more `stop` hooks threw — aggregate. */
  StopFailed: 'DOT_LIFECYCLE_E005',
  /** One or more `dispose` hooks threw — aggregate. */
  DisposeFailed: 'DOT_LIFECYCLE_E006',
  /** Caller tried to reuse the app after dispose. */
  ReuseAfterDispose: 'DOT_LIFECYCLE_E007',
  /** Caller tried to reuse the app after a failed lifecycle. */
  ReuseAfterFailure: 'DOT_LIFECYCLE_E008',
  // E009 (DependencyCycle) and E010 (MissingDependency) are RETIRED with the
  // v2 wiring model — declaration order is boot order, so cycles and
  // name-based dependency declarations no longer exist. Codes are never
  // reused for new meanings.
  /** Pip registered twice. */
  DuplicatePip: 'DOT_LIFECYCLE_E011',
  /** A pip's `needs` entry has no provider among earlier-booted pips. */
  UnsatisfiedNeed: 'DOT_LIFECYCLE_E012',
  /** A pip published a wire key that an earlier pip already provides. */
  ServiceCollision: 'DOT_LIFECYCLE_E013',
} as const;

export type DotLifecycleErrorCodeValue = (typeof DotLifecycleErrorCode)[keyof typeof DotLifecycleErrorCode];

/**
 * Structured error thrown for any lifecycle failure or misuse.
 *
 * Carries:
 *  - `code`     — stable machine-readable error code (see {@link DotLifecycleErrorCode}).
 *  - `phase`    — which hook (or pseudo-hook) failed.
 *  - `pip`   — which pip name, when applicable.
 *  - `cause`    — original error if wrapped from a hook throw.
 *  - `failures` — for aggregate errors (stop/dispose), the per-pip failures.
 */
export class DotLifecycleError extends Error {
  readonly code: DotLifecycleErrorCodeValue;
  readonly phase: DotLifecycleHook;
  readonly pip?: string;
  override readonly cause?: unknown;
  readonly failures?: readonly DotLifecyclePipFailure[];

  constructor(args: {
    code: DotLifecycleErrorCodeValue;
    phase: DotLifecycleHook;
    message: string;
    pip?: string;
    cause?: unknown;
    failures?: readonly DotLifecyclePipFailure[];
  }) {
    super(args.message);
    this.name = 'DotLifecycleError';
    this.code = args.code;
    this.phase = args.phase;
    this.pip = args.pip;
    this.cause = args.cause;
    this.failures = args.failures;
  }
}

/** Single pip failure inside an aggregate lifecycle error (stop/dispose). */
export type DotLifecyclePipFailure = {
  pip: string;
  phase: DotLifecycleHook;
  error: unknown;
};
