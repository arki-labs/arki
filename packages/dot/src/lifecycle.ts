/**
 * Lifecycle primitives for the DOT kernel.
 *
 * The kernel uses a 5-hook lifecycle that runs in declaration order
 * (providers are `.infra()`d before their consumers — the app builder's
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
 * `stop` and `dispose` run in reverse declaration order across units, but the
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

/**
 * Stable error codes for every failure the kernel throws, `ARKI_DOT_E001`..
 * Codes are never renumbered and never reused (E009 and E010 are retired).
 * E001-E021 and E033 are lifecycle failures; E022-E031 are feature-composition
 * failures (see `FEATURE_ERROR_CODES`); E032 is non-JSON manifest data.
 */
export const DotLifecycleErrorCode = {
  /**
   * A `configure` hook attempted async work (returned a Promise).
   * @fix Make `configure` synchronous and move async work to `boot`.
   * @verify dot explain --json | jq -e .ok
   */
  ConfigureAsync: 'ARKI_DOT_E001',
  /**
   * A `configure` hook threw.
   * @fix Fix the unit's config or its `configure` hook, then build a new app.
   * @verify dot explain --json | jq -e .ok
   */
  ConfigureFailed: 'ARKI_DOT_E002',
  /**
   * A `boot` hook threw.
   * @fix Read `cause` and `plugin`, then fix that unit's `boot` hook or the service it opens.
   * @verify dot doctor --json | jq -e .ok
   */
  BootFailed: 'ARKI_DOT_E003',
  /**
   * A `start` hook threw.
   * @fix Read `cause` and `plugin`, then fix that unit's `start` hook.
   * @verify bun run test
   */
  StartFailed: 'ARKI_DOT_E004',
  /**
   * One or more `stop` hooks threw — aggregate.
   * @fix Read `failures`: each entry names the unit whose `stop` hook threw.
   * @verify bun run test
   */
  StopFailed: 'ARKI_DOT_E005',
  /**
   * One or more `dispose` hooks threw — aggregate.
   * @fix Read `failures`: each entry names the unit whose `dispose` hook threw.
   * @verify dot doctor --json | jq -e .ok
   */
  DisposeFailed: 'ARKI_DOT_E006',
  /**
   * Caller tried to reuse the app after dispose.
   * @fix Build a fresh app instance; a disposed app cannot run again.
   * @verify bun run test
   */
  ReuseAfterDispose: 'ARKI_DOT_E007',
  /**
   * Caller tried to reuse the app after a failed lifecycle.
   * @fix Build a fresh app instance; a failed app cannot run again.
   * @verify bun run test
   */
  ReuseAfterFailure: 'ARKI_DOT_E008',
  // E009 (DependencyCycle) and E010 (MissingDependency) are RETIRED with the
  // v2 wiring model — declaration order is boot order, so cycles and
  // name-based dependency declarations no longer exist. Codes are never
  // reused for new meanings.
  /**
   * Unit registered twice.
   * @fix Remove the second `.infra()` of this unit, or `rename` it to run two copies.
   * @verify dot explain --json | jq -e .ok
   */
  DuplicateUnit: 'ARKI_DOT_E011',
  /**
   * A unit's `needs` entry has no provider among earlier-booted units.
   * @fix Mount a unit that provides the needed key before its consumer.
   * @verify dot doctor --json | jq -e .ok
   */
  UnsatisfiedNeed: 'ARKI_DOT_E012',
  /**
   * A unit published a wire key that an earlier unit already provides.
   * @fix Give one of the two providers a different key with `rename`.
   * @verify dot doctor --json | jq -e .ok
   */
  ServiceCollision: 'ARKI_DOT_E013',
  /**
   * A needs alias, publish key, or rename target uses the reserved `$` prefix.
   * @fix Rename the key; names starting with `$` belong to the kernel.
   * @verify dot explain --json | jq -e .ok
   */
  ReservedServiceKey: 'ARKI_DOT_E014',
  /**
   * A lifecycle hook exceeded the app's `hookTimeoutMs` watchdog.
   * @fix Pass the hook's `$signal` to its I/O, or raise `hookTimeoutMs` with a reason.
   * @verify dot doctor --json | jq -e .ok
   */
  HookTimeout: 'ARKI_DOT_E015',
  /**
   * Two actions in the same binding use the same id.
   * @fix Give each action in a binding its own id.
   * @verify dot explain --json | jq -e .ok
   */
  DuplicateAction: 'ARKI_DOT_E016',
  /**
   * Action metadata is not JSON-round-trip safe.
   * @fix Keep action `meta` plain JSON: no functions, Dates, Maps or cycles.
   * @verify dot explain --json | jq -e .ok
   */
  ActionMetaNotJson: 'ARKI_DOT_E017',
  /**
   * More than one unit fills the logging slot.
   * @fix Keep one `log()` unit in the app.
   * @verify dot explain --json | jq -e .ok
   */
  DuplicateLogging: 'ARKI_DOT_E018',
  /**
   * Static capability needs form a ring: a feature's need comes back around to itself.
   * @fix Move the shared piece into a third unit that both sides need.
   * @verify dot explain --json | jq -e .ok
   */
  CapabilityRing: 'ARKI_DOT_E019',
  /**
   * A feature needs a capability whose (static) provider is mounted after it.
   * @fix Mount the provider before the unit that needs it; the message names both positions.
   * @verify dot explain --json | jq -e .ok
   */
  ProviderMountedLater: 'ARKI_DOT_E020',
  /**
   * `$describeAction` named an action the calling unit may not amend (unknown id, or not its own).
   * @fix Describe only actions the calling unit declared or owns.
   * @verify dot explain --json | jq -e .ok
   */
  ActionNotAmendable: 'ARKI_DOT_E021',
  /**
   * A unit was mounted on the wrong side of the hexagon: an `entrypoint` in
   * `.infra()` / `.infra()`, or an `infra` or `feature` unit in `.entrypoints()` / `.entrypoints()`.
   * Typed graphs refuse this at compile time; this catches erased ones.
   * @fix Mount infra with `.infra(...)` and entrypoints with `.entrypoints(...)`, or build the unit with the other constructor.
   * @verify dot explain --json | jq -e .ok
   */
  UnitOnWrongSide: 'ARKI_DOT_E033',
} as const;

export type DotLifecycleErrorCodeValue = (typeof DotLifecycleErrorCode)[keyof typeof DotLifecycleErrorCode];

/** Documentation page for a kernel error code: the README "Errors" table, one anchor per code. */
export function dotErrorDocsUrl(code: string): string {
  return `https://docs.arki.dev/dot/errors#${code.toLowerCase()}`;
}

/** Stock remediation per lifecycle code. A throw site may override it with a more specific line. */
const LIFECYCLE_REMEDIATION: Record<DotLifecycleErrorCodeValue, string> = {
  [DotLifecycleErrorCode.ConfigureAsync]: 'Make `configure` synchronous and move async work to `boot`.',
  [DotLifecycleErrorCode.ConfigureFailed]: "Fix the unit's config or its `configure` hook, then build a new app.",
  [DotLifecycleErrorCode.BootFailed]:
    "Read `cause` and `plugin`: fix that unit's `boot` hook or the service it opens.",
  [DotLifecycleErrorCode.StartFailed]: "Read `cause` and `plugin`: fix that unit's `start` hook.",
  [DotLifecycleErrorCode.StopFailed]: 'Read `failures`: each entry names the unit whose `stop` hook threw.',
  [DotLifecycleErrorCode.DisposeFailed]: 'Read `failures`: each entry names the unit whose `dispose` hook threw.',
  [DotLifecycleErrorCode.ReuseAfterDispose]: 'Build a fresh app instance; a disposed app cannot run again.',
  [DotLifecycleErrorCode.ReuseAfterFailure]: 'Build a fresh app instance; a failed app cannot run again.',
  [DotLifecycleErrorCode.DuplicateUnit]:
    'Remove the second `.infra()` of this unit, or `rename` it to run two copies.',
  [DotLifecycleErrorCode.UnsatisfiedNeed]: 'Mount a unit that provides the needed key before its consumer.',
  [DotLifecycleErrorCode.ServiceCollision]: 'Give one of the two providers a different key with `rename`.',
  [DotLifecycleErrorCode.ReservedServiceKey]: 'Rename the key; names starting with `$` belong to the kernel.',
  [DotLifecycleErrorCode.HookTimeout]: "Pass the hook's `$signal` to its I/O, or raise `hookTimeoutMs`.",
  [DotLifecycleErrorCode.DuplicateAction]: 'Give each action in a binding its own id.',
  [DotLifecycleErrorCode.ActionMetaNotJson]: 'Keep action `meta` plain JSON: no functions, Dates, Maps or cycles.',
  [DotLifecycleErrorCode.DuplicateLogging]: 'Keep one `log()` unit in the app.',
  [DotLifecycleErrorCode.CapabilityRing]: 'Move the shared piece into a third unit that both sides need.',
  [DotLifecycleErrorCode.ProviderMountedLater]: 'Mount the provider before the unit that needs it.',
  [DotLifecycleErrorCode.ActionNotAmendable]:
    '`$describeAction` only accepts actions the calling unit declared or owns.',
  [DotLifecycleErrorCode.UnitOnWrongSide]:
    'Mount infra({...}) units with .infra(...) and entrypoint({...}) units with .entrypoints(...).',
};

/**
 * Structured error thrown for any lifecycle failure or misuse.
 *
 * Carries:
 *  - `code`     — stable machine-readable error code (see {@link DotLifecycleErrorCode}).
 *  - `phase`    — which hook (or pseudo-hook) failed.
 *  - `plugin`   — which unit name, when applicable.
 *  - `cause`    — original error if wrapped from a hook throw.
 *  - `failures` — for aggregate errors (stop/dispose), the per-unit failures.
 */
export class DotLifecycleError extends Error {
  readonly code: DotLifecycleErrorCodeValue;
  /** One-sentence guidance on how to fix the problem. Same shape as `DotUnitError.remediation`. */
  readonly remediation: string;
  /** Documentation page that explains this error. */
  readonly docsUrl: string;
  readonly phase: DotLifecycleHook;
  readonly plugin?: string;
  override readonly cause?: unknown;
  readonly failures?: readonly DotLifecycleUnitFailure[];

  constructor(args: {
    code: DotLifecycleErrorCodeValue;
    phase: DotLifecycleHook;
    message: string;
    /** Overrides the stock remediation for this code. */
    remediation?: string;
    plugin?: string;
    cause?: unknown;
    failures?: readonly DotLifecycleUnitFailure[];
  }) {
    super(args.message);
    this.name = 'DotLifecycleError';
    this.code = args.code;
    this.remediation = args.remediation ?? LIFECYCLE_REMEDIATION[args.code];
    this.docsUrl = dotErrorDocsUrl(args.code);
    this.phase = args.phase;
    this.plugin = args.plugin;
    this.cause = args.cause;
    this.failures = args.failures;
  }
}

/** Single unit failure inside an aggregate lifecycle error (stop/dispose). */
export type DotLifecycleUnitFailure = {
  plugin: string;
  phase: DotLifecycleHook;
  error: unknown;
};
