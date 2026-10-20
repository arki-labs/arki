/**
 * DOT adapter for `@arki/schedule` — the `schedule()` driving adapter.
 *
 * `schedule()` is a driver: `.serve(schedule(...))` binds it to the
 * features the app mounted and runs every feature's `schedules(...)` slice,
 * plus any app-level `schedules` passed here. The app lists its features
 * once:
 *
 * ```ts
 * defineApp('shop')
 *   .use(db({ url }))
 *   .features([billing, reports])           // each declares `use: [schedules(...)]`
 *   .serve(schedule({ needs: { db: service<Db>() }, context: ({ db }) => ({ db }) }));
 * ```
 *
 * A feature declares its schedules in one of two forms:
 *
 * - `schedules(needs, [{ name, cron | every, handler: s => ... }])` — the
 *   feature owns them. Each handler receives the services `needs` names,
 *   typed with no annotation, and the feature's own `needs` must cover
 *   them (a compile error otherwise). Not durable: a durable run happens
 *   in another process that does not hold these services.
 * - `schedules([defineSchedule(...)])` — handlers receive the driver's
 *   `context`. The features are bound at runtime, so the compiler cannot
 *   check that these schedules expect that context: keep one context type
 *   per app (e.g. via `initSchedule.context<Ctx>()`).
 *
 * `clock: 'host'` hands the clock to the host (a platform cron, an HTTP
 * endpoint): nothing fires on its own; schedules run only through the
 * `scheduler` service the driver provides. `composeSchedules(features,
 * app.services.scheduler)` turns that service into a typed client: the
 * names and each handler's result type come from the features' own
 * declarations.
 */

import type { AnyFeatureCore, AnyFeatureSlice, DepsOf, Driver, MountedFeature } from '@arki/dot/feature';
import type { CtxOf, EmptyShape, NeedsShape, Plugin, WireNeeds } from '@arki/dot/plugin';
import type { SuccessOf } from '@arki/failure';
import { allFeatures, driver, entrypointsOf, instanceOf, sliceOf } from '@arki/dot/feature';
import { plugin, token } from '@arki/dot/plugin';

import type { LockDuration, Locker, ScheduleDef, ScheduleInterval, ScheduleOverlap, ScheduleRun } from './index.js';
import type { DurableScheduler, ScheduleClock, ScheduleOutcome, ScheduleRefusal, ScheduleRuntime } from './runtime.js';
import { SCHEDULE_ACTION_META_SCHEMA } from './action-meta.js';
import { SCHEDULE_ERROR_CODES, ScheduleError } from './errors.js';
import { DEFAULT_LOCK_HOLD_MS, defineSchedule, lockDurationMs } from './index.js';
import { assertDurableBackend, assertSingleClock, createScheduleRuntime } from './runtime.js';

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };

export type ScheduleDotAction = {
  readonly id: string;
  readonly binding: 'schedule';
  readonly direction: 'in';
  readonly address: string;
  readonly metaSchema: typeof SCHEDULE_ACTION_META_SCHEMA;
  readonly meta: JsonObject;
};

type NoReservedKeys = Readonly<Record<`$${string}`, never>>;

/**
 * The durable backend service. `durableScheduler()` from `@arki/queue/dot`
 * provides it under this key; `schedule({ durable: DurableSchedules })`
 * needs it, so the app builder rejects the app when no provider is mounted.
 * It is the adapter's own need, not a feature slice.
 */
export const DurableSchedules = token<DurableScheduler>()('arki.schedule.durable');

export type DurableSchedulesToken = typeof DurableSchedules;

type DurableNeeds<TDurable extends DurableSchedulesToken | undefined> = [TDurable] extends [DurableSchedulesToken]
  ? WireNeeds<{ readonly durable: DurableSchedulesToken }>
  : EmptyShape;

// Local alias for the durable need. Dotted so it cannot clash with a
// caller's own `needs` alias.
const DURABLE_ALIAS = 'schedule.durable';

function isDurableScheduler(value: unknown): value is DurableScheduler {
  return (
    typeof value === 'object' &&
    value !== null &&
    'start' in value &&
    typeof value.start === 'function' &&
    'stop' in value &&
    typeof value.stop === 'function'
  );
}

function durableBackend(services: Readonly<Record<string, unknown>>): DurableScheduler | undefined {
  const value = services[DURABLE_ALIAS];
  return isDurableScheduler(value) ? value : undefined;
}

type ScheduleBaseOptions<TContext> = {
  /**
   * App-level schedules no feature owns. Feature schedules come from the
   * bound features' `schedules(...)` slices; both run on one runtime.
   */
  readonly schedules?: readonly ScheduleDef<TContext>[];
  readonly jitterMs?: number;
  /**
   * Who fires the schedules. Default `'internal'`: in-process timers (and
   * the durable backend). `'host'`: nothing fires on its own; the host
   * runs each schedule through the `scheduler` service. A durable schedule
   * or backend with `'host'` fails boot with a coded error (two clocks).
   */
  readonly clock?: ScheduleClock;
};

/**
 * The service the `schedule()` driver provides as `scheduler`. `trigger`
 * runs one schedule now and reports `unknown` for a name it does not run
 * and `unavailable` once the app has stopped. Use `composeSchedules` for a
 * client typed from the features' declarations.
 */
export type ScheduleService = {
  readonly clock: ScheduleClock;
  /** Every schedule this driver runs: app-level, then feature schedules in mount order. */
  readonly names: readonly string[];
  trigger(name: string): Promise<ScheduleOutcome<unknown>>;
};

/** What the `schedule()` driver adds to the app's services. */
export type SchedulerProvides = { readonly scheduler: ScheduleService };

type ScheduleDurableOption<TDurable extends DurableSchedulesToken | undefined> = {
  /** Pass `DurableSchedules` to run `durable: true` schedules on the mounted durable backend. */
  readonly durable?: TDurable;
};

/** No `context`: every schedule — feature and app-level — takes no context. */
export type ScheduleNoContextOptions<TDurable extends DurableSchedulesToken | undefined = undefined> =
  ScheduleBaseOptions<undefined> &
    ScheduleDurableOption<TDurable> & {
      readonly needs?: never;
      readonly context?: never;
    };

/**
 * With `context`: the value every handler receives, built at boot from
 * the adapter's own `needs`. One plain object type (no union) so the
 * compiler infers `TNeeds` first and types `context`'s parameter from it.
 */
export type ScheduleOptions<
  TNeeds extends NeedsShape & NoReservedKeys,
  TContext,
  TDurable extends DurableSchedulesToken | undefined = undefined,
> = ScheduleBaseOptions<TContext> &
  ScheduleDurableOption<TDurable> & {
    readonly needs?: TNeeds;
    readonly context: (services: CtxOf<TNeeds>) => TContext | Promise<TContext>;
  };

/** What a locked schedule asks for, resolved: the key, and the minimum hold in milliseconds. */
type LockPlan = {
  readonly key: string;
  readonly holdAtLeastMs: number;
  readonly locks?: Locker;
  /** The key is the schedule name (`lock: true` or no key), so an instance qualifies it. */
  readonly byName?: boolean;
};

/** `1000` -> `1s`, `1500` -> `1500ms`: the shortest whole unit, for manifest text. */
function formatHold(ms: number): string {
  if (ms >= 3_600_000 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms >= 1000 && ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}

/**
 * The manifest line for a locked schedule:
 * `lock ns:key  [store · kind · scope · crash→x · fence y · hold≥1s]`. The
 * `ns:` and the bracket appear only when the locker says its namespace and
 * store. A declaration cannot say them (the locker exists only at boot), so
 * the static action text has just `lock key`; boot completes it with the full
 * line (`dot doctor` shows it).
 */
export function lockSummary(plan: LockPlan): string {
  const { locks, key, holdAtLeastMs } = plan;
  const name = locks?.namespace === undefined ? key : `${locks.namespace}:${key}`;
  const store = locks?.store;
  if (store === undefined) return `lock ${name}`;
  const { kind, scope, fence, releasedOnCrash } = store.guarantees;
  const parts = [
    store.name,
    kind,
    scope,
    `crash→${releasedOnCrash}`,
    `fence ${fence === false ? 'none' : fence}`,
    ...(holdAtLeastMs > 0 ? [`hold≥${formatHold(holdAtLeastMs)}`] : []),
  ];
  return `lock ${name}  [${parts.join(' · ')}]`;
}

/**
 * What `dot explain` warns about an unlocked schedule. On the in-process
 * clock every replica fires it; on the host's clock nothing fires on its own,
 * but two triggers that overlap can both run.
 */
function noLockSummary(clock: ScheduleClock): string {
  return clock === 'host' ? 'NO LOCK — overlapping triggers can both run' : 'NO LOCK — runs on every replica';
}

function actionForSchedule<TContext>(
  schedule: ScheduleDef<TContext>,
  clock: ScheduleClock,
  declared?: LockPlan,
): ScheduleDotAction {
  const kind = schedule.cron === undefined ? 'every' : 'cron';
  const address = schedule.cron ?? schedule.every ?? '';
  const plan: LockPlan | undefined =
    declared ??
    (schedule.lock === undefined
      ? undefined
      : { ...schedule.lock, holdAtLeastMs: schedule.lock.holdAtLeastMs ?? DEFAULT_LOCK_HOLD_MS });
  // A durable run reaches one worker through its backend: no lock, nothing to warn about.
  const summary = plan === undefined ? (schedule.durable ? undefined : noLockSummary(clock)) : lockSummary(plan);
  const store = plan?.locks?.store;
  return {
    id: `${schedule.name}.fire`,
    binding: 'schedule',
    direction: 'in',
    address,
    ...(summary === undefined ? {} : { summary }),
    metaSchema: SCHEDULE_ACTION_META_SCHEMA,
    meta: {
      kind,
      ...(schedule.cron === undefined ? {} : { cron: schedule.cron }),
      ...(schedule.every === undefined ? {} : { every: schedule.every }),
      ...(schedule.timezone === undefined ? {} : { timezone: schedule.timezone }),
      overlap: schedule.overlap,
      locked: plan !== undefined,
      // The lock this schedule runs under, so `dot explain` shows which jobs exclude each other.
      ...(plan === undefined ? {} : { lock: plan.key, holdAtLeastMs: plan.holdAtLeastMs }),
      ...(store === undefined ? {} : { lockStore: store.name }),
      durable: schedule.durable,
    },
  };
}

export function scheduleActions<TContext>(
  schedules: readonly ScheduleDef<TContext>[],
  clock: ScheduleClock = 'internal',
): readonly ScheduleDotAction[] {
  return schedules.map(definition => actionForSchedule(definition, clock));
}

/** The `@arki/dot/feature` slice contract a `schedules(...)` declaration produces. */
export type ScheduleFeatureSlice<TDefinitions extends readonly ScheduleDef<never>[]> = {
  /** Lets a `defineFeature` feature list it in `.entrypoints(...)`; object-form features ignore it. */
  readonly kind: 'schedules';
  readonly key: 'schedules';
  readonly actions: readonly ScheduleDotAction[];
  readonly resolve: (services: unknown) => TDefinitions;
  readonly definitions: TDefinitions;
};

/** Exactly one of `cron` or `every`. */
type FeatureScheduleTiming =
  { readonly cron: string; readonly every?: never } | { readonly every: ScheduleInterval; readonly cron?: never };

/** The ways a feature schedule asks for a lock. */
export type FeatureLockOption = true | string | { readonly key?: string; readonly holdAtLeast?: LockDuration };

/**
 * One schedule a feature owns, written as a plain option object inside
 * `schedules(needs, [...])` so the handler's parameter is typed from
 * `needs`. The handler may return a value; `composeSchedules` types the
 * `ran` outcome with it. No `durable: true` (see the module docs).
 */
export type FeatureScheduleOptions<TServices> = FeatureScheduleTiming & {
  readonly name: string;
  readonly timezone?: string;
  readonly overlap?: ScheduleOverlap;
  readonly durable?: false;
  /**
   * Keep this job to one replica at a time, for as long as it runs: `true`
   * locks on the schedule name, a string on that key (share one key to make
   * two jobs exclude each other), the object form sets `key` and
   * `holdAtLeast`. A run that finds the lock held reports `skipped-lock`.
   * The feature needs a `locks` service — mount
   * `locks({ namespace, needs, store })` from `@arki/lock/dot` (a compile
   * error otherwise).
   *
   * The lock stays held at least `holdAtLeast` (default `'1s'`, `0` turns it
   * off). A job that ends in 10 ms would otherwise free the key at once, and
   * a replica whose clock runs a little behind would start the same tick
   * again. The hold applies on shutdown too: the app waits for the release.
   */
  readonly lock?: FeatureLockOption;
  /** The second argument carries `run.lock` (`signal`, `fence`) when `lock` is declared. */
  readonly handler: (services: TServices, run: ScheduleRun) => unknown;
};

/** Defs that declare `lock`. */
type LockedDefs<D extends readonly unknown[]> = Extract<D[number], { readonly lock: FeatureLockOption }>;

/** A `lock:` schedule needs a `locks` service among the handler's services. */
type LockGuard<TServices, D extends readonly unknown[]> = [LockedDefs<D>] extends [never]
  ? unknown
  : TServices extends { readonly locks: Locker }
    ? unknown
    : {
        readonly 'SCHEDULE: a lock needs a `locks` service — add locks({ namespace, needs, store }) from @arki/lock/dot to the app .infra(), or need it as `locks`': never;
      };

/** The lock a def asks for, if any: the schedule name for `true`, the default hold unless it sets one. */
function lockPlanOf(def: { readonly name: string; readonly lock?: FeatureLockOption }): LockPlan | undefined {
  const option = def.lock;
  if (option === undefined) return undefined;
  const requested = typeof option === 'object' ? option.key : option === true ? undefined : option;
  const key = requested ?? def.name.trim();
  if (key.trim() === '') {
    throw new ScheduleError({
      code: SCHEDULE_ERROR_CODES.invalidDefinition,
      message: `[schedule] schedule "${def.name}" has an empty lock key.`,
      remediation: 'Use lock: true to lock on the schedule name, or give a non-empty key.',
    });
  }
  const holdAtLeast = typeof option === 'object' ? option.holdAtLeast : undefined;
  return {
    key,
    holdAtLeastMs: holdAtLeast === undefined ? DEFAULT_LOCK_HOLD_MS : lockDurationMs(holdAtLeast),
    ...(requested === undefined ? { byName: true } : {}),
  };
}

function isLocker(value: unknown): value is Locker {
  return typeof value === 'object' && value !== null && 'mutex' in value && typeof value.mutex === 'function';
}

/** The feature's `locks` service, read at boot — a missing one fails the boot, not the first tick. */
function locksOf(services: unknown, schedule: string): Locker {
  const locks: unknown = typeof services === 'object' && services !== null ? Reflect.get(services, 'locks') : undefined;
  if (!isLocker(locks)) {
    throw new ScheduleError({
      code: SCHEDULE_ERROR_CODES.lockServiceMissing,
      message: `[schedule] schedule "${schedule}" declares a lock, but its feature has no "locks" service.`,
      remediation:
        'Add locks({ namespace, needs, store }) from @arki/lock/dot to the app .infra(), or need it as `locks`.',
    });
  }
  return locks;
}

/**
 * The slice `schedules(needs, defs)` produces. `resolve` binds each
 * handler to the feature's services (the driver runs the closed handlers
 * and ignores its own context for them); `definitions` keeps the declared
 * objects so `composeSchedules` can read their names and result types.
 */
export type FeatureScheduleSlice<TDefs extends readonly FeatureScheduleOptions<never>[], TServices> = {
  readonly kind: 'schedules';
  readonly key: 'schedules';
  readonly actions: readonly ScheduleDotAction[];
  readonly resolve: (services: TServices) => readonly ScheduleDef<unknown>[];
  readonly definitions: TDefs;
};

function validateFeatureSchedule<TServices>(def: FeatureScheduleOptions<TServices>): ScheduleDef<TServices> {
  // The type already forbids it; this backstop catches callers that skip types.
  const durable: unknown = def.durable;
  if (durable === true) {
    throw new ScheduleError({
      code: SCHEDULE_ERROR_CODES.durableFeatureSchedule,
      message: `[schedule] feature schedule "${def.name}" cannot be durable.`,
      remediation:
        'A durable run happens in another process that does not hold the feature services. Drop durable: true, or declare the schedule with defineSchedule() and schedules([...]) on the driver context.',
    });
  }
  if (def.name !== def.name.trim()) {
    throw new ScheduleError({
      code: SCHEDULE_ERROR_CODES.invalidDefinition,
      message: `[schedule] feature schedule name "${def.name}" has leading or trailing spaces.`,
      remediation: 'Write the name exactly as callers will trigger it, without surrounding spaces.',
    });
  }
  return defineSchedule<TServices>({
    ...def,
    handler: (services, run) => Promise.resolve(def.handler(services, run)),
  });
}

function featureOwnedSchedules<TServices, const TDefs extends readonly FeatureScheduleOptions<TServices>[]>(
  defs: TDefs,
): FeatureScheduleSlice<TDefs, TServices> {
  // Validated at declaration, like defineSchedule(): a bad cron fails at import.
  const validated = defs.map(def => ({
    definition: validateFeatureSchedule<TServices>(def),
    lockPlan: lockPlanOf(def),
  }));
  return {
    kind: 'schedules',
    key: 'schedules',
    // The driver's clock is not known yet: a host-clock driver rewrites the unlocked text at configure.
    actions: validated.map(({ definition, lockPlan }) => actionForSchedule(definition, 'internal', lockPlan)),
    resolve: services =>
      validated.map(({ definition, lockPlan }) => ({
        ...definition,
        handler: (_context, run) => definition.handler(services, run),
        ...(lockPlan === undefined ? {} : { lock: boundLock(definition.name, lockPlan, services) }),
      })),
    definitions: defs,
  };
}

/** The plan joined to the feature's `locks` service. */
function boundLock(schedule: string, plan: LockPlan, services: unknown): NonNullable<ScheduleDef<unknown>['lock']> {
  const locks = locksOf(services, schedule);
  return { key: plan.key, holdAtLeastMs: plan.holdAtLeastMs, locks, ...(plan.byName === true ? { byName: true } : {}) };
}

function isScheduleDefList<TContext>(
  value: NeedsShape | AnyFeatureCore | readonly ScheduleDef<TContext>[],
): value is readonly ScheduleDef<TContext>[] {
  return Array.isArray(value);
}

/**
 * Declare a feature's in-process schedules as a boot-time slice
 * (`feature(..., { use: [schedules(...)] })`). The payload lands
 * under `schedules` in the feature's slice record — where the
 * `.serve(schedule(...))` driver collects it — and the derived actions
 * join the feature's manifest.
 *
 * - `schedules(defs)`: `defineSchedule(...)` results; handlers receive the
 *   driver's `context`.
 * - `schedules(core, defs)`: for a `defineFeature` feature, in its
 *   `.entrypoints(...)`. Handlers receive what the feature's entrypoints get —
 *   its needs, its private infra and `usecases` — typed from the core, so a
 *   schedules file of its own needs no annotation:
 *   `export const digestSchedules = (c: typeof core) => schedules(c, [{ name, cron, handler: ({ usecases }) => usecases.sendDue() }])`.
 * - `schedules(needs, defs)`: plain option objects whose handlers receive
 *   the services `needs` names. List the same services in the feature's
 *   `needs`; a missing one is a compile error. (Object-form features; the
 *   core form replaces it.)
 */
export function schedules<const TDefinitions extends readonly ScheduleDef<never>[]>(
  defs: TDefinitions,
): ScheduleFeatureSlice<TDefinitions>;
export function schedules<C extends AnyFeatureCore, const D extends readonly FeatureScheduleOptions<DepsOf<C>>[]>(
  core: C,
  defs: D & LockGuard<DepsOf<C>, D>,
): FeatureScheduleSlice<D, DepsOf<C>>;
export function schedules<N extends NeedsShape, const D extends readonly FeatureScheduleOptions<CtxOf<N>>[]>(
  needs: N,
  defs: D & LockGuard<CtxOf<N>, D>,
): FeatureScheduleSlice<D, CtxOf<N>>;
export function schedules<TContext, N extends NeedsShape, const D extends readonly FeatureScheduleOptions<CtxOf<N>>[]>(
  needsOrDefs: N | AnyFeatureCore | readonly ScheduleDef<TContext>[],
  defs?: D,
): ScheduleFeatureSlice<readonly ScheduleDef<TContext>[]> | FeatureScheduleSlice<D, CtxOf<N>> {
  if (isScheduleDefList(needsOrDefs)) {
    return {
      kind: 'schedules',
      key: 'schedules',
      actions: scheduleActions(needsOrDefs),
      resolve: () => needsOrDefs,
      definitions: needsOrDefs,
    };
  }
  // `needs` (or the core) is a type witness: the feature hands its own services to `resolve`.
  if (defs === undefined) {
    throw new ScheduleError({
      code: SCHEDULE_ERROR_CODES.invalidDefinition,
      message: '[schedule] schedules(needs, defs) was called without defs.',
      remediation: 'Pass the schedule list as the second argument: schedules(needs, [{ name, cron, handler }]).',
    });
  }
  return featureOwnedSchedules<CtxOf<N>, D>(defs);
}

function isScheduleList(value: unknown): value is readonly ScheduleDef<unknown>[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        typeof item === 'object' &&
        item !== null &&
        'name' in item &&
        typeof item.name === 'string' &&
        'handler' in item &&
        typeof item.handler === 'function',
    )
  );
}

/**
 * The schedules every bound feature declared, in mount order. The guard
 * checks shape only: each handler's context type is the app's contract
 * with its features, which the runtime cannot see (see the module docs).
 */
/** A collected schedule; `declaredName` is set on an instance's, whose name was qualified. */
type CollectedSchedule = ScheduleDef<unknown> & { readonly declaredName?: string };

function collectFeatureSchedules(ctx: object, features: readonly MountedFeature[]): readonly CollectedSchedule[] {
  const collected: CollectedSchedule[] = [];
  for (const f of features) {
    const defs = sliceOf(ctx, f)['schedules'];
    if (defs === undefined) continue;
    if (!isScheduleList(defs)) {
      throw new ScheduleError({
        code: SCHEDULE_ERROR_CODES.invalidDefinition,
        message: `[schedule] feature "${f.name}" published a "schedules" slice that is not a list of schedules.`,
        remediation:
          'Declare feature schedules with schedules([...]) or schedules(needs, [...]) from @arki/schedule/dot.',
      });
    }
    // Only an instance ('reports#eu') gets a qualified name; a plain feature's names, and the lock
    // keys hashed from them, must stay byte-identical.
    const instance = instanceOf(f.name);
    for (const def of defs) {
      if (instance === undefined) {
        collected.push(def);
        continue;
      }
      const name = `${def.name}#${instance}`;
      // A default lock key follows the name (own lock per instance); a custom key is shared on purpose.
      const lock =
        def.lock !== undefined && 'byName' in def.lock && def.lock.byName === true
          ? { ...def.lock, key: name }
          : def.lock;
      const qualified = { ...def, name, declaredName: def.name, ...(lock === undefined ? {} : { lock }) };
      collected.push(qualified);
    }
  }
  return collected;
}

/** The ids of a `schedules` slice's actions that declare no lock and are not durable. */
function unlockedActionIds(slice: AnyFeatureSlice): readonly string[] {
  if (!('actions' in slice) || !Array.isArray(slice.actions)) return [];
  return slice.actions.flatMap((action: unknown) =>
    typeof action === 'object' &&
    action !== null &&
    'id' in action &&
    typeof action.id === 'string' &&
    'summary' in action &&
    action.summary === noLockSummary('internal')
      ? [action.id]
      : [],
  );
}

function schedulerService(clock: ScheduleClock, names: readonly string[], runtime: ScheduleRuntime): ScheduleService {
  const known = new Set(names);
  return {
    clock,
    names,
    async trigger(name) {
      if (!known.has(name)) return { name, status: 'unknown' };
      return runtime.trigger(name);
    },
  };
}

/**
 * The scheduler driving adapter. See the module docs for the wiring. It
 * provides `scheduler` ({@link ScheduleService}) to the app.
 */
export function schedule<TDurable extends DurableSchedulesToken | undefined = undefined>(
  options: ScheduleNoContextOptions<TDurable>,
): Driver<DurableNeeds<TDurable>, SchedulerProvides>;
export function schedule<
  TContext,
  TNeeds extends NeedsShape & NoReservedKeys = EmptyShape,
  TDurable extends DurableSchedulesToken | undefined = undefined,
>(
  options: ScheduleOptions<TNeeds, TContext, TDurable>,
): Driver<WireNeeds<TNeeds> & DurableNeeds<TDurable>, SchedulerProvides>;
export function schedule<TNeeds extends NeedsShape & NoReservedKeys, TContext>(
  options: Omit<ScheduleOptions<TNeeds, TContext, DurableSchedulesToken | undefined>, 'context'> & {
    readonly context?: ScheduleOptions<TNeeds, TContext>['context'];
  },
): Driver<WireNeeds<TNeeds>, SchedulerProvides> {
  const own = options.schedules ?? [];
  const clock = options.clock ?? 'internal';
  const needs: NeedsShape & NoReservedKeys = {
    ...options.needs,
    ...(options.durable === undefined ? {} : { [DURABLE_ALIAS]: options.durable }),
  };
  const actions = scheduleActions(own, clock);

  return driver(features => {
    let runtime: ScheduleRuntime | undefined;
    return plugin({
      name: 'schedule',
      needs,
      // App-level schedules only: feature schedules already joined each
      // feature's manifest through their `schedules(...)` slice.
      actions,
      configure(ctx) {
        ctx.registerProjection({
          format: 'schedule-table',
          binding: 'schedule',
          module: '@arki/schedule/projection',
        });
        ctx.declareProvides('schedule-runtime');
        if (clock === 'host') {
          // Feature schedules declared before the driver knew its clock: fix the unlocked warning.
          for (const f of features) {
            for (const slice of entrypointsOf(f)) {
              for (const action of slice.key === 'schedules' ? unlockedActionIds(slice) : []) {
                ctx.describeAction(action, { summary: noLockSummary(clock) });
              }
            }
          }
        }
      },
      provides: {
        scheduler: ctx => {
          const durable = durableBackend(ctx);
          const all: readonly (ScheduleDef<TContext> & { readonly declaredName?: string })[] = [
            ...own,
            ...collectFeatureSchedules(ctx, features),
          ];
          for (const definition of all) {
            const lock = definition.lock;
            // A locker that can say its store lets the action show the whole line: `dot doctor` prints it.
            if (lock?.locks.store === undefined) continue;
            ctx.$describeAction(`${definition.declaredName ?? definition.name}.fire`, {
              summary: lockSummary({
                key: lock.key,
                holdAtLeastMs: lock.holdAtLeastMs ?? DEFAULT_LOCK_HOLD_MS,
                locks: lock.locks,
              }),
            });
          }
          assertSingleClock(all, durable, clock);
          assertDurableBackend(all, durable);
          const shared = {
            clock,
            ...(options.jitterMs === undefined ? {} : { jitterMs: options.jitterMs }),
            ...(durable === undefined ? {} : { durable }),
          };
          const context = options.context;
          const created =
            context === undefined
              ? createScheduleRuntime({
                  // Erasure seam: public overloads only allow missing context for `TContext = undefined`.
                  schedules: all as readonly ScheduleDef<undefined>[],
                  ...shared,
                })
              : createScheduleRuntime<TContext>({
                  schedules: all,
                  ...shared,
                  createContext: () => context(ctx as CtxOf<TNeeds>),
                });
          runtime = created;
          return schedulerService(
            clock,
            all.map(definition => definition.name),
            created,
          );
        },
      },
      start() {
        runtime?.start();
      },
      async stop() {
        await runtime?.stop();
      },
      async dispose() {
        await runtime?.stop();
        runtime = undefined;
      },
      // Erasure seam: the needs record is runtime-built (own needs + the
      // optional durable alias); the overloads carry the precise shape.
    }) as unknown as Plugin<WireNeeds<TNeeds>, SchedulerProvides>;
  });
}

/* ------------------------------------------------------------------ */
/* Typed client                                                        */
/* ------------------------------------------------------------------ */

/** A feature's declarations, either form: a chain feature's `entrypoints`, an object-form feature's `use`. */
type DeclarationsOf<F> = F extends { readonly entrypoints: readonly (infer TSlice)[] }
  ? TSlice
  : F extends { readonly use: readonly (infer TSlice)[] }
    ? TSlice
    : never;

/** The option objects every `schedules(needs | core, defs)` declaration of one feature lists. */
type FeatureScheduleDefsOf<F> =
  DeclarationsOf<F> extends infer TSlice
    ? TSlice extends {
        readonly key: 'schedules';
        readonly definitions: readonly (infer TDef extends Pick<FeatureScheduleOptions<never>, 'name' | 'handler'>)[];
      }
      ? TDef
      : never
    : never;

/**
 * A feature and every feature nested under it (`.features(...)`), as a
 * union. Bounded to eight levels, so a loosely typed list
 * (`readonly MountedFeature[]`) cannot recurse without end.
 */
type FeatureTreeOf<F, TDepth extends readonly unknown[] = []> = TDepth['length'] extends 8
  ? F
  : F | (F extends { readonly features: readonly (infer TChild)[] } ? FeatureTreeOf<TChild, [...TDepth, 1]> : never);

/** The instance of a mounted feature name: `reports#eu` and `reports#eu.audit` give `eu`. */
type InstanceSegmentOf<TName> = TName extends `${string}#${infer TRest}`
  ? TRest extends `${infer THead}.${string}`
    ? THead
    : TRest
  : never;

/** The name a schedule is registered under: qualified only when its feature is an instance. */
type RegisteredName<F, TName extends string> = [
  InstanceSegmentOf<F extends { readonly name: infer N } ? N : never>,
] extends [never]
  ? TName
  : `${TName}#${InstanceSegmentOf<F extends { readonly name: infer N } ? N : never>}`;

/** Every feature-owned schedule name the feature tuple declares, nested children included, as registered. */
export type ScheduleNameOf<TFeatures extends readonly MountedFeature[]> =
  FeatureTreeOf<TFeatures[number]> extends infer F
    ? F extends unknown
      ? RegisteredName<F, FeatureScheduleDefsOf<F>['name']>
      : never
    : never;

/** The resolved value of the handler named `TName`. */
export type ScheduleValueOf<TFeatures extends readonly MountedFeature[], TName extends string> =
  FeatureTreeOf<TFeatures[number]> extends infer F
    ? F extends unknown
      ? FeatureScheduleDefsOf<F> extends infer TDef
        ? TDef extends {
            readonly name: infer N extends string;
            readonly handler: (services: never, run: ScheduleRun) => infer TResult;
          }
          ? RegisteredName<F, N> extends TName
            ? Awaited<TResult>
            : never
          : never
        : never
      : never
    : never;

/** Successful values and returned failures inferred from the named handler. */
export type ScheduleSuccessOf<TFeatures extends readonly MountedFeature[], TName extends string> = SuccessOf<
  () => ScheduleValueOf<TFeatures, TName>
>;
export type ScheduleFailureOf<TFeatures extends readonly MountedFeature[], TName extends string> = ScheduleRefusal<
  ScheduleValueOf<TFeatures, TName>
>;

/** A `scheduler` service typed from the features' own schedule declarations. */
export type ScheduleClient<TFeatures extends readonly MountedFeature[]> = {
  trigger<TName extends ScheduleNameOf<TFeatures>>(
    name: TName,
  ): Promise<ScheduleOutcome<ScheduleValueOf<TFeatures, TName>>>;
};

/** The names a `schedules(needs, defs)` slice declared; `[]` for any other slice. */
function declaredNames(slice: AnyFeatureSlice): readonly string[] {
  if (slice.key !== 'schedules' || !('definitions' in slice) || !Array.isArray(slice.definitions)) return [];
  return slice.definitions.flatMap((definition: unknown) =>
    typeof definition === 'object' && definition !== null && 'name' in definition && typeof definition.name === 'string'
      ? [definition.name]
      : [],
  );
}

/**
 * A typed client over the `scheduler` service: `trigger` accepts only the
 * names the features declared with `schedules(needs | core, defs)` — object-form
 * and chain features alike, nested children included — and a `ran`
 * outcome's `value` is that handler's resolved return type. Throws a coded
 * error when the scheduler does not run one of those schedules (the
 * features were not mounted on this app).
 *
 * ```ts
 * const schedules = composeSchedules(features, app.services.scheduler);
 * const outcome = await schedules.trigger('send-digest');
 * ```
 */
export function composeSchedules<const TFeatures extends readonly MountedFeature[]>(
  features: TFeatures,
  scheduler: ScheduleService,
): ScheduleClient<TFeatures> {
  const served = new Set(scheduler.names);
  for (const f of allFeatures(features)) {
    const instance = instanceOf(f.name);
    for (const declared of entrypointsOf(f).flatMap(slice => declaredNames(slice))) {
      const name = instance === undefined ? declared : `${declared}#${instance}`;
      if (served.has(name)) continue;
      throw new ScheduleError({
        code: SCHEDULE_ERROR_CODES.scheduleNotServed,
        message: `[schedule] feature "${f.name}" declares schedule "${name}", but the scheduler does not run it.`,
        remediation:
          'Pass the same features the app mounts with .features([...]), and the scheduler of an app that serves schedule(...).',
      });
    }
  }
  return {
    trigger<TName extends ScheduleNameOf<TFeatures>>(name: TName) {
      // Erasure seam: the scheduler service is untyped at runtime; the
      // feature tuple carries each handler's result type for this name.
      return scheduler.trigger(name) as Promise<ScheduleOutcome<ScheduleValueOf<TFeatures, TName>>>;
    },
  };
}

export type { ScheduleClock, ScheduleOutcome, ScheduleRuntime } from './runtime.js';

export { SCHEDULE_ACTION_META_SCHEMA } from './action-meta.js';
