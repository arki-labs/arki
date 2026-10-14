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
 *   .features([billing, reports])           // each declares `use: [schedules(defs)]`
 *   .serve(schedule({ needs: { db: service<Db>() }, context: ({ db }) => ({ db }) }));
 * ```
 *
 * `context` builds the one value every handler receives — feature and
 * app-level schedules alike. The features are bound at runtime, so the
 * compiler cannot check that their schedules expect this context: keep
 * one context type per app (e.g. via `initSchedule.context<Ctx>()`).
 */

import type { AnyFeature, Driver } from '@arki/dot/feature';
import type { CtxOf, EmptyShape, NeedsShape, Plugin, WireNeeds } from '@arki/dot/plugin';
import { driver, sliceOf } from '@arki/dot/feature';
import { plugin, token } from '@arki/dot/plugin';

import type { ScheduleDef } from './index.js';
import { ScheduleError, SCHEDULE_ERROR_CODES } from './errors.js';
import type { DurableScheduler, KvLike, ScheduleRuntime } from './runtime.js';
import { assertDurableBackend, createScheduleRuntime } from './runtime.js';

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
};

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
  readonly key: 'schedules';
  readonly actions: readonly ScheduleDotAction[];
  readonly resolve: (services: unknown) => readonly ScheduleDef<TContext>[];
};

/**
 * Declare a feature's in-process schedules as a boot-time slice
 * (`feature(..., { use: [schedules(defs)] })`). The payload lands
 * under `schedules` in the feature's slice record — where the
 * `.serve(schedule(...))` driver collects it — and the derived actions
 * join the feature's manifest.
 */
export function schedules<TContext>(defs: readonly ScheduleDef<TContext>[]): ScheduleFeatureSlice<TContext> {
  return { key: 'schedules', actions: scheduleActions(defs), resolve: () => defs };
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
function featureSchedules(ctx: object, features: readonly AnyFeature[]): readonly ScheduleDef<unknown>[] {
  const collected: ScheduleDef<unknown>[] = [];
  for (const f of features) {
    const defs = sliceOf(ctx, f)['schedules'];
    if (defs === undefined) continue;
    if (!isScheduleList(defs)) {
      throw new ScheduleError({
        code: SCHEDULE_ERROR_CODES.invalidDefinition,
        message: `[schedule] feature "${f.name}" published a "schedules" slice that is not a list of schedules.`,
        remediation: 'Declare feature schedules with schedules([...]) from @arki/schedule/dot, built by defineSchedule().',
      });
    }
    collected.push(...defs);
  }
  return collected;
}

/** The scheduler driving adapter. See the module docs for the wiring. */
export function schedule<TDurable extends DurableSchedulesToken | undefined = undefined>(
  options: ScheduleNoContextOptions<TDurable>,
): Driver<DurableNeeds<TDurable>, EmptyShape>;
export function schedule<
  TContext,
  TNeeds extends NeedsShape & NoReservedKeys = EmptyShape,
  TDurable extends DurableSchedulesToken | undefined = undefined,
>(options: ScheduleOptions<TNeeds, TContext, TDurable>): Driver<WireNeeds<TNeeds> & DurableNeeds<TDurable>, EmptyShape>;
export function schedule<TNeeds extends NeedsShape & NoReservedKeys, TContext>(
  options: Omit<ScheduleOptions<TNeeds, TContext, DurableSchedulesToken | undefined>, 'context'> & {
    readonly context?: ScheduleOptions<TNeeds, TContext>['context'];
  },
): Driver<WireNeeds<TNeeds>, EmptyShape> {
  const own = options.schedules ?? [];
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
      boot(ctx) {
        const durable = durableBackend(ctx);
        const all: readonly ScheduleDef<TContext>[] = [...own, ...featureSchedules(ctx, features)];
        assertDurableBackend(all, durable);
        const shared = {
          ...(options.lock === undefined ? {} : { lock: options.lock }),
          ...(options.jitterMs === undefined ? {} : { jitterMs: options.jitterMs }),
          ...(durable === undefined ? {} : { durable }),
        };
        const context = options.context;
        if (context === undefined) {
          runtime = createScheduleRuntime({
            // Erasure seam: public overloads only allow missing context for `TContext = undefined`.
            schedules: all as readonly ScheduleDef<undefined>[],
            ...shared,
          });
          return;
        }
        runtime = createScheduleRuntime<TContext>({
          schedules: all,
          ...shared,
          createContext: () => context(ctx as CtxOf<TNeeds>),
        });
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
    }) as unknown as Plugin<WireNeeds<TNeeds>, EmptyShape>;
  });
}

export type { KvLike, ScheduleRuntime } from './runtime.js';
