import type { CtxOf, EmptyShape, NeedsShape, Plugin, Token, WireNeeds } from '@arki/dot/plugin';
import { plugin } from '@arki/dot/plugin';

import type { ScheduleDef } from './index.js';
import type { KvLike, ScheduleRuntime } from './runtime.js';
import { createScheduleRuntime } from './runtime.js';

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

type ScheduleContextOption<TNeeds extends NeedsShape, TContext> =
  | {
      readonly context: (services: CtxOf<TNeeds>) => TContext | Promise<TContext>;
    }
  | ([TContext] extends [undefined]
      ? {
          readonly context?: (services: CtxOf<TNeeds>) => TContext | Promise<TContext>;
        }
      : never);

export type ScheduleDirectOptions<TNeeds extends NeedsShape & NoReservedKeys, TContext> =
  & ScheduleBaseOptions<TContext>
  & ScheduleContextOption<TNeeds, TContext>
  & {
    readonly needs: TNeeds;
  };

export type ScheduleDirectNoNeedsOptions<TContext> =
  & ScheduleBaseOptions<TContext>
  & ScheduleContextOption<EmptyShape, TContext>
  & {
    readonly needs?: never;
  };

export type ScheduleFeatureOptions<
  TNeeds extends NeedsShape & NoReservedKeys,
  TFeatures extends readonly AnyScheduleFeatureToken[],
> =
  & Omit<ScheduleBaseOptions<ScheduleFeatureContext<TFeatures>>, 'schedules'>
  & ScheduleContextOption<TNeeds, ScheduleFeatureContext<TFeatures>>
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

export function schedule<TContext = undefined>(
  options: ScheduleDirectNoNeedsOptions<TContext>,
): Plugin<EmptyShape, EmptyShape>;
export function schedule<TNeeds extends NeedsShape & NoReservedKeys, TContext = undefined>(
  options: ScheduleDirectOptions<TNeeds, TContext>,
): Plugin<WireNeeds<TNeeds>, EmptyShape>;
export function schedule<
  TNeeds extends NeedsShape & NoReservedKeys,
  const TFeatures extends readonly AnyScheduleFeatureToken[],
>(
  options: ScheduleFeatureOptions<TNeeds, TFeatures>,
): Plugin<WireNeeds<TNeeds> & ScheduleFeatureNeeds<TFeatures>, EmptyShape>;
export function schedule<
  TNeeds extends NeedsShape & NoReservedKeys,
  TContext,
  const TFeatures extends readonly AnyScheduleFeatureToken[],
>(
  options:
    | ScheduleDirectNoNeedsOptions<TContext>
    | ScheduleDirectOptions<TNeeds, TContext>
    | ScheduleFeatureOptions<TNeeds, TFeatures>,
): Plugin<WireNeeds<TNeeds>, EmptyShape> {
  let runtime: ScheduleRuntime | undefined;
  const featureMode = 'features' in options;
  const needs =
    options.needs === undefined
      ? {}
      : options.needs;
  const runtimeNeeds = featureMode
    ? {
        ...needs,
        ...Object.fromEntries(options.features.map(feature => [feature.key, feature])),
      }
    : needs;

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
      if (featureMode) {
        type FeatureContext = ScheduleFeatureContext<TFeatures>;
        const schedules = collectFeatureSchedules<FeatureContext>(
          options.features,
          ctx as Readonly<Record<string, { readonly schedules?: readonly ScheduleDef<FeatureContext>[] } | undefined>>,
        );
        const context = options.context;
        if (context === undefined) {
          runtime = createScheduleRuntime({
            // Erasure seam: public overloads only allow missing context for `TContext = undefined`.
            schedules: schedules as readonly ScheduleDef<undefined>[],
            ...(options.lock === undefined ? {} : { lock: options.lock }),
            ...(options.jitterMs === undefined ? {} : { jitterMs: options.jitterMs }),
          });
          return;
        }

        runtime = createScheduleRuntime<FeatureContext>({
          schedules,
          ...(options.lock === undefined ? {} : { lock: options.lock }),
          ...(options.jitterMs === undefined ? {} : { jitterMs: options.jitterMs }),
          createContext: () => context(ctx as CtxOf<TNeeds>),
        });
        return;
      }

      const schedules = options.schedules;
      const context = options.context;
      if (context === undefined) {
        runtime = createScheduleRuntime({
          // Erasure seam: public overloads only allow missing context for `TContext = undefined`.
          schedules: schedules as readonly ScheduleDef<undefined>[],
          ...(options.lock === undefined ? {} : { lock: options.lock }),
          ...(options.jitterMs === undefined ? {} : { jitterMs: options.jitterMs }),
        });
        return;
      }

      runtime = createScheduleRuntime<TContext>({
        schedules,
        ...(options.lock === undefined ? {} : { lock: options.lock }),
        ...(options.jitterMs === undefined ? {} : { jitterMs: options.jitterMs }),
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
