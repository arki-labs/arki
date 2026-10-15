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
import { driver, entrypointsOf, sliceOf } from '@arki/dot/feature';
import { plugin, token } from '@arki/dot/plugin';

import type { ScheduleDef, ScheduleInterval, ScheduleOverlap } from './index.js';
import { ScheduleError, SCHEDULE_ERROR_CODES } from './errors.js';
import { defineSchedule } from './index.js';
import type { DurableScheduler, KvLike, ScheduleClock, ScheduleOutcome, ScheduleRuntime } from './runtime.js';
import { assertDurableBackend, assertSingleClock, createScheduleRuntime } from './runtime.js';

import { SCHEDULE_ACTION_META_SCHEMA } from './action-meta.js';

export { SCHEDULE_ACTION_META_SCHEMA };

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
  readonly lock?: KvLike;
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
  & ScheduleBaseOptions<undefined>
  & ScheduleDurableOption<TDurable>
  & {
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
> =
  & ScheduleBaseOptions<TContext>
  & ScheduleDurableOption<TDurable>
  & {
    readonly needs?: TNeeds;
    readonly context: (services: CtxOf<TNeeds>) => TContext | Promise<TContext>;
  };

function actionForSchedule<TContext>(schedule: ScheduleDef<TContext>, locked: boolean): ScheduleDotAction {
  const kind = schedule.cron === undefined ? 'every' : 'cron';
  const address = schedule.cron ?? schedule.every ?? '';
  return {
    id: `${schedule.name}.fire`,
    binding: 'schedule',
    direction: 'in',
    address,
    metaSchema: SCHEDULE_ACTION_META_SCHEMA,
    meta: {
      kind,
      ...(schedule.cron === undefined ? {} : { cron: schedule.cron }),
      ...(schedule.every === undefined ? {} : { every: schedule.every }),
      ...(schedule.timezone === undefined ? {} : { timezone: schedule.timezone }),
      overlap: schedule.overlap,
      locked,
      durable: schedule.durable,
    },
  };
}

export function scheduleActions<TContext>(
  schedules: readonly ScheduleDef<TContext>[],
  options: { readonly locked?: boolean } = {},
): readonly ScheduleDotAction[] {
  return schedules.map(definition => actionForSchedule(definition, options.locked ?? false));
}

/** The `@arki/dot/feature` slice contract a `schedules(...)` declaration produces. */
export type ScheduleFeatureSlice<TContext> = {
  /** Lets a `defineFeature` feature list it in `.entrypoints(...)`; object-form features ignore it. */
  readonly kind: 'schedules';
  readonly key: 'schedules';
  readonly actions: readonly ScheduleDotAction[];
  readonly resolve: (services: unknown) => readonly ScheduleDef<TContext>[];
};

/** Exactly one of `cron` or `every`. */
type FeatureScheduleTiming =
  | { readonly cron: string; readonly every?: never }
  | { readonly every: ScheduleInterval; readonly cron?: never };

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
  readonly handler: (services: TServices) => unknown;
};

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
  return defineSchedule<TServices>({ ...def, handler: services => Promise.resolve(def.handler(services)) });
}

function featureOwnedSchedules<TServices, const TDefs extends readonly FeatureScheduleOptions<TServices>[]>(
  defs: TDefs,
): FeatureScheduleSlice<TDefs, TServices> {
  // Validated at declaration, like defineSchedule(): a bad cron fails at import.
  const validated = defs.map(def => validateFeatureSchedule<TServices>(def));
  return {
    kind: 'schedules',
    key: 'schedules',
    actions: scheduleActions(validated),
    resolve: services =>
      validated.map(definition => ({ ...definition, handler: () => definition.handler(services) })),
    definitions: defs,
  };
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
export function schedules<TContext>(defs: readonly ScheduleDef<TContext>[]): ScheduleFeatureSlice<TContext>;
export function schedules<C extends AnyFeatureCore, const D extends readonly FeatureScheduleOptions<DepsOf<C>>[]>(
  core: C,
  defs: D,
): FeatureScheduleSlice<D, DepsOf<C>>;
export function schedules<N extends NeedsShape, const D extends readonly FeatureScheduleOptions<CtxOf<N>>[]>(
  needs: N,
  defs: D,
): FeatureScheduleSlice<D, CtxOf<N>>;
export function schedules<
  TContext,
  N extends NeedsShape,
  const D extends readonly FeatureScheduleOptions<CtxOf<N>>[],
>(
  needsOrDefs: N | AnyFeatureCore | readonly ScheduleDef<TContext>[],
  defs?: D,
): ScheduleFeatureSlice<TContext> | FeatureScheduleSlice<D, CtxOf<N>> {
  if (isScheduleDefList(needsOrDefs)) {
    return { kind: 'schedules', key: 'schedules', actions: scheduleActions(needsOrDefs), resolve: () => needsOrDefs };
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
function collectFeatureSchedules(ctx: object, features: readonly MountedFeature[]): readonly ScheduleDef<unknown>[] {
  const collected: ScheduleDef<unknown>[] = [];
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
    collected.push(...defs);
  }
  return collected;
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
  const actions = scheduleActions(own, { locked: options.lock !== undefined });

  return driver(features => {
    let runtime: ScheduleRuntime | undefined;
    return plugin({
      name: 'schedule',
      version: '0.0.1',
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
      },
      provides: {
        scheduler: ctx => {
          const durable = durableBackend(ctx);
          const all: readonly ScheduleDef<TContext>[] = [...own, ...collectFeatureSchedules(ctx, features)];
          assertSingleClock(all, durable, clock);
          assertDurableBackend(all, durable);
          const shared = {
            clock,
            ...(options.lock === undefined ? {} : { lock: options.lock }),
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
          return schedulerService(clock, all.map(definition => definition.name), created);
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
        readonly definitions: readonly (infer TDef extends FeatureScheduleOptions<never>)[];
      }
      ? TDef
      : never
    : never;

/** Every feature-owned schedule name the feature tuple declares. */
export type ScheduleNameOf<TFeatures extends readonly MountedFeature[]> = FeatureScheduleDefsOf<
  TFeatures[number]
>['name'];

/** The resolved value of the handler named `TName`. */
export type ScheduleValueOf<TFeatures extends readonly MountedFeature[], TName extends string> =
  FeatureScheduleDefsOf<TFeatures[number]> extends infer TDef
    ? TDef extends { readonly name: TName; readonly handler: (services: never) => infer TResult }
      ? Awaited<TResult>
      : never
    : never;

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
 * and chain features alike — and a `ran`
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
  for (const f of features) {
    for (const name of entrypointsOf(f).flatMap(slice => declaredNames(slice))) {
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

export type { KvLike, ScheduleClock, ScheduleOutcome, ScheduleRuntime } from './runtime.js';
