/**
 * `@arki/dot` adapter, in three parts:
 *
 * - `journal(...)` is the infra part, for `.infra()`. It publishes `services.journal`, so
 *   features can write through it. With `{ j }` it composes the journal from the
 *   features' declarations. It reads them from the feature values, so it boots before the features.
 * - `journalHandlers(core, { effects, taps, workflows })` is an application contribution, for
 *   `.usecases(factories, journalHandlers(core, …))`. An effect is application code (D-8), so it
 *   sits with the usecases and gets what a usecase gets: the feature's needs (never an
 *   `entrypointOnly` one), its private infra and its domain services. `needsOf((_: Deps) => ['mailer'])`
 *   picks them, typed from the feature.
 * - `journalWorker(...)` is the only entrypoint, for `.entrypoints()`. It runs the effects, taps and
 *   async projections between `start` and `stop`, each already bound to the services of the
 *   feature that lists it.
 *
 * The split works because writes never need an effect's services: a write only queues
 * the effect's job. Inline projections run inside the write, and they get only the
 * transaction. So the journal is composed with `services: 'worker'`, and the worker
 * gives the services when it runs a handler.
 *
 * Where each part lives in a feature (D-9):
 *
 * - `journalProjections(...)` in `.infra(...)`: projections maintain the feature's read
 *   models, so they sit with its other infra.
 * - `journalHandlers(core, { effects, taps, workflows })` in `.usecases(...)`: the reactions a
 *   behaviour owns, next to the command that decides it.
 *
 * The app's `db` plugin must publish the root Drizzle database under the `db` key.
 * `@arki/dot` is an optional peer. Import this module only inside a Dot app.
 */
import type {
  AnyApplicationContribution,
  AnyDefinedFeature,
  AnyFeatureCore,
  DepsOf,
  EntrypointBinder,
} from '@arki/dot/feature';
import type {
  ActionSource,
  CtxOf,
  DotConfigureContext,
  EmptyShape,
  NeedsShape,
  Service,
  WireNeeds,
} from '@arki/dot/unit';
import type { SchemaInput, StandardSchemaV1 } from '@arki/schema';
import { getTableName } from 'drizzle-orm';
import { entrypoint, instanceOf, ownUnits, sliceOf } from '@arki/dot/feature';
import { DotUnitError, infra, service } from '@arki/dot/unit';

import type { Journal, JournalDefinitions } from './api.js';
import type {
  EventMapDelivery,
  EventMapEdge,
  EventMapGraph,
  EventMapMeta,
  EventMapNode,
  EventMapRetry,
} from './projection.js';
import { EVENT_MAP_DEFAULT_ENTRYPOINT_ROOT } from './event-map-kinds.js';
import { edgeKey } from './projection.js';
import type {
  AnyEntity,
  DbHandle,
  Effect,
  HandlerServices,
  JobRunner,
  JournalWorker,
  Need,
  Needs,
  Projection,
  RootDb,
  Services,
  ServicesFor,
  Tap,
  TransactionSource,
  WakeListener,
} from './types.js';
import type { ErasedCommand, WorkflowDef, WorkflowNode, WorkflowServices } from './workflow/define.js';
import { JOURNAL_ACTION_META_SCHEMA } from './action-meta.js';
import { debugWorker } from './debug.js';
import { JournalError } from './errors.js';
import { givenServices, need } from './handlers.js';
import { defaultEffectRetry } from './worker.js';

export { JOURNAL_ACTION_META_SCHEMA } from './action-meta.js';

export const JOURNAL_PLUGIN_ERROR_CODES = {
  /**
   * A feature supplied an invalid Journal contribution.
   * @fix Declare a feature's reactions with journalHandlers(core, { effects, taps, workflows }) in .usecases(...), and its projections with journalProjections(...) in .infra(...), both from @arki/journal/dot.
   * @verify bun run test -- src/dot-feature.test.ts
   */
  badSlice: 'ARKI_JOURNAL_PLUGIN_E001',
} as const;

/** One effect in the app manifest: async work that the journal's job table feeds in. */
export type JournalDotAction = {
  readonly id: string;
  readonly binding: 'journal';
  readonly direction: 'in';
  readonly address: string;
  readonly metaSchema: typeof JOURNAL_ACTION_META_SCHEMA;
  /** `signals` is set on a workflow's action only: the signal names its `waitFor` nodes wait for. */
  readonly meta: { readonly entities: string[]; readonly events: string[]; readonly signals?: string[] };
};

/** What one feature hands to the journal, as declared: an effect or a tap may still have needs. */
export type JournalDeclarations<Meta = unknown, Tx = DbHandle, AppDb = RootDb> = {
  readonly projections: readonly Projection<Meta, Tx>[];
  readonly effects: readonly Effect<Meta, AppDb, Needs>[];
  readonly taps: readonly Tap<Meta, AppDb, Needs>[];
  readonly workflows: readonly WorkflowDef[];
};

/** What `journalHandlers(...)` binds to at the feature's boot: the feature's usecase-level services. */
export type JournalSlicePayload = { readonly services: Services };

/**
 * A name made unique per instance of a feature (`send-on-request` -> `send-on-request#eu`).
 * A plain feature has no instance, so its names stay exactly as written: stored job rows keep resolving.
 */
const qualifyBy =
  (featureName: string) =>
  (name: string): string => {
    const instance = instanceOf(featureName);
    return instance === undefined ? name : `${name}#${instance}`;
  };

function effectAction(
  effect: {
    readonly name: string;
    readonly entities: readonly { readonly kind: string }[];
    readonly types: ReadonlySet<string>;
  },
  qualify: (name: string) => string = name => name,
): JournalDotAction {
  const name = qualify(effect.name);
  return {
    id: `${name}.run`,
    binding: 'journal',
    direction: 'in',
    address: name,
    metaSchema: JOURNAL_ACTION_META_SCHEMA,
    meta: { entities: effect.entities.map(entity => entity.kind), events: [...effect.types] },
  };
}

/** A workflow's manifest action: `<name>@<version>.run`, with the signals its `waitFor` nodes wait for. */
function workflowAction(def: WorkflowDef): JournalDotAction {
  return {
    id: `${def.name}@${def.version}.run`,
    binding: 'journal',
    direction: 'in',
    address: def.name,
    metaSchema: JOURNAL_ACTION_META_SCHEMA,
    meta: { entities: [], events: [], signals: signalsOf(def) },
  };
}

/** The signal names a workflow's `waitFor` nodes wait for, each once. */
function signalsOf(def: WorkflowDef): string[] {
  const signals = new Set<string>();
  for (const node of def.nodes) if (node.kind === 'waitFor') signals.add(node.signal);
  return [...signals];
}

/**
 * A feature before `.usecases()`: what `needsOf` and `journalHandlers` take. Its `DepsOf` is what a
 * usecase may ask for. After `.usecases()` the stage's `DepsOf` is what an entrypoint gets (the
 * `entrypointOnly` needs and the usecases), which a reaction must never see; that stage has no
 * `usecases` method, so it does not fit here.
 */
export type UsecaseCore = AnyFeatureCore & { readonly usecases: (...args: never) => unknown };

/**
 * The needs record of an effect, tap or workflow in a Dot feature. `select` picks the keys of the
 * feature's usecase-level deps (its needs, never an `entrypointOnly` one; its private infra; its
 * domain services), and each one is typed from the feature. It replaces `need<T>()` in a Dot feature:
 * the type is written once, at the feature, and read here from the selector's parameter annotation.
 *
 * ```ts
 * // reactions/send-receipt.ts: `import type { Deps }` only, so there is no import cycle.
 * import type { Deps } from '../feature';
 * export const sendReceipt = j.effect('send-receipt', order, needsOf((_: Deps) => ['mailer']), {
 *   OrderPlaced: (event, { mailer }) => mailer.sendReceipt(event.entityId),
 * });
 * ```
 *
 * `needsOf` calls `select` once and never reads its argument; the feature's value is not needed, so a
 * reaction module and its feature module can import each other in either order. `D` comes from the
 * annotation, so callers write no type arguments. A key the feature lacks, or an `entrypointOnly`
 * one, is a compile error. The selection holds at runtime too: `journalHandlers` checks each key when
 * the feature boots and fails the boot naming it.
 */
export function needsOf<D, const K extends readonly (keyof D & string)[]>(
  select: (deps: D) => K,
): { readonly [P in K[number]]: Need<D[P]> } {
  // Erasure seam: the selector only carries the type `D`, and its parameter is never read, so there
  // is no value to pass. `undefined as never` satisfies the parameter type for any `D`.
  const keys = select(undefined as never);
  // Erasure seam: `Object.fromEntries` types its keys as `string`; they are exactly `keys`, and each
  // value is the empty phantom `need()` makes, which fits `Need<T>` for every `T`.
  return Object.fromEntries(keys.map(key => [key, need()])) as { readonly [P in K[number]]: Need<D[P]> };
}

/**
 * What `journalHandlers(core, …)` puts in a feature's `.usecases(factories, …)`: an application contribution.
 * `handlers` is read before the features boot, by `journal({ j })`. `bind` runs at the feature's boot,
 * with the feature's usecase-level deps, and checks that each handler finds what it needs there.
 */
export type JournalHandlers<Meta = unknown, AppDb = RootDb, TServices = unknown> = {
  readonly kind: 'journal';
  readonly key: 'journal';
  readonly handlers: JournalDeclarations<Meta, DbHandle, AppDb>;
  /** The actions, named after the feature: an instance's effect ids carry its instance (`send#eu.run`). */
  readonly actionsOf: (feature: string) => readonly JournalDotAction[];
  readonly bind: (deps: TServices) => JournalSlicePayload;
};

/** A named compile error when the feature lacks a service its effects, taps or workflows need. */
type CoversNeeds<TDeps, TNeeded> = [TDeps] extends [TNeeded]
  ? unknown
  : {
      readonly 'JOURNAL: the feature does not give these effects, taps and workflows what they need': Exclude<
        keyof TNeeded,
        keyof TDeps
      >;
    };

/**
 * A feature's reactions, for its `.usecases(...)`:
 *
 * ```ts
 * export const core = defineFeature('orders').needs({ … }).infra(mailer, journalProjections(placedCount));
 * const logic = core.usecases({}, journalHandlers(core, { effects: [sendReceipt] }));
 * ```
 *
 * Each effect, tap and workflow gets its needs from this feature, by name: a need (never an
 * `entrypointOnly` one), a private infra service or a domain service. Pick them with `needsOf((_: Deps) => […])`.
 * A missing one is a compile error here, naming it, and fails the feature's boot for callers that
 * skip the types. `journalWorker()` runs each handler with these services.
 *
 * Actions: one per effect (named after the feature's instance) and one per workflow
 * (`<name>@<version>.run`, its signals in the meta). A handler name may be listed by one feature
 * only: a second one fails the boot and names both features.
 */
export function journalHandlers<
  C extends UsecaseCore,
  Meta = unknown,
  AppDb = RootDb,
  const E extends readonly Effect<Meta, AppDb, Needs>[] = readonly [],
  const T extends readonly Tap<Meta, AppDb, Needs>[] = readonly [],
  const W extends readonly WorkflowDef[] = readonly [],
>(
  _core: C,
  handlers: { readonly effects?: E; readonly taps?: T; readonly workflows?: W } & CoversNeeds<
    DepsOf<C>,
    ServicesFor<E> & ServicesFor<T> & WorkflowServices<W>
  >,
): JournalHandlers<Meta, AppDb, ServicesFor<E> & ServicesFor<T> & WorkflowServices<W>> {
  // `_core` is a type witness; the feature hands its own deps to `bind` when it boots.
  const effects: readonly Effect<Meta, AppDb, Needs>[] = handlers.effects ?? [];
  const taps: readonly Tap<Meta, AppDb, Needs>[] = handlers.taps ?? [];
  const workflows: readonly WorkflowDef[] = handlers.workflows ?? [];
  return {
    kind: 'journal',
    key: 'journal',
    handlers: { projections: [], effects, taps, workflows },
    actionsOf: feature => [
      ...effects.map(effect => effectAction(effect, qualifyBy(feature))),
      ...workflows.map(def => workflowAction(def)),
    ],
    bind: bindServices(effects, taps, workflows),
  };
}

const isServices = (value: unknown): value is Services => typeof value === 'object' && value !== null;

/** The contribution's boot step: hand the feature's deps over, after checking each handler finds its own. */
function bindServices(
  effects: readonly { readonly name: string; readonly needs: Needs }[],
  taps: readonly { readonly name: string; readonly needs: Needs }[],
  workflows: readonly WorkflowDef[],
): (deps: unknown) => JournalSlicePayload {
  // The kernel hands the feature's deps over untyped, so they are read by name here.
  return deps => {
    const given = isServices(deps) ? deps : {};
    // Checked at the feature's boot, so a missing service never waits for the first job.
    for (const effect of effects) givenServices('effect', effect, given);
    for (const tap of taps) givenServices('tap', tap, given);
    for (const def of workflows)
      givenServices('effect', { name: `workflow.step of ${def.name}@${def.version}`, needs: def.needs }, given);
    return { services: given };
  };
}

/* ------------------------------------------------------------------ */
/* defineFeature descriptors                                           */
/* ------------------------------------------------------------------ */

/** Marks the infra unit `journalProjections(...)` makes, so the journal can find it among a feature's units. */
export const JOURNAL_PROJECTIONS_KIND = 'journal-projections';

/**
 * What `journalProjections(...)` puts in a feature's `.infra(...)`: a plugin
 * that boots nothing and provides nothing — its job is the static `handlers`
 * the journal reads before boot.
 */
export type JournalProjectionsPlugin<Meta = unknown, Tx = DbHandle> = ReturnType<typeof journalProjections<Meta, Tx>>;

/**
 * A `defineFeature` feature's projections, for its `.infra(...)`:
 * `defineFeature('orders').infra(store, journalProjections(customerStats))`.
 *
 * Projections run inside the write's transaction (or later, in the worker,
 * when async) and get only the transaction, so they need no services. The
 * unit shows in `dot explain` as `<feature>/journal-projections`.
 */
export function journalProjections<Meta = unknown, Tx = DbHandle>(...projections: readonly Projection<Meta, Tx>[]) {
  return Object.assign(infra({ name: 'journal-projections', provides: {} }), {
    kind: JOURNAL_PROJECTIONS_KIND,
    handlers: { projections, effects: [], taps: [], workflows: [] },
  } as const);
}

/** Direct mode: the app composed the journal itself. */
export type JournalDirectOptions<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
> = {
  readonly journal: Journal<Meta, Tx, AppDb>;
};

/** Feature mode: the journal is composed from the features' `journalHandlers` declarations. */
export type JournalFeatureOptions<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
> = {
  readonly j: Pick<JournalDefinitions<Meta, Tx, AppDb>, 'compose'>;
  /** The meta the workflow runner records its checkpoints with. Required when a feature declares workflows. */
  readonly workflowMeta?: SchemaInput<Meta>;
  /**
   * The folder `dot explain --as event-map` scans for procedure files, relative to the folder `dot` runs in.
   * Default `src/features`: the scan reads every `entrypoints/` folder under it.
   */
  readonly entrypointRoot?: string;
};

export type JournalPlugin<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
> = ReturnType<typeof journalPlugin<Meta, Tx, AppDb>>;

/**
 * Feature mode: bound to the app's features when the app is built. Its `provides.journal`
 * is the handle a feature needs (`entrypointOnly(appJournal.provides.journal)`).
 */
export type JournalDriven<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
> = ReturnType<typeof journalFromFeatures<Meta, Tx, AppDb>>;

const isHandler = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  typeof value.name === 'string' &&
  'run' in value &&
  typeof value.run === 'function';

const isHandlerList = (value: unknown): boolean => Array.isArray(value) && value.every(item => isHandler(item));

const isWorkflow = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  'name' in value &&
  typeof value.name === 'string' &&
  'version' in value &&
  typeof value.version === 'number' &&
  'nodes' in value &&
  Array.isArray(value.nodes);

const isWorkflowList = (value: unknown): boolean => Array.isArray(value) && value.every(item => isWorkflow(item));

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
    isHandlerList(value.taps) &&
    'workflows' in value &&
    isWorkflowList(value.workflows)
  );
}

function badSlice(feature: AnyDefinedFeature, what: string): DotUnitError {
  return new DotUnitError({
    code: JOURNAL_PLUGIN_ERROR_CODES.badSlice,
    message: `[journal] feature "${feature.name}" has a \`journal\` slice whose ${what}.`,
    remediation:
      'Declare reactions with journalHandlers(core, { effects, taps, workflows }) in .usecases(...), and projections with journalProjections(...) in .infra(...), from @arki/journal/dot.',
    docsUrl: 'https://github.com/arki-labs/arki/blob/HEAD/packages/journal/docs/agent-guide.md#dot-boot-errors',
  });
}

/**
 * Throws when another handler of this kind already has the name, and names the
 * features that hold the two. `j.compose` makes the same check, but it gets
 * one flat list and cannot say which feature a handler came from.
 */
function claimName(
  kind: 'effect' | 'projection' | 'tap' | 'workflow',
  owners: Map<string, AnyDefinedFeature>,
  name: string,
  feature: AnyDefinedFeature,
): void {
  const owner = owners.get(`${kind}:${name}`);
  if (owner !== undefined) {
    const where =
      owner === feature ? `feature "${feature.name}", twice` : `features "${owner.name}" and "${feature.name}"`;
    throw new JournalError('BAD_DEFINITION', kind, name, `journal: duplicate ${kind} name "${name}" (${where})`);
  }
  owners.set(`${kind}:${name}`, feature);
}

/** A `journalProjections(...)` unit among a feature's kernel units (its `kind` survives the feature's renaming). */
function isProjectionsUnit(unit: object): unit is { readonly handlers: unknown } {
  return 'kind' in unit && unit.kind === JOURNAL_PROJECTIONS_KIND && 'handlers' in unit;
}

/**
 * Everything one feature hands the journal, wherever it was declared: its
 * `journal` contribution (`journalHandlers` in `.usecases`) and any
 * `journalProjections` unit in its `.infra`. Read from the feature value, so it
 * works before anything boots.
 * Only the feature's OWN units: the app mounts every nested child as its own
 * node, so reading a parent's `plugins()` (which lists the children's units
 * too) would register each child projection twice.
 */
function declaredBy(feature: AnyDefinedFeature): readonly unknown[] {
  const declared: unknown[] = [];
  const contribution = feature.contributions.find(item => item.key === 'journal');
  if (contribution !== undefined) declared.push(handlersOf(contribution));
  for (const unit of ownUnits(feature)) if (isProjectionsUnit(unit)) declared.push(unit.handlers);
  return declared;
}

/** A contribution's static `handlers`, read untyped: `isJournalDeclarations` checks them. */
const handlersOf = (contribution: AnyApplicationContribution): unknown =>
  'handlers' in contribution ? contribution.handlers : undefined;

/** An effect's retry policy, as the graph shows it: JSON has no `Infinity`, so no limit is `null`. */
function retryOf(effect: Effect<unknown, RootDb, Needs>): EventMapRetry {
  const retry = effect.schedule.retry ?? defaultEffectRetry;
  return {
    policy: effect.schedule.retry === undefined ? 'default' : 'custom',
    maxRetries: Number.isFinite(retry.maxRetries) ? retry.maxRetries : null,
  };
}

/** The `.step` nodes of a workflow, by name; a branch's steps are named `parallel.branch.step`. */
function opaqueStepsOf(nodes: readonly WorkflowNode[], prefix = ''): string[] {
  return nodes.flatMap(item =>
    item.kind === 'step'
      ? [`${prefix}${item.name}`]
      : item.kind === 'parallel'
        ? item.branches.flatMap(branch => opaqueStepsOf(branch.def.nodes, `${prefix}${item.name}.${branch.name}.`))
        : [],
  );
}

/** What a workflow's nodes declare, for the event map: the commands its command nodes run, and the events its waits wait for. */
function workflowEdges(
  nodes: readonly WorkflowNode[],
  prefix: string,
  found: {
    readonly runs: (node: string, command: ErasedCommand, undo: boolean) => void;
    readonly waits: (node: string, label: string, entity: AnyEntity, type: string) => void;
  },
): void {
  for (const item of nodes) {
    const path = `${prefix}${item.name}`;
    if (item.kind === 'command') {
      found.runs(path, item.command, false);
      if (item.options.undo !== undefined) found.runs(path, item.options.undo.command, true);
    }
    if (item.kind === 'eventWait')
      for (const source of item.on) for (const event of source.events) found.waits(path, source.label, source.entity, event.type);
    if (item.kind === 'parallel')
      for (const branch of item.branches) workflowEdges(branch.def.nodes, `${path}.${branch.name}.`, found);
  }
}

/**
 * The app's event graph for `dot explain --as event-map`, from the features' declarations alone:
 * each entity and the events it folds, each projection and the events it reads, each effect, tap and
 * workflow and the events it reacts to, and the feature that owns each handler. Nothing runs and
 * nothing is collected at runtime. A declaration the boot would refuse is left out: the boot names it.
 */
function eventMap(features: readonly AnyDefinedFeature[]): EventMapGraph {
  const nodes = new Map<string, EventMapNode>();
  const edges = new Map<string, EventMapEdge>();
  const node = (added: EventMapNode): string => {
    if (!nodes.has(added.id)) nodes.set(added.id, added);
    return added.id;
  };
  const edge = (added: EventMapEdge): void => void edges.set(edgeKey(added), added);
  const eventNode = (type: string): string => node({ id: `event:${type}`, kind: 'event', name: type });
  const entityNode = (entity: AnyEntity): void => {
    const id = node({ id: `entity:${entity.kind}`, kind: 'entity', name: entity.kind, table: getTableName(entity.table) });
    for (const type of entity.events.keys()) eventNode(type);
    // The fold runs in the write itself: the entity row and the event commit together.
    for (const type of entity.reducers.keys()) edge({ kind: 'folds', from: id, to: eventNode(type), timing: 'same-transaction' });
  };
  /** A command a workflow runs, with the events it writes: found through the workflow even when no procedure imports it. */
  const commandNode = (command: ErasedCommand): string => {
    const id = node({ id: `command:${command.name}`, kind: 'command', name: command.name });
    for (const written of command.writes) edge({ kind: 'writes', from: id, to: eventNode(written.type) });
    return id;
  };
  const reacts = (from: string, types: Iterable<string>, delivery: EventMapDelivery): void => {
    for (const type of types) edge({ kind: 'reacts', from, to: eventNode(type), timing: 'after-commit', delivery });
  };
  /** A `with-event` workflow: the run is written in the event's transaction, so it needs no delivery word. */
  const startsWith = (from: string, type: string): void =>
    edge({ kind: 'reacts', from, to: eventNode(type), timing: 'same-transaction' });
  for (const feature of features) {
    const qualify = qualifyBy(feature.name);
    for (const declared of declaredBy(feature)) {
      if (!isJournalDeclarations(declared)) continue;
      const owner = node({ id: `feature:${feature.name}`, kind: 'feature', name: feature.name });
      const owned = (id: string): void => edge({ kind: 'owned-by', from: id, to: owner });
      for (const projection of declared.projections) {
        for (const entity of projection.entities) entityNode(entity);
        const id = node({ id: `projection:${projection.name}`, kind: 'projection', name: projection.name, lane: projection.lane });
        for (const type of projection.types)
          edge(
            projection.lane === 'inline'
              ? { kind: 'projects', from: id, to: eventNode(type), timing: 'same-transaction' }
              : { kind: 'projects', from: id, to: eventNode(type), timing: 'after-commit', delivery: 'exactly-once' },
          );
        owned(id);
      }
      for (const effect of declared.effects) {
        for (const entity of effect.entities) entityNode(entity);
        const name = qualify(effect.name);
        const id = node({ id: `effect:${name}`, kind: 'effect', name, deps: Object.keys(effect.needs), retry: retryOf(effect) });
        reacts(id, effect.types, 'at-least-once');
        owned(id);
      }
      for (const tap of declared.taps) {
        for (const entity of tap.entities) entityNode(entity);
        const name = qualify(tap.name);
        const id = node({ id: `tap:${name}`, kind: 'tap', name, deps: Object.keys(tap.needs) });
        // A tap is lossy: a listener that is not running misses the event.
        reacts(id, tap.types, 'at-most-once');
        owned(id);
      }
      for (const def of declared.workflows) {
        const id = node({
          id: `workflow:${def.name}@${def.version}`,
          kind: 'workflow',
          name: def.name,
          version: def.version,
          deps: Object.keys(def.needs),
          signals: signalsOf(def),
          opaqueSteps: opaqueStepsOf(def.nodes),
        });
        workflowEdges(def.nodes, '', {
          runs: (node, command, undo) => {
            const commandId = commandNode(command);
            edge(undo ? { kind: 'runs', from: id, to: commandId, node, undo: true } : { kind: 'runs', from: id, to: commandId, node });
          },
          waits: (node, label, entity, type) => {
            entityNode(entity);
            edge({ kind: 'waits-for', from: id, to: eventNode(type), node, label });
          },
        });
        if (def.startOn !== undefined) {
          entityNode(def.startOn.entity);
          if (def.startOn.timing === 'with-event') startsWith(id, def.startOn.event.type);
          else reacts(id, [def.startOn.event.type], 'at-least-once');
        }
        owned(id);
      }
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

/**
 * Read each feature's journal declarations, in feature order, and fold them into
 * one list per kind. Refuses a name that is listed twice. `owners` maps
 * `effect:<name>` and `tap:<name>` (and `projection:<name>`) to the feature that lists it.
 */
function readDeclarations(features: readonly AnyDefinedFeature[]): {
  readonly declarations: JournalDeclarations;
  readonly owners: ReadonlyMap<string, AnyDefinedFeature>;
} {
  const projections: Projection[] = [];
  const effects: Effect<unknown, RootDb, Needs>[] = [];
  const taps: Tap<unknown, RootDb, Needs>[] = [];
  const workflows: WorkflowDef[] = [];
  const owners = new Map<string, AnyDefinedFeature>();
  for (const feature of features) {
    const qualify = qualifyBy(feature.name);
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
      // An instance's effects and taps are renamed here, so the duplicate check, the services lookup,
      // the stored job rows and the worker's dispatch all see the qualified name.
      const ownEffects = declared.effects.map(effect => ({ ...effect, name: qualify(effect.name) }));
      const ownTaps = declared.taps.map(tap => ({ ...tap, name: qualify(tap.name) }));
      for (const { name } of ownEffects) claimName('effect', owners, name, feature);
      for (const { name } of ownTaps) claimName('tap', owners, name, feature);
      // A workflow is keyed by name and version, not renamed per instance: its commands and stored runs use the plain name.
      for (const def of declared.workflows) claimName('workflow', owners, `${def.name}@${def.version}`, feature);
      projections.push(...declared.projections);
      workflows.push(...declared.workflows);
      effects.push(...ownEffects);
      taps.push(...ownTaps);
    }
  }
  return { declarations: { projections, effects, taps, workflows }, owners };
}

/**
 * What the journal unit needs, in both modes. `RootDb` again on purpose: a Drizzle transaction
 * fits `AppDb` by shape, and must not fit here. `TransactionSource<Tx>`: the worker's database
 * runs the commands of effects, so it opens `Tx`.
 */
function journalNeeds<Tx extends TransactionSource<Tx>, AppDb extends RootDb>() {
  return { db: service<AppDb & RootDb & TransactionSource<Tx>>() };
}

/**
 * The journal unit's manifest entries, in both modes. `flow` is the graph `dot explain --as event-map`
 * prints: in feature mode it is derived from the features' declarations; a journal the app composed
 * itself has no feature to read it from.
 */
function registerJournal(ctx: DotConfigureContext, flow?: EventMapMeta): void {
  ctx.registerService('journal', 'custom');
  ctx.declareProvides('journal');
  ctx.registerProjection({
    format: 'event-map',
    binding: 'journal',
    module: '@arki/journal/event-map',
    ...(flow === undefined ? {} : { meta: flow }),
  });
}

function journalPlugin<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(composed: Journal<Meta, Tx, AppDb>) {
  return infra({
    name: 'journal',
    needs: journalNeeds<Tx, AppDb>(),
    configure(ctx) {
      registerJournal(ctx);
    },
    provides: { journal: () => composed },
  });
}

function journalFromFeatures<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>({ j, workflowMeta, entrypointRoot = EVENT_MAP_DEFAULT_ENTRYPOINT_ROOT }: JournalFeatureOptions<Meta, Tx, AppDb>) {
  return infra.fromFeatures({
    name: 'journal',
    needs: journalNeeds<Tx, AppDb>(),
    configure(ctx) {
      registerJournal(ctx, { ...eventMap(ctx.$features), entrypointRoot });
    },
    provides: {
      journal: ({ $features }) =>
        // `'worker'`: the effects' services exist only once the features boot, after this journal.
        j.compose({
          ...readDeclarations($features).declarations,
          ...(workflowMeta === undefined ? {} : { workflowMeta }),
          services: 'worker',
        }),
    },
  });
}

/**
 * The infra part, for `.infra()`: publishes the journal as `services.journal`.
 * It runs nothing in the background: serve `journalWorker()` for that.
 *
 * - `journal({ journal })`: the journal the app composed itself.
 * - `journal({ j })`: the journal composed from the `journalHandlers` slices of
 *   the features the app mounts. Effects and taps get their services from `journalWorker()`.
 */
export function journal<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(options: JournalDirectOptions<Meta, Tx, AppDb>): JournalPlugin<Meta, Tx, AppDb>;
export function journal<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(options: JournalFeatureOptions<Meta, Tx, AppDb>): JournalDriven<Meta, Tx, AppDb>;
export function journal<
  Meta extends StandardSchemaV1<unknown, Record<string, unknown>>,
  Tx extends TransactionSource<Tx>,
  AppDb extends RootDb,
>(
  options: JournalDirectOptions<Meta, Tx, AppDb> | JournalFeatureOptions<Meta, Tx, AppDb>,
): JournalPlugin<Meta, Tx, AppDb> | JournalDriven<Meta, Tx, AppDb> {
  return 'journal' in options ? journalPlugin(options.journal) : journalFromFeatures(options);
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

/** One app's worker, built at boot and run between start and stop. */
type WorkerState = { worker: JournalWorker | undefined };

/**
 * A job runner built at boot, from the mounted features and the services it needs, for
 * `journalWorker({ jobs })`. `@arki/queue/dot`'s `outboxJobs()` makes one.
 */
export type JobsSource<TNeeds extends NeedsShape> = {
  /** Merged into the worker's needs: a missing one fails boot, not the first job. */
  readonly needs: TNeeds;
  /** The consumer actions the runner adds to the worker's manifest (e.g. `<job>.consume`). */
  readonly actions?: (features: readonly AnyDefinedFeature[]) => readonly ActionSource[];
  /** `services` is the worker's boot context: its needs, `db`, and the features' slice records. */
  build(
    features: readonly AnyDefinedFeature[],
    services: CtxOf<TNeeds> & { readonly db: RootDb },
  ): JobRunner | Promise<JobRunner>;
};

/** The services a feature's `journal` slice published at its boot. */
function sliceServices(ctx: object, feature: AnyDefinedFeature): Services {
  const payload = sliceOf(ctx, feature).journal;
  if (typeof payload !== 'object' || payload === null || !('services' in payload) || !isServices(payload.services))
    throw badSlice(feature, 'boot payload holds no services; it was not made by journalHandlers');
  return payload.services;
}

/**
 * The entrypoint, for `.entrypoints()`: one worker between `start` and `stop`, for the
 * journal that `journal(...)` published. Each effect and tap of a feature gets the
 * services of that feature. A process that serves no worker still writes: its jobs
 * wait for a process that does. With `jobs`, the worker also runs queue rows
 * (`@arki/queue/outbox`) through the runner the source builds at boot.
 */
export function journalWorker(options?: JournalWorkerOptions): EntrypointBinder<WireNeeds<WorkerNeeds>, EmptyShape>;
export function journalWorker<TNeeds extends NeedsShape & NoReservedKeys>(
  options: JournalWorkerOptions & { readonly jobs: JobsSource<TNeeds> },
): EntrypointBinder<WireNeeds<WorkerNeeds & TNeeds>, EmptyShape>;
export function journalWorker(
  options: JournalWorkerOptions & { readonly jobs?: JobsSource<NeedsShape> } = {},
): EntrypointBinder<WireNeeds<WorkerNeeds>, EmptyShape> {
  const { jobs: source, ...workerOptions } = options;
  // The source's needs join the worker's, so the kernel resolves and checks them with the
  // worker's own; the overloads above type them for the app.
  const needs: WorkerNeeds = { ...source?.needs, db: service<RootDb>(), journal: service<WorkerHost>() };
  return entrypoint.fromFeatures({
    name: 'journal-worker',
    needs,
    state: (): WorkerState => ({ worker: undefined }),
    ...(source?.actions === undefined ? {} : { actions: source.actions }),
    async boot(ctx) {
      const { owners } = readDeclarations(ctx.$features);
      const byFeature = new Map<AnyDefinedFeature, Services>();
      // An effect or tap came from a `journal` slice, so its owner has a slice record. A
      // projection may come from an infra unit instead, and needs no services anyway.
      for (const [handler, feature] of owners) {
        if (handler.startsWith('projection:') || byFeature.has(feature)) continue;
        byFeature.set(feature, sliceServices(ctx, feature));
      }
      const services: HandlerServices = ({ kind, name, workflow }) => {
        // `workflow.step` asks once per workflow: that workflow's feature answers, not a shared set.
        const owner = owners.get(workflow === undefined ? `${kind}:${name}` : `workflow:${workflow}`);
        return (owner === undefined ? undefined : byFeature.get(owner)) ?? {};
      };
      const jobs = await source?.build(ctx.$features, ctx);
      // Built at boot, not at start: a missing service fails the boot.
      ctx.$state.worker = ctx.journal.worker(ctx.db, { ...workerOptions, services, jobs });
    },
    async start({ $state }) {
      await $state.worker?.start();
    },
    async stop({ $state }) {
      await $state.worker?.stop();
    },
  });
}
