/**
 * `@arki/dot` adapter, in two parts:
 *
 * - `journal(...)` is the driven part, for `.use()`. It publishes `services.journal`, so
 *   features can write through it. With `{ j, tables }` it composes the journal from the
 *   features' `journalHandlers` declarations. It reads them from the feature values, so it
 *   boots before the features.
 * - `journalWorker(...)` is the driving part, for `.serve()`. It runs the effects, taps and
 *   async projections between `start` and `stop`. It gives each effect and tap the services
 *   of the feature that lists it.
 *
 * The split works because writes never need an effect's services: a write only queues
 * the effect's job. Inline projections run inside the write, and they get only the
 * transaction. So the journal is composed with `services: 'worker'`, and the worker
 * gives the services when it runs a handler.
 *
 * A `defineFeature` feature declares the same handlers by layer, and the journal folds
 * them back into one declaration per feature before anything boots:
 *
 * - `journalProjections(...)` in `.infra(...)`: projections maintain the feature's read
 *   models, so they sit with its other infra.
 * - `journalEffects(core, { effects, taps })` in `.entrypoints(...)`: effects and taps
 *   are ways the feature is reached (by an event instead of a request).
 *
 * The app's `db` plugin must publish the root Drizzle database under the `db` key.
 * `@arki/dot` is an optional peer. Import this module only inside a Dot app.
 */
import type { z } from 'zod';

import type { AnyFeatureCore, DepsOf, Driven, Driver, MountedFeature } from '@arki/dot/feature';
import type { ActionSource, CtxOf, EmptyShape, NeedsShape, Plugin, Service, WireNeeds } from '@arki/dot/plugin';
import { driven, driver, entrypointsOf, ownUnits, sliceOf } from '@arki/dot/feature';
import { DotPluginError, plugin, service } from '@arki/dot/plugin';

import type { Journal, JournalDefinitions } from './api.js';
import type { JournalTables } from './pg.js';
import type {
  DbHandle,
  Effect,
  HandlerServices,
  JobRunner,
  JournalWorker,
  Needs,
  Projection,
  RootDb,
  Services,
  ServicesFor,
  Tap,
  TransactionSource,
  WakeListener,
} from './types.js';
import { JOURNAL_ACTION_META_SCHEMA } from './action-meta.js';
import { debugWorker } from './debug.js';
import { JournalError } from './errors.js';
import { givenServices } from './handlers.js';

export { JOURNAL_ACTION_META_SCHEMA } from './action-meta.js';

export const JOURNAL_PLUGIN_ERROR_CODES = { badSlice: 'ARKI_JOURNAL_PLUGIN_E001' } as const;

/** One effect in the app manifest: async work that the journal's job table feeds in. */
export type JournalDotAction = {
  readonly id: string;
  readonly binding: 'journal';
  readonly direction: 'in';
  readonly address: string;
  readonly metaSchema: typeof JOURNAL_ACTION_META_SCHEMA;
  readonly meta: { readonly entities: string[]; readonly events: string[] };
};

/** What one feature hands to the journal, as declared: an effect or a tap may still have needs. */
export type JournalDeclarations<Meta = unknown, Tx = DbHandle, AppDb = RootDb> = {
  readonly projections: readonly Projection<Meta, Tx>[];
  readonly effects: readonly Effect<Meta, AppDb, unknown, Needs>[];
  readonly taps: readonly Tap<Meta, AppDb, Needs>[];
};

/** What a feature's `journal` slice publishes at boot: its services, for its effects and taps. */
export type JournalSlicePayload = { readonly services: Services };

/**
 * The feature slice a `journalHandlers(...)` declaration produces.
 * `handlers` is read before the features boot, by `journal({ j, tables })`.
 * `resolve` runs at the feature's boot. `TServices` is what the feature's effects and
 * taps need: the feature must declare it in `needs`.
 */
export type JournalFeatureSlice<Meta = unknown, Tx = DbHandle, AppDb = RootDb, TServices = unknown> = {
  readonly key: 'journal';
  readonly actions: readonly JournalDotAction[];
  readonly handlers: JournalDeclarations<Meta, Tx, AppDb>;
  readonly resolve: (services: TServices) => JournalSlicePayload;
};

function effectAction(effect: {
  readonly name: string;
  readonly entities: readonly { readonly kind: string }[];
  readonly types: ReadonlySet<string>;
}): JournalDotAction {
  return {
    id: `${effect.name}.run`,
    binding: 'journal',
    direction: 'in',
    address: effect.name,
    metaSchema: JOURNAL_ACTION_META_SCHEMA,
    meta: { entities: effect.entities.map(entity => entity.kind), events: [...effect.types] },
  };
}

/**
 * Declare a feature's projections, effects and taps
 * (`feature('orders', { use: [journalHandlers({ projections, effects })] })`).
 * `journal({ j, tables })` reads them from the feature value and composes the journal.
 *
 * An effect with needs (`j.effect(name, entity, { mailer: need<Mailer>() }, on)`) gets
 * them from the booted services of this feature, by name, when `journalWorker()` runs it.
 * The feature must declare each one in its own `needs`: the slice's `resolve` does not
 * type-check otherwise, and throws at the feature's boot when the types were bypassed.
 * Two features may use the same need name for two different services.
 *
 * Actions: one per effect. Projections add none: they run inside the write, not
 * at an app boundary.
 */
export function journalHandlers<
  Meta = unknown,
  Tx = DbHandle,
  AppDb = RootDb,
  const E extends readonly Effect<Meta, AppDb, unknown, Needs>[] = readonly [],
  const T extends readonly Tap<Meta, AppDb, Needs>[] = readonly [],
>(handlers: {
  readonly projections?: readonly Projection<Meta, Tx>[];
  readonly effects?: E;
  readonly taps?: T;
}): JournalFeatureSlice<Meta, Tx, AppDb, ServicesFor<E> & ServicesFor<T>> {
  const { projections = [], effects = [], taps = [] } = handlers;
  return {
    key: 'journal',
    actions: effects.map(effect => effectAction(effect)),
    handlers: { projections, effects, taps },
    resolve: resolveServices(effects, taps),
  };
}

const isServices = (value: unknown): value is Services => typeof value === 'object' && value !== null;

/** The slice's boot step: hand the feature's services over, after checking each handler finds its own. */
function resolveServices(
  effects: readonly { readonly name: string; readonly needs: Needs }[],
  taps: readonly { readonly name: string; readonly needs: Needs }[],
): (services: unknown) => JournalSlicePayload {
  // The kernel hands the feature's services over untyped, so they are read by name here.
  return services => {
    const given = isServices(services) ? services : {};
    // Checked at the feature's boot, so a missing service never waits for the first job.
    for (const effect of effects) givenServices('effect', effect, given);
    for (const tap of taps) givenServices('tap', tap, given);
    return { services: given };
  };
}

/* ------------------------------------------------------------------ */
/* defineFeature descriptors                                           */
/* ------------------------------------------------------------------ */

/** Marks the infra plugin `journalProjections(...)` makes, so the journal can find it among a feature's units. */
export const JOURNAL_PROJECTIONS_KIND = 'journal-projections';

/**
 * What `journalProjections(...)` puts in a feature's `.infra(...)`: a plugin
 * that boots nothing and provides nothing — its job is the static `handlers`
 * the journal reads before boot.
 */
export type JournalProjectionsPlugin<Meta = unknown, Tx = DbHandle> = Plugin<EmptyShape, EmptyShape> & {
  readonly kind: typeof JOURNAL_PROJECTIONS_KIND;
  readonly handlers: {
    readonly projections: readonly Projection<Meta, Tx>[];
    readonly effects: readonly [];
    readonly taps: readonly [];
  };
};

/**
 * A `defineFeature` feature's projections, for its `.infra(...)`:
 * `defineFeature('orders').infra(store, journalProjections(customerStats))`.
 *
 * Projections run inside the write's transaction (or later, in the worker,
 * when async) and get only the transaction, so they need no services. The
 * unit shows in `dot explain` as `<feature>/journal-projections`.
 */
export function journalProjections<Meta = unknown, Tx = DbHandle>(
  ...projections: readonly Projection<Meta, Tx>[]
): JournalProjectionsPlugin<Meta, Tx> {
  return {
    ...plugin({ name: 'journal-projections', provides: {} }),
    kind: JOURNAL_PROJECTIONS_KIND,
    handlers: { projections, effects: [], taps: [] },
  };
}

/** What `journalEffects(core, …)` puts in a feature's `.entrypoints(...)`. Same slice as `journalHandlers`, plus its `kind`. */
export type JournalEffectsEntrypoint<Meta = unknown, AppDb = RootDb, TServices = unknown> = JournalFeatureSlice<
  Meta,
  DbHandle,
  AppDb,
  TServices
> & { readonly kind: 'journal' };

/** A named compile error when the feature lacks a service its effects or taps need. */
type CoversNeeds<TDeps, TNeeded> = [TDeps] extends [TNeeded]
  ? unknown
  : {
      readonly 'JOURNAL: the feature does not give these effects and taps what they need': Exclude<
        keyof TNeeded,
        keyof TDeps
      >;
    };

/**
 * A `defineFeature` feature's effects and taps, for its `.entrypoints(...)`:
 *
 * ```ts
 * // entrypoints/journal.ts — `import type { core }` only
 * export const orderEffects = (c: typeof core) => journalEffects(c, { effects: [orderMail] });
 * ```
 *
 * An effect's needs (`j.effect(name, entity, { mailer: need<Mailer>() }, on)`)
 * come from the feature, by name: a need alias, an infra service or `usecases`.
 * A missing one is a compile error here, naming it, and fails the feature's
 * boot for callers that skip the types. `journalWorker()` hands them over
 * when it runs the handler. Each effect is one manifest action whose meta
 * lists its events — what `dot explain --as journal-flow` draws.
 */
export function journalEffects<
  C extends AnyFeatureCore,
  Meta = unknown,
  AppDb = RootDb,
  const E extends readonly Effect<Meta, AppDb, unknown, Needs>[] = readonly [],
  const T extends readonly Tap<Meta, AppDb, Needs>[] = readonly [],
>(
  _core: C,
  handlers: { readonly effects?: E; readonly taps?: T } & CoversNeeds<DepsOf<C>, ServicesFor<E> & ServicesFor<T>>,
): JournalEffectsEntrypoint<Meta, AppDb, ServicesFor<E> & ServicesFor<T>> {
  // `_core` is a type witness; the feature hands its own services to `resolve` when it boots.
  const effects: readonly Effect<Meta, AppDb, unknown, Needs>[] = handlers.effects ?? [];
  const taps: readonly Tap<Meta, AppDb, Needs>[] = handlers.taps ?? [];
  return {
    kind: 'journal',
    key: 'journal',
    actions: effects.map(effect => effectAction(effect)),
    handlers: { projections: [], effects, taps },
    resolve: resolveServices(effects, taps),
  };
}

/** Direct mode: the app composed the journal itself. */
export type JournalDirectOptions<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb> = {
  readonly journal: Journal<Meta, Tx, AppDb>;
};

/** Feature mode: the journal is composed from the features' `journalHandlers` declarations. */
export type JournalFeatureOptions<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb> = {
  readonly j: Pick<JournalDefinitions<Meta, Tx, AppDb>, 'compose'>;
  readonly tables: JournalTables;
};

/**
 * `RootDb` again on purpose: a Drizzle transaction fits `AppDb` by shape, and must not fit here.
 * `TransactionSource<Tx>`: the worker's database runs the commands of effects, so it opens `Tx`.
 */
type JournalNeeds<Tx extends TransactionSource<Tx>, AppDb extends RootDb> = {
  db: AppDb & RootDb & TransactionSource<Tx>;
};

export type JournalPlugin<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb> = Plugin<
  JournalNeeds<Tx, AppDb>,
  { journal: Journal<Meta, Tx, AppDb> }
>;

/** Feature mode: bound to the app's features when the app is built. */
export type JournalDriven<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb> = Driven<
  JournalNeeds<Tx, AppDb>,
  { journal: Journal<Meta, Tx, AppDb> }
>;

const isHandler = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  typeof value.name === 'string' &&
  'run' in value &&
  typeof value.run === 'function';

const isHandlerList = (value: unknown): boolean => Array.isArray(value) && value.every(item => isHandler(item));

/** A slice's static `handlers` are read untyped from the feature, so their shape is checked here. */
function isJournalDeclarations(value: unknown): value is JournalDeclarations {
  return (
    typeof value === 'object' &&
    value !== null &&
    'projections' in value &&
    isHandlerList(value.projections) &&
    'effects' in value &&
    isHandlerList(value.effects) &&
    'taps' in value &&
    isHandlerList(value.taps)
  );
}

function badSlice(feature: MountedFeature, what: string): DotPluginError {
  return new DotPluginError({
    code: JOURNAL_PLUGIN_ERROR_CODES.badSlice,
    message: `[journal] feature "${feature.name}" has a \`journal\` slice whose ${what}.`,
    remediation:
      'Declare handlers with journalHandlers({ projections, effects, taps }), journalEffects(core, { effects, taps }) or journalProjections(...) from @arki/journal/dot.',
    docsUrl: 'https://github.com/arki-labs/arki/blob/HEAD/packages/journal/docs/agent-guide.md#dot-boot-errors',
  });
}

/**
 * Throws when another handler of this kind already has the name, and names the
 * features that hold the two. `j.compose` makes the same check, but it gets
 * one flat list and cannot say which feature a handler came from.
 */
function claimName(
  kind: 'effect' | 'projection' | 'tap',
  owners: Map<string, MountedFeature>,
  name: string,
  feature: MountedFeature,
): void {
  const owner = owners.get(`${kind}:${name}`);
  if (owner !== undefined) {
    const where =
      owner === feature ? `feature "${feature.name}", twice` : `features "${owner.name}" and "${feature.name}"`;
    throw new JournalError('BAD_DEFINITION', kind, name, `journal: duplicate ${kind} name "${name}" (${where})`);
  }
  owners.set(`${kind}:${name}`, feature);
}

/** A `journalProjections(...)` unit among a chain feature's kernel units (its `kind` survives the feature's renaming). */
function isProjectionsUnit(unit: object): unit is { readonly handlers: unknown } {
  return 'kind' in unit && unit.kind === JOURNAL_PROJECTIONS_KIND && 'handlers' in unit;
}

/**
 * Everything one feature hands the journal, wherever it was declared: the
 * `journal` slice (`journalHandlers` in `use`, or `journalEffects` in
 * `.entrypoints`) and any `journalProjections` unit in a chain feature's
 * `.infra`. Read from the feature value, so it works before anything boots.
 * Only the feature's OWN units: the app mounts every nested child as its own
 * node, so reading a parent's `plugins()` (which lists the children's units
 * too) would register each child projection twice.
 */
function declaredBy(feature: MountedFeature): readonly unknown[] {
  const declared: unknown[] = [];
  const slice = entrypointsOf(feature).find(item => item.key === 'journal');
  if (slice !== undefined) declared.push('handlers' in slice ? slice.handlers : undefined);
  if ('plugins' in feature) {
    for (const unit of ownUnits(feature)) if (isProjectionsUnit(unit)) declared.push(unit.handlers);
  }
  return declared;
}

/**
 * Read each feature's journal declarations, in feature order, and fold them into
 * one list per kind. Refuses a name that is listed twice. `owners` maps
 * `effect:<name>` and `tap:<name>` (and `projection:<name>`) to the feature that lists it.
 */
function readDeclarations(features: readonly MountedFeature[]): {
  readonly declarations: JournalDeclarations;
  readonly owners: ReadonlyMap<string, MountedFeature>;
} {
  const projections: Projection[] = [];
  const effects: Effect<unknown, RootDb, unknown, Needs>[] = [];
  const taps: Tap<unknown, RootDb, Needs>[] = [];
  const owners = new Map<string, MountedFeature>();
  for (const feature of features) {
    const all = declaredBy(feature);
    if (all.length === 0) {
      debugWorker.debug('[journal] feature "{featureName}" did not contribute journal handlers', {
        featureName: feature.name,
      });
      continue;
    }
    for (const declared of all) {
      if (!isJournalDeclarations(declared))
        throw badSlice(feature, 'handlers are not lists of projections, effects and taps');
      for (const { name } of declared.projections) claimName('projection', owners, name, feature);
      for (const { name } of declared.effects) claimName('effect', owners, name, feature);
      for (const { name } of declared.taps) claimName('tap', owners, name, feature);
      projections.push(...declared.projections);
      effects.push(...declared.effects);
      taps.push(...declared.taps);
    }
  }
  return { declarations: { projections, effects, taps }, owners };
}

function journalPlugin<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  build: () => Journal<Meta, Tx, AppDb>,
): JournalPlugin<Meta, Tx, AppDb> {
  const needs: { readonly db: Service<AppDb & RootDb & TransactionSource<Tx>> } = {
    db: service<AppDb & RootDb & TransactionSource<Tx>>(),
  };
  return plugin({
    name: 'journal',
    needs,
    configure(ctx) {
      ctx.registerService('journal', 'custom');
      ctx.declareProvides('journal');
      // `dot explain --as journal-flow`: which event starts which effect, from the effects' action meta.
      ctx.registerProjection({ format: 'journal-flow', binding: 'journal', module: '@arki/journal/projection' });
    },
    provides: { journal: () => build() },
  });
}

/**
 * The driven part, for `.use()`: publishes the journal as `services.journal`.
 * It runs nothing in the background: serve `journalWorker()` for that.
 *
 * - `journal({ journal })`: the journal the app composed itself.
 * - `journal({ j, tables })`: the journal composed from the `journalHandlers` slices of
 *   the features the app mounts. Effects and taps get their services from `journalWorker()`.
 */
export function journal<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  options: JournalDirectOptions<Meta, Tx, AppDb>,
): JournalPlugin<Meta, Tx, AppDb>;
export function journal<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  options: JournalFeatureOptions<Meta, Tx, AppDb>,
): JournalDriven<Meta, Tx, AppDb>;
export function journal<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  options: JournalDirectOptions<Meta, Tx, AppDb> | JournalFeatureOptions<Meta, Tx, AppDb>,
): JournalPlugin<Meta, Tx, AppDb> | JournalDriven<Meta, Tx, AppDb> {
  if ('journal' in options) {
    const composed = options.journal;
    return journalPlugin(() => composed);
  }
  const { j, tables } = options;
  return driven(features =>
    journalPlugin(() =>
      // `'worker'`: the effects' services exist only once the features boot, after this journal.
      j.compose({ tables, ...readDeclarations(features).declarations, services: 'worker' }),
    ),
  );
}

export type JournalWorkerOptions = {
  readonly pollMs?: number;
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
  /** See `journal.worker`: required when the journal has taps, unless `taps: false`. */
  readonly listen?: WakeListener;
  readonly taps?: boolean;
};

/**
 * What the worker needs of `services.journal`: any journal fits. The database type
 * is checked where the journal is mounted (`journal(...)` needs the same `db`).
 */
type WorkerHost = {
  worker(
    db: RootDb,
    opts?: JournalWorkerOptions & { readonly services?: HandlerServices; readonly jobs?: JobRunner },
  ): JournalWorker;
};

/** No `$`-prefixed keys: that prefix is the kernel's. */
type NoReservedKeys = Readonly<Record<`$${string}`, never>>;

/** The worker's own needs. A `jobs` source adds its own. */
type WorkerNeeds = { readonly db: Service<RootDb>; readonly journal: Service<WorkerHost> };

/**
 * A job runner built at boot, from the mounted features and the services it needs, for
 * `journalWorker({ jobs })`. `@arki/queue/dot`'s `outboxJobs()` makes one.
 */
export type JobsSource<TNeeds extends NeedsShape> = {
  /** Merged into the worker's needs: a missing one fails boot, not the first job. */
  readonly needs: TNeeds;
  /** The consumer actions the runner adds to the worker's manifest (e.g. `<job>.consume`). */
  readonly actions?: (features: readonly MountedFeature[]) => readonly ActionSource[];
  /** `services` is the worker's boot context: its needs, `db`, and the features' slice records. */
  build(
    features: readonly MountedFeature[],
    services: CtxOf<TNeeds> & { readonly db: RootDb },
  ): JobRunner | Promise<JobRunner>;
};

/** The services a feature's `journal` slice published at its boot. */
function sliceServices(ctx: object, feature: MountedFeature): Services {
  const payload = sliceOf(ctx, feature).journal;
  if (typeof payload !== 'object' || payload === null || !('services' in payload) || !isServices(payload.services))
    throw badSlice(feature, 'boot payload holds no services; it was not made by journalHandlers or journalEffects');
  return payload.services;
}

/**
 * The driving part, for `.serve()`: one worker between `start` and `stop`, for the
 * journal that `journal(...)` published. Each effect and tap of a feature gets the
 * services of that feature. A process that serves no worker still writes: its jobs
 * wait for a process that does. With `jobs`, the worker also runs queue rows
 * (`@arki/queue/outbox`) through the runner the source builds at boot.
 */
export function journalWorker(options?: JournalWorkerOptions): Driver<WireNeeds<WorkerNeeds>, EmptyShape>;
export function journalWorker<TNeeds extends NeedsShape & NoReservedKeys>(
  options: JournalWorkerOptions & { readonly jobs: JobsSource<TNeeds> },
): Driver<WireNeeds<WorkerNeeds & TNeeds>, EmptyShape>;
export function journalWorker(
  options: JournalWorkerOptions & { readonly jobs?: JobsSource<NeedsShape> } = {},
): Driver<WireNeeds<WorkerNeeds>, EmptyShape> {
  const { jobs: source, ...workerOptions } = options;
  // The source's needs join the worker's, so the kernel resolves and checks them with the
  // worker's own; the overloads above type them for the app.
  const needs: WorkerNeeds = { ...source?.needs, db: service<RootDb>(), journal: service<WorkerHost>() };
  return driver(features => {
    let worker: JournalWorker | undefined;
    return plugin<WorkerNeeds, EmptyShape>({
      name: 'journal-worker',
      needs,
      actions: source?.actions?.(features),
      async boot(ctx) {
        const { owners } = readDeclarations(features);
        const byFeature = new Map<MountedFeature, Services>();
        // An effect or tap came from a `journal` slice, so its owner has a slice record. A
        // projection may come from an infra unit instead, and needs no services anyway.
        for (const [handler, feature] of owners) {
          if (handler.startsWith('projection:') || byFeature.has(feature)) continue;
          byFeature.set(feature, sliceServices(ctx, feature));
        }
        const services: HandlerServices = ({ kind, name }) => {
          const owner = owners.get(`${kind}:${name}`);
          return (owner === undefined ? undefined : byFeature.get(owner)) ?? {};
        };
        const jobs = await source?.build(features, ctx);
        // Built at boot, not at start: a missing service fails the boot.
        worker = ctx.journal.worker(ctx.db, { ...workerOptions, services, jobs });
      },
      async start() {
        await worker?.start();
      },
      async stop() {
        await worker?.stop();
      },
    });
  });
}
