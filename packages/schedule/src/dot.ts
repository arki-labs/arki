import type { CtxOf, EmptyShape, NeedsShape, Plugin, Token, WireNeeds } from '@arki/dot/plugin';
import { plugin, token } from '@arki/dot/plugin';

import type { ScheduleDef } from './index.js';
import type { DurableScheduler, KvLike, ScheduleRuntime } from './runtime.js';
import { assertDurableBackend, createScheduleRuntime } from './runtime.js';

export const SCHEDULE_ACTION_META_SCHEMA = '@arki/schedule/action-meta@1';

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

export type ScheduleDotOptions = {
  readonly schedules: readonly ScheduleDef[];
  readonly lock?: KvLike;
  readonly jitterMs?: number;
};

type NoReservedKeys = Readonly<Record<`$${string}`, never>>;

/**
 * The durable backend service. `durableScheduler()` from `@arki/queue/dot`
 * provides it under this key; `schedule({ durable: DurableSchedules })`
 * needs it, so the app builder rejects the app when no provider is mounted.
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

export type ScheduleFeatureToken<TContext = undefined> = Token<
  { readonly schedules?: readonly ScheduleDef<TContext>[] },
  string
>;

type AnyScheduleFeatureToken = Token<object, string>;

type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (value: infer TIntersection) => void
  ? TIntersection
  : never;

type ScheduleContextsFromSlice<TSlice> = TSlice extends {
  readonly schedules?: readonly (infer TSchedule)[];
}
  ? TSchedule extends ScheduleDef<infer TContext>
    ? TContext
    : never
  : undefined;

type ScheduleContextFromUnion<TContext> = [Exclude<TContext, undefined>] extends [never]
  ? undefined
  : UnionToIntersection<Exclude<TContext, undefined>>;

// Naked-parameter wrapper so payload extraction DISTRIBUTES over the
// token union — tokens now carry per-feature payload types, and a
// single non-distributive inference across differing payloads collapses
// to a useless common supertype.
type SliceOfToken<TTok> = TTok extends Token<infer TSlice, string> ? TSlice : never;

type ScheduleFeatureContext<TFeatures extends readonly AnyScheduleFeatureToken[]> = [
  TFeatures[number],
] extends [never]
  ? undefined
  : ScheduleContextFromUnion<ScheduleContextsFromSlice<SliceOfToken<TFeatures[number]>>>;

export type ScheduleFeatureNeeds<TFeatures extends readonly AnyScheduleFeatureToken[]> = {
  readonly [Tok in TFeatures[number] as Tok extends Token<unknown, infer K> ? K : never]: Tok extends Token<
    infer TSlice,
    string
  >
    ? TSlice
    : never;
};

type ScheduleBaseOptions<TContext> = {
  readonly schedules: readonly ScheduleDef<TContext>[];
  readonly lock?: KvLike;
  readonly jitterMs?: number;
};

type ScheduleDurableOption<TDurable extends DurableSchedulesToken | undefined> = {
  /** Pass `DurableSchedules` to run `durable: true` schedules on the mounted durable backend. */
  readonly durable?: TDurable;
};

type ScheduleContextOption<TNeeds extends NeedsShape, TContext> =
  | {
      readonly context: (services: CtxOf<TNeeds>) => TContext | Promise<TContext>;
    }
  | ([TContext] extends [undefined]
      ? {
          readonly context?: (services: CtxOf<TNeeds>) => TContext | Promise<TContext>;
        }
      : never);

export type ScheduleDirectOptions<
  TNeeds extends NeedsShape & NoReservedKeys,
  TContext,
  TDurable extends DurableSchedulesToken | undefined = undefined,
> =
  & ScheduleBaseOptions<TContext>
  & ScheduleContextOption<TNeeds, TContext>
  & ScheduleDurableOption<TDurable>
  & {
    readonly needs: TNeeds;
  };

export type ScheduleDirectNoNeedsOptions<TContext, TDurable extends DurableSchedulesToken | undefined = undefined> =
  & ScheduleBaseOptions<TContext>
  & ScheduleContextOption<EmptyShape, TContext>
  & ScheduleDurableOption<TDurable>
  & {
    readonly needs?: never;
  };

export type ScheduleFeatureOptions<
  TNeeds extends NeedsShape & NoReservedKeys,
  TFeatures extends readonly AnyScheduleFeatureToken[],
  TDurable extends DurableSchedulesToken | undefined = undefined,
> =
  & Omit<ScheduleBaseOptions<ScheduleFeatureContext<TFeatures>>, 'schedules'>
  & ScheduleContextOption<TNeeds, ScheduleFeatureContext<TFeatures>>
  & ScheduleDurableOption<TDurable>
  & {
    readonly features: TFeatures;
    readonly needs?: TNeeds;
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

/** The `@arki/feature` slice contract a `schedules(...)` declaration produces. */
export type ScheduleFeatureSlice<TContext> = {
  readonly key: 'schedules';
  readonly actions: readonly ScheduleDotAction[];
  readonly resolve: (services: unknown) => readonly ScheduleDef<TContext>[];
};

/**
 * Declare a feature's in-process schedules as a boot-time slice
 * (`defineFeature(..., { use: [schedules(defs)] })`). The payload lands
 * under `schedules` in the feature's slice token — where
 * `schedule({ features })` collects it — and the derived actions join
 * the feature's manifest.
 */
export function schedules<TContext>(defs: readonly ScheduleDef<TContext>[]): ScheduleFeatureSlice<TContext> {
  return { key: 'schedules', actions: scheduleActions(defs), resolve: () => defs };
}

function collectFeatureSchedules<TContext>(
  features: readonly AnyScheduleFeatureToken[],
  record: Readonly<Record<string, { readonly schedules?: readonly ScheduleDef<TContext>[] } | undefined>>,
): readonly ScheduleDef<TContext>[] {
  const schedules: ScheduleDef<TContext>[] = [];
  for (const feature of features) {
    const slice = record[feature.key];
    if (slice?.schedules !== undefined) {
      schedules.push(...slice.schedules);
    }
  }
  return schedules;
}

export function schedule<TContext = undefined, TDurable extends DurableSchedulesToken | undefined = undefined>(
  options: ScheduleDirectNoNeedsOptions<TContext, TDurable>,
): Plugin<DurableNeeds<TDurable>, EmptyShape>;
export function schedule<
  TNeeds extends NeedsShape & NoReservedKeys,
  TContext = undefined,
  TDurable extends DurableSchedulesToken | undefined = undefined,
>(
  options: ScheduleDirectOptions<TNeeds, TContext, TDurable>,
): Plugin<WireNeeds<TNeeds> & DurableNeeds<TDurable>, EmptyShape>;
export function schedule<
  TNeeds extends NeedsShape & NoReservedKeys,
  const TFeatures extends readonly AnyScheduleFeatureToken[],
  TDurable extends DurableSchedulesToken | undefined = undefined,
>(
  options: ScheduleFeatureOptions<TNeeds, TFeatures, TDurable>,
): Plugin<WireNeeds<TNeeds> & ScheduleFeatureNeeds<TFeatures> & DurableNeeds<TDurable>, EmptyShape>;
export function schedule<
  TNeeds extends NeedsShape & NoReservedKeys,
  TContext,
  const TFeatures extends readonly AnyScheduleFeatureToken[],
>(
  options:
    | ScheduleDirectNoNeedsOptions<TContext, DurableSchedulesToken | undefined>
    | ScheduleDirectOptions<TNeeds, TContext, DurableSchedulesToken | undefined>
    | ScheduleFeatureOptions<TNeeds, TFeatures, DurableSchedulesToken | undefined>,
): Plugin<WireNeeds<TNeeds>, EmptyShape> {
  let runtime: ScheduleRuntime | undefined;
  const featureMode = 'features' in options;
  const needs =
    options.needs === undefined
      ? {}
      : options.needs;
  const durableNeeds: NeedsShape = options.durable === undefined ? {} : { [DURABLE_ALIAS]: options.durable };
  const runtimeNeeds = featureMode
    ? {
        ...needs,
        ...durableNeeds,
        ...Object.fromEntries(options.features.map(feature => [feature.key, feature])),
      }
    : { ...needs, ...durableNeeds };

  return plugin({
    name: 'schedule',
    version: '0.0.1',
    needs: runtimeNeeds,
    actions: featureMode ? [] : scheduleActions(options.schedules, { locked: options.lock !== undefined }),
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
      if (featureMode) {
        type FeatureContext = ScheduleFeatureContext<TFeatures>;
        const schedules = collectFeatureSchedules<FeatureContext>(
          options.features,
          ctx as Readonly<Record<string, { readonly schedules?: readonly ScheduleDef<FeatureContext>[] } | undefined>>,
        );
        assertDurableBackend(schedules, durable);
        const context = options.context;
        if (context === undefined) {
          runtime = createScheduleRuntime({
            // Erasure seam: public overloads only allow missing context for `TContext = undefined`.
            schedules: schedules as readonly ScheduleDef<undefined>[],
            ...(options.lock === undefined ? {} : { lock: options.lock }),
            ...(options.jitterMs === undefined ? {} : { jitterMs: options.jitterMs }),
            ...(durable === undefined ? {} : { durable }),
          });
          return;
        }

        runtime = createScheduleRuntime<FeatureContext>({
          schedules,
          ...(options.lock === undefined ? {} : { lock: options.lock }),
          ...(options.jitterMs === undefined ? {} : { jitterMs: options.jitterMs }),
          ...(durable === undefined ? {} : { durable }),
          createContext: () => context(ctx as CtxOf<TNeeds>),
        });
        return;
      }

      const schedules = options.schedules;
      assertDurableBackend(schedules, durable);
      const context = options.context;
      if (context === undefined) {
        runtime = createScheduleRuntime({
          // Erasure seam: public overloads only allow missing context for `TContext = undefined`.
          schedules: schedules as readonly ScheduleDef<undefined>[],
          ...(options.lock === undefined ? {} : { lock: options.lock }),
          ...(options.jitterMs === undefined ? {} : { jitterMs: options.jitterMs }),
          ...(durable === undefined ? {} : { durable }),
        });
        return;
      }

      runtime = createScheduleRuntime<TContext>({
        schedules,
        ...(options.lock === undefined ? {} : { lock: options.lock }),
        ...(options.jitterMs === undefined ? {} : { jitterMs: options.jitterMs }),
        ...(durable === undefined ? {} : { durable }),
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
  }) as unknown as Plugin<WireNeeds<TNeeds>, EmptyShape>;
}

export type { KvLike, ScheduleRuntime } from './runtime.js';
