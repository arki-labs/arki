/**
 * `@arki/dot` adapter.
 *
 * - `journal(...)` is the plugin. It publishes the journal as `services.journal`
 *   and runs one worker per plugin instance between `start` and `stop`.
 * - `journalHandlers(...)` is the feature slice. A feature lists its projections
 *   and effects with it, and `journal({ j, tables, features })` collects them.
 *
 * The app's `db` plugin must publish the root Drizzle database under the `db` key.
 *
 * `@arki/dot` is an optional peer. Import this module only inside a Dot app.
 * Feature slices are read by shape: this file never imports `@arki/feature`.
 */
import type { z } from 'zod';

import type { Plugin, Service, Token } from '@arki/dot/plugin';
import { DotPluginError, plugin, service } from '@arki/dot/plugin';

import type { Journal, JournalDefinitions } from './api.js';
import type { JournalTables } from './pg.js';
import type {
  DbHandle,
  Effect,
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
import { debugWorker } from './debug.js';
import { JournalError } from './errors.js';
import { bindEffect, bindTap } from './handlers.js';

export const JOURNAL_ACTION_META_SCHEMA = '@arki/journal/action-meta@1';

export const JOURNAL_PLUGIN_ERROR_CODES = { badSlice: 'JOURNAL_PLUGIN_E001' } as const;

/** One effect in the app manifest: async work that the journal's job table feeds in. */
export type JournalDotAction = {
  readonly id: string;
  readonly binding: 'journal';
  readonly direction: 'in';
  readonly address: string;
  readonly metaSchema: typeof JOURNAL_ACTION_META_SCHEMA;
  readonly meta: { readonly entities: string[]; readonly events: string[] };
};

/** What one feature hands to the journal. Its effects already hold the feature's services. */
export type JournalHandlers<Meta = unknown, Tx = DbHandle, AppDb = RootDb> = {
  readonly projections: readonly Projection<Meta, Tx>[];
  readonly effects: readonly Effect<Meta, AppDb>[];
  readonly taps: readonly Tap<Meta, AppDb>[];
};

/**
 * The `@arki/feature` slice contract a `journalHandlers(...)` declaration produces.
 * `TServices` is what the feature's effects need: the feature must declare it in `needs`.
 */
export type JournalFeatureSlice<Meta = unknown, Tx = DbHandle, AppDb = RootDb, TServices = unknown> = {
  readonly key: 'journal';
  readonly actions: readonly JournalDotAction[];
  readonly resolve: (services: TServices) => JournalHandlers<Meta, Tx, AppDb>;
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
 * Declare a feature's projections and effects as a boot-time slice
 * (`defineFeature(..., { use: [journalHandlers({ projections, effects })] })`).
 * The payload lands under `journal` in the feature's slice token, where
 * `journal({ j, tables, features })` collects it.
 *
 * An effect with needs (`j.effect(name, entity, { mailer: need<Mailer>() }, on)`) gets
 * them from the booted services of this feature, by name. The feature must declare
 * each one in its own `needs`: the slice's `resolve` does not type-check otherwise.
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
    // The kernel hands the feature's services over untyped, so they are read by name here.
    resolve: (services: unknown) => ({
      projections,
      effects: effects.map(effect => bindEffect(effect, isServices(services) ? services : {})),
      taps: taps.map(tap => bindTap(tap, isServices(services) ? services : {})),
    }),
  };
}

const isServices = (value: unknown): value is Services => typeof value === 'object' && value !== null;

type WorkerOptions = {
  /** Run the async lane in this process. Default `true`. */
  readonly worker?: boolean;
  readonly pollMs?: number;
  readonly batchSize?: number;
  readonly leaseSeconds?: number;
  /** See `journal.worker`: required when the journal has taps, unless `taps: false`. */
  readonly listen?: WakeListener;
  readonly taps?: boolean;
};

/** Direct mode: the app composed the journal itself. */
export type JournalDirectOptions<
  Meta extends z.ZodObject,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
> = WorkerOptions & { readonly journal: Journal<Meta, Tx, AppDb> };

/** Feature mode: the plugin composes the journal from the features' `journalHandlers` slices. */
export type JournalFeatureOptions<
  Meta extends z.ZodObject,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
> = WorkerOptions & {
  readonly j: Pick<JournalDefinitions<Meta, Tx, AppDb>, 'compose'>;
  readonly tables: JournalTables;
  /** `tokens(features)` from `@arki/feature/dot`. A feature without a journal slice adds nothing. */
  readonly features: readonly Token<object, string>[];
};

/**
 * `RootDb` again on purpose: a Drizzle transaction fits `AppDb` by shape, and must not fit here.
 * `TransactionSource<Tx>`: the worker's database runs the commands of effects, so it opens `Tx`.
 */
export type JournalPlugin<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb> = Plugin<
  { db: AppDb & RootDb & TransactionSource<Tx> },
  { journal: Journal<Meta, Tx, AppDb> }
>;

const isHandler = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  typeof value.name === 'string' &&
  'run' in value &&
  typeof value.run === 'function';

/** The kernel hands services over untyped, so the slice shape is checked here, once, at boot. */
function isJournalHandlers(value: unknown): value is JournalHandlers {
  return (
    typeof value === 'object' &&
    value !== null &&
    'projections' in value &&
    Array.isArray(value.projections) &&
    value.projections.every(item => isHandler(item)) &&
    'effects' in value &&
    Array.isArray(value.effects) &&
    value.effects.every(item => isHandler(item)) &&
    'taps' in value &&
    Array.isArray(value.taps) &&
    value.taps.every(item => isHandler(item))
  );
}

/**
 * Throws when another handler of this kind already has the name, and names the
 * feature tokens that hold the two. `j.compose` makes the same check, but it gets
 * one flat list and cannot say which feature a handler came from.
 */
function claimName(
  kind: 'effect' | 'projection' | 'tap',
  owners: Map<string, string>,
  name: string,
  feature: string,
): void {
  const owner = owners.get(name);
  if (owner !== undefined) {
    const where = owner === feature ? `feature "${feature}", twice` : `features "${owner}" and "${feature}"`;
    throw new JournalError('BAD_DEFINITION', kind, name, `journal: duplicate ${kind} name "${name}" (${where})`);
  }
  owners.set(name, feature);
}

/**
 * Read each feature's `journal` slice from the booted services, in feature order.
 * Refuses a projection name or an effect name that is listed twice.
 */
function collectHandlers(
  features: readonly Token<object, string>[],
  services: Readonly<Record<string, unknown>>,
): JournalHandlers {
  const projections: Projection[] = [];
  const effects: Effect[] = [];
  const taps: Tap[] = [];
  const projectionOwners = new Map<string, string>();
  const effectOwners = new Map<string, string>();
  const tapOwners = new Map<string, string>();
  for (const feature of features) {
    const slices = services[feature.key];
    const slice = typeof slices === 'object' && slices !== null && 'journal' in slices ? slices.journal : undefined;
    if (slice === undefined) {
      debugWorker.debug('[journal] feature "{featureKey}" did not contribute a journal slice', {
        featureKey: feature.key,
      });
      continue;
    }
    if (!isJournalHandlers(slice)) {
      throw new DotPluginError({
        code: JOURNAL_PLUGIN_ERROR_CODES.badSlice,
        message: `[journal] feature token "${feature.key}" holds a \`journal\` slice that is not lists of projections, effects and taps.`,
        remediation: 'Declare the slice with journalHandlers({ projections, effects, taps }) from @arki/journal/dot.',
        docsUrl: 'https://github.com/arki-labs/arki/blob/HEAD/packages/journal/docs/agent-guide.md#dot-boot-errors',
      });
    }
    for (const { name } of slice.projections) claimName('projection', projectionOwners, name, feature.key);
    for (const { name } of slice.effects) claimName('effect', effectOwners, name, feature.key);
    for (const { name } of slice.taps) claimName('tap', tapOwners, name, feature.key);
    projections.push(...slice.projections);
    effects.push(...slice.effects);
    taps.push(...slice.taps);
  }
  return { projections, effects, taps };
}

export function journal<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  options: JournalDirectOptions<Meta, Tx, AppDb>,
): JournalPlugin<Meta, Tx, AppDb>;
export function journal<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  options: JournalFeatureOptions<Meta, Tx, AppDb>,
): JournalPlugin<Meta, Tx, AppDb>;
export function journal<Meta extends z.ZodObject, Tx extends TransactionSource<Tx>, AppDb extends RootDb>(
  options: JournalDirectOptions<Meta, Tx, AppDb> | JournalFeatureOptions<Meta, Tx, AppDb>,
) {
  let composed: Journal<Meta, Tx, AppDb> | undefined;
  let worker: JournalWorker | undefined;
  // Each feature token is a need, so the kernel boots the features first and refuses a missing one.
  const featureNeeds = 'features' in options ? options.features.map(feature => [feature.key, feature]) : [];
  const needs: { readonly db: Service<AppDb & RootDb & TransactionSource<Tx>> } = {
    ...Object.fromEntries(featureNeeds),
    db: service<AppDb & RootDb & TransactionSource<Tx>>(),
  };

  return plugin({
    name: 'journal',
    needs,
    configure(ctx) {
      ctx.registerService('journal', 'custom');
      ctx.declareProvides('journal');
    },
    boot(services) {
      composed =
        'journal' in options
          ? options.journal
          : options.j.compose({ tables: options.tables, ...collectHandlers(options.features, services) });
      return { journal: composed };
    },
    async start({ db }) {
      if (options.worker === false) return;
      worker = composed?.worker(db, {
        pollMs: options.pollMs,
        batchSize: options.batchSize,
        leaseSeconds: options.leaseSeconds,
        listen: options.listen,
        taps: options.taps,
      });
      await worker?.start();
    },
    async stop() {
      await worker?.stop();
      worker = undefined;
    },
  });
}
