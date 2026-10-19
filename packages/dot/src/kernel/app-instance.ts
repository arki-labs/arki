/**
 * Internal DotApp implementation — the kernel's lifecycle scheduler.
 *
 * Not exported from the public surface. Tests reach it only through
 * `defineApp(...)` and its returned `DotApp` interface.
 */

import type { ScopeAggregate, SupervisorFailure } from '@arki/async';
import type { Clock } from '@arki/clock';
import type { Failure, FailureIn } from '@arki/failure';
import type { Logger } from '@arki/log';
import { Deadline, scopeAggregate } from '@arki/async';
import { SystemClock } from '@arki/clock';
import { isFailure, UnexpectedDefect } from '@arki/failure';
import { getLogger } from '@arki/log';

import type {
  ActionDiagnostic,
  DiagnosticIssue,
  DotDiagnosticsSnapshot,
  LifecycleDiagnostic,
  PluginDiagnostic,
  ServiceDiagnostic,
} from '../diagnostics.js';
import type { DotLifecycleEvent, DotLifecycleObserver } from '../lifecycle-observer.js';
import type { DotLifecycleHook, DotLifecycleState } from '../lifecycle.js';
import type {
  ActionManifest,
  DependencyEdge,
  DotAppManifest,
  JsonObject,
  LifecycleManifest,
  PluginManifest,
  ProjectionManifest,
  ServiceManifest,
} from '../manifest.js';
import type {
  AnyPlugin,
  DotConfigureContext,
  DotLoggingHandle,
  EmptyPhases,
  Lazy,
  PluginBootOutcome,
  PluginCloseOutcome,
  PluginConstruction,
  PluginPhases,
  RuntimePlugin,
  ServiceRecord,
} from '../plugin-contract.js';
import { DotLifecycleError, DotLifecycleErrorCode } from '../lifecycle.js';
import { toJsonObject } from '../manifest.js';
import { isLazy, isLazyWitness, lazyOf } from '../plugin-contract.js';
import { nowMs } from './now.js';
import { withPhaseSpan, withPluginHookSpan } from './otel.js';

const kernelLog = getLogger('arki:dot:kernel');

/**
 * Logging cannot report its own failure through logging (RFC §7 of the
 * `@arki/log` redesign), so a failed close of the logging slot goes to the
 * console, once. It never replaces the lifecycle's own result or error.
 */
function reportLoggingCloseFailure(error: unknown): void {
  try {
    console.error('[arki:dot] closing the logging slot failed', error);
  } catch {
    // A broken fallback reporter cannot replace the owned cleanup result.
  }
}

const DOCS_BASE = 'https://docs.arki.dev/dot/diagnostics';

function failed<Value>(value: Value): value is FailureIn<Value> {
  return isFailure<unknown>(value);
}
type CloseMember<Close extends Failure> = Exclude<PluginCloseOutcome<Close>, void>;
type DisposeMember<Close extends Failure, Phases extends PluginPhases> = CloseMember<Close> | Phases['dispose'];
type CleanupMember<Close extends Failure, Phases extends PluginPhases> = DisposeMember<Close, Phases> | Phases['stop'];
function closeOutcome<Close extends Failure>(failures: readonly Close[]) {
  if (failures.length === 1) return failures[0];
  if (failures.length > 1) return scopeAggregate([], failures);
  return;
}
function startupOutcome<Primary extends Failure, Cleanup extends Failure>(
  primary: Primary,
  cleanup: readonly Cleanup[],
) {
  return cleanup.length === 0 ? primary : scopeAggregate([primary], cleanup);
}
export type DotConfigureOutcome<Phases extends PluginPhases = EmptyPhases> =
  void | Phases['configure'] | ReturnType<typeof UnexpectedDefect>;
export type DotStopOutcome<Phases extends PluginPhases = EmptyPhases> = ReturnType<
  typeof closeOutcome<Phases['stop'] | SupervisorFailure>
>;
export type DotDisposeOutcome<Close extends Failure, Phases extends PluginPhases = EmptyPhases> = ReturnType<
  typeof closeOutcome<CleanupMember<Close, Phases>>
>;
export type DotBootOutcome<Open extends Failure, Close extends Failure, Phases extends PluginPhases = EmptyPhases> =
  | void
  | Exclude<PluginBootOutcome<Open, Close>, void>
  | ScopeAggregate<Exclude<PluginBootOutcome<Open, Close>, void>, DisposeMember<Close, Phases>>;
export type DotStartedOutcome<Close extends Failure, Phases extends PluginPhases = EmptyPhases> =
  | void
  | Phases['start']
  | SupervisorFailure
  | ScopeAggregate<Phases['start'] | SupervisorFailure, CleanupMember<Close, Phases>>;
export type DotStartOutcome<Open extends Failure, Close extends Failure, Phases extends PluginPhases = EmptyPhases> =
  DotBootOutcome<Open, Close, Phases> | DotStartedOutcome<Close, Phases>;

function constructed<Open extends Failure, Close extends Failure>(
  value: PluginConstruction<Close> | Exclude<PluginBootOutcome<Open, Close>, void>,
): value is PluginConstruction<Close> {
  return !isFailure<unknown>(value);
}
function loggingHandle<Open extends Failure, Close extends undefined | Failure>(
  value: Open | DotLoggingHandle<Close>,
): value is DotLoggingHandle<Close> {
  return !isFailure<unknown>(value);
}
/** Per-plugin mutable bookkeeping. */
type PluginRecord<Open extends Failure, Close extends Failure, Phases extends PluginPhases> = {
  plugin: RuntimePlugin<Open, Close, Phases>;
  lifetime?: PluginConstruction<Close>;
  order: number;
  actions: ActionManifest[];
  projections: ProjectionManifest[];
  services: ServiceManifest[];
  hooks: Set<DotLifecycleHook>;
  provides: Set<string>;
  publishedServices: ServiceRecord;
  booted: boolean;
  started: boolean;
  issues: DiagnosticIssue[];
  lifecycleDiagnostics: LifecycleDiagnostic[];
};

/** Resolve a needs-shape witness to its wire key. */
function wireKeyOf(witness: object, alias: string): string {
  return 'key' in witness && typeof witness.key === 'string' ? (witness as { key: string }).key : alias;
}

/** Helper for stable issue construction. */
function makeIssue(args: {
  code: string;
  severity?: 'info' | 'warning' | 'error';
  plugin?: string;
  message: string;
  remediation: string;
  docsAnchor: string;
  metadata?: Record<string, unknown>;
}): DiagnosticIssue {
  return {
    code: args.code,
    severity: args.severity ?? 'error',
    plugin: args.plugin,
    message: args.message,
    remediation: args.remediation,
    docsUrl: `${DOCS_BASE}#${args.docsAnchor}`,
    metadata: args.metadata,
  };
}

export type DotAppInternalConfig<
  Open extends Failure,
  Close extends Failure,
  Phases extends PluginPhases = EmptyPhases,
> = {
  appName: string;
  appVersion?: string;
  plugins: readonly RuntimePlugin<Open, Close, Phases>[];
  /** Runtime config bag passed to every `boot` hook. */
  config?: Readonly<Record<string, unknown>>;
  /**
   * Observers registered at construction time, before any phase fires.
   * Required if a consumer wants to see `configure`-phase events — those
   * happen before there's a public seam to call `subscribe()` on.
   */
  observers?: readonly DotLifecycleObserver[];
  /** Per-hook watchdog budget in ms — see `defineApp`'s option of the same name. */
  hookTimeoutMs?: number;
  clock?: Clock;
};

/**
 * Internal app implementation. Public consumers see the `DotApp` interface
 * from `../define-app.ts`.
 */
export class DotAppImpl<
  TOpen extends Failure = never,
  TClose extends Failure = never,
  TPhases extends PluginPhases = EmptyPhases,
> {
  readonly #appName: string;
  readonly #appVersion: string | undefined;
  readonly #config: Readonly<Record<string, unknown>>;

  /** Plugins in declaration order — v2 boot order IS declaration order. */
  readonly #ordered: readonly RuntimePlugin<TOpen, TClose, TPhases>[];
  readonly #records: Map<string, PluginRecord<TOpen, TClose, TPhases>>;

  /** Macro-state of the app. */
  #state: DotLifecycleState = 'defined';

  /** Per-hook watchdog budget (ms); `undefined` = no watchdog. */
  readonly #hookTimeoutMs: number | undefined;
  readonly #clock: Clock;
  readonly #lazyOwners = new Set<Lazy<unknown, Failure>>();

  /** Manifest finalised after `configure`. */
  #manifest: DotAppManifest;

  /** Wire-keyed services map — populated as plugins boot. */
  readonly #serviceMap = new Map<string, unknown>();

  /** Which plugin provided each wire key — feeds dependency edges + collisions. */
  readonly #providerByWireKey = new Map<string, string>();

  /** Dependency edges observed during boot (consumer → provider). */
  readonly #wiringEdges: DependencyEdge[] = [];

  /** Merged wire-keyed services record exposed as `app.services`. */
  #aggregatedServices: Record<string, unknown> = {};

  /** Configure has already happened (idempotent). */
  #configured = false;

  /** In-flight boot promise — used for concurrent boot() coalescing. */
  #bootInflight: Promise<DotBootOutcome<TOpen, TClose, TPhases> | DotConfigureOutcome<TPhases>> | null = null;
  /** In-flight start promise — used for concurrent start() coalescing. */
  #startInflight: Promise<DotStartOutcome<TOpen, TClose, TPhases> | DotConfigureOutcome<TPhases>> | null = null;
  /** Narrow public entry points coalesce without widening the phases reached. */
  #bootConfiguredInflight: Promise<DotBootOutcome<TOpen, TClose, TPhases>> | null = null;
  #startConfiguredInflight: Promise<DotStartOutcome<TOpen, TClose, TPhases>> | null = null;
  #startBootedInflight: Promise<DotStartedOutcome<TClose, TPhases>> | null = null;
  /** In-flight stop promise — used for concurrent stop() coalescing. */
  #stopInflight: Promise<DotStopOutcome<TPhases>> | null = null;
  /** In-flight dispose promise — used for concurrent dispose() coalescing. */
  #disposeInflight: Promise<DotDisposeOutcome<TClose, TPhases>> | null = null;
  /**
   * Serializes lifecycle transitions. Each of boot/start/stop/dispose
   * queues behind whatever transition is in flight and re-checks
   * `#state` only once it reaches the head of the queue. Without this,
   * phases interleave at await points — e.g. `dispose()` completes while
   * `start()` awaits a hook, and the resuming start stamps `started`
   * over `disposed`, resurrecting a dead app.
   */
  #transitionChain: Promise<unknown> = Promise.resolve();

  /**
   * Structured lifecycle logger. One per app instance; named so consumers
   * can elevate it to DEBUG via `DEBUG=arki:dot:lifecycle` without
   * touching unrelated namespaces. Every line carries the app name plus
   * any phase/plugin attributes from the call site. The span helpers
   * (see `./otel.ts`) thread the active span's `traceId`+`spanId` onto
   * forked instances of this logger, so every log record is groupable
   * with its trace in any OTel-compatible backend.
   */
  readonly #logger: Logger;

  /** The plugin that fills the logging slot, found when the app is assembled. */
  readonly #loggingPlugin: RuntimePlugin<TOpen, TClose, TPhases> | undefined;
  /** The active logging handle, between activation and close. */
  #logging: DotLoggingHandle<undefined | TClose> | undefined;
  /** Set once logging is closed; later closes return the same promise. */
  #loggingClosed: Promise<void | TClose | ReturnType<typeof UnexpectedDefect>> | undefined;

  /**
   * In-process lifecycle observers. Fan-out is synchronous; observer
   * exceptions are caught and dropped (DEBUG-logged). Mutable through
   * `subscribe()` even after lifecycle starts — observers added later
   * see only events from their subscription onwards.
   */
  readonly #observers: Set<DotLifecycleObserver>;

  constructor(config: DotAppInternalConfig<TOpen, TClose, TPhases>) {
    this.#appName = config.appName;
    this.#appVersion = config.appVersion;
    this.#hookTimeoutMs = config.hookTimeoutMs;
    this.#clock = config.clock ?? new SystemClock();
    this.#config = Object.freeze({ ...config.config });
    this.#logger = getLogger('arki:dot:lifecycle').with({ 'dot.app.name': config.appName });
    this.#observers = new Set(config.observers);

    // Declaration order is boot order in v2. Duplicate names are surfaced at
    // construction (the `configure` phase pseudo-time).
    this.#ordered = [...config.plugins];

    // The logging slot is discovered without I/O and activated only during boot.
    const loggingPlugins = this.#ordered.filter(plugin => plugin.logging !== undefined);
    if (loggingPlugins.length > 1) {
      const names = loggingPlugins.map(plugin => `"${plugin.name}"`).join(', ');
      throw new DotLifecycleError({
        code: DotLifecycleErrorCode.DuplicateLogging,
        phase: 'configure',
        plugin: loggingPlugins[1]?.name,
        message: `Plugins ${names} all fill the logging slot — an app has at most one logging plugin. Keep one.`,
      });
    }
    this.#loggingPlugin = loggingPlugins[0];

    this.#records = new Map();
    for (const [order, plugin] of this.#ordered.entries()) {
      if (this.#records.has(plugin.name)) {
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.DuplicatePlugin,
          phase: 'configure',
          plugin: plugin.name,
          message: `Plugin "${plugin.name}" is registered twice`,
        });
      }
      // `$` is the kernel context namespace ($app/$plugin/$config). The plugin()
      // constraint bans these at compile time; this is the runtime backstop
      // for erased plugins and rename() targets, which types cannot see.
      for (const alias of Object.keys(plugin.needs)) {
        if (alias.startsWith('$')) {
          throw new DotLifecycleError({
            code: DotLifecycleErrorCode.ReservedServiceKey,
            phase: 'configure',
            plugin: plugin.name,
            message:
              `Plugin "${plugin.name}" declares needs alias "${alias}" — the "$" prefix is reserved ` +
              `for kernel context keys ($app, $plugin, $config). Rename the alias.`,
          });
        }
      }
      for (const [localKey, wireKey] of Object.entries(plugin.renames)) {
        if (wireKey.startsWith('$')) {
          throw new DotLifecycleError({
            code: DotLifecycleErrorCode.ReservedServiceKey,
            phase: 'configure',
            plugin: plugin.name,
            message:
              `Plugin "${plugin.name}" renames "${localKey}" to "${wireKey}" — the "$" prefix is ` +
              `reserved for kernel context keys ($app, $plugin, $config). Pick a different wire key.`,
          });
        }
      }
      this.#records.set(plugin.name, {
        plugin,
        order,
        actions: [],
        projections: [],
        services: [],
        hooks: new Set<DotLifecycleHook>(),
        provides: new Set<string>(),
        publishedServices: {},
        booted: false,
        started: false,
        issues: [],
        lifecycleDiagnostics: [],
      });
    }

    this.#checkStaticCapabilities();

    // Initial empty manifest — filled in by `runConfigure`.
    this.#manifest = this.#buildManifest();
  }

  /**
   * Walk every plugin's needs against the static `provides` handles of
   * every plugin (features and adapters alike). A provider mounted later is
   * a ring when its own needs lead back to the consumer (E019), otherwise an
   * order error (E020). Satisfied needs become `dot explain`'s capability
   * edges and the providers' manifest `provides`, without booting. Only
   * needs no plugin declares (erased graphs, dynamic bundle tokens) are
   * left to E012 at boot.
   */
  #checkStaticCapabilities(): void {
    const providerByKey = new Map<string, PluginRecord<TOpen, TClose, TPhases>>();
    for (const record of this.#records.values()) {
      // The handles are wire-keyed already: rename() rebuilds them on the new keys.
      for (const wireKey of Object.keys(record.plugin.provides)) {
        record.provides.add(wireKey);
        if (!providerByKey.has(wireKey)) providerByKey.set(wireKey, record);
      }
    }
    if (providerByKey.size === 0) return;

    const staticNeeds = (
      record: PluginRecord<TOpen, TClose, TPhases>,
    ): { key: string; provider: PluginRecord<TOpen, TClose, TPhases> }[] =>
      Object.entries(record.plugin.needs).flatMap(([alias, witness]) => {
        const key = wireKeyOf(witness, alias);
        const provider = providerByKey.get(key);
        return provider === undefined ? [] : [{ key, provider }];
      });

    /** The ring `start needs k1 ← p1 needs k2 ← … ← start`, or undefined when `from` never leads back. */
    const ringBack = (
      start: PluginRecord<TOpen, TClose, TPhases>,
      from: PluginRecord<TOpen, TClose, TPhases>,
      seen: Set<string>,
    ): string[] | undefined => {
      if (from === start) return [start.plugin.name];
      if (seen.has(from.plugin.name)) return undefined;
      seen.add(from.plugin.name);
      for (const need of staticNeeds(from)) {
        const rest = ringBack(start, need.provider, seen);
        if (rest !== undefined) return [`${from.plugin.name} needs ${need.key}`, ...rest];
      }
      return undefined;
    };

    for (const record of this.#records.values()) {
      const label = record.plugin.role === 'feature' ? 'Feature' : 'Plugin';
      for (const { key, provider } of staticNeeds(record)) {
        if (provider.order < record.order) {
          if (
            !this.#wiringEdges.some(
              e => e.from === record.plugin.name && e.to === provider.plugin.name && e.key === key,
            )
          ) {
            this.#wiringEdges.push({ from: record.plugin.name, to: provider.plugin.name, kind: 'requires', key });
          }
          continue;
        }
        const ring = ringBack(record, provider, new Set());
        if (ring !== undefined) {
          throw new DotLifecycleError({
            code: DotLifecycleErrorCode.CapabilityRing,
            phase: 'configure',
            plugin: record.plugin.name,
            message:
              `${label} "${record.plugin.name}" needs "${key}", which comes back around to itself:\n` +
              `  ${[`${record.plugin.name} needs ${key}`, ...ring].join(' ← ')}\n` +
              'Break the ring: move the shared piece into a third feature both need, or let one side read through db.query instead of a handle.',
          });
        }
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.ProviderMountedLater,
          phase: 'configure',
          plugin: record.plugin.name,
          message:
            `${label} "${record.plugin.name}" needs "${key}", which "${provider.plugin.name}" provides — ` +
            `but "${provider.plugin.name}" is mounted after it (position ${(provider.order + 1).toString()}; ` +
            `"${record.plugin.name}" is ${(record.order + 1).toString()}).\n` +
            (provider.plugin.role === 'feature'
              ? `Move "${provider.plugin.name}" before "${record.plugin.name}" in .features([...]).`
              : `Mount "${provider.plugin.name}" with .use() before "${record.plugin.name}".`),
        });
      }
    }
  }

  /**
   * Register a lifecycle observer. The returned function unregisters it.
   * Observers added through `subscribe()` see events emitted *after*
   * subscription only — to catch `configure` events, pass observers
   * through `defineApp(name, { observers })` at construction time.
   */
  subscribe(observer: DotLifecycleObserver): () => void {
    this.#observers.add(observer);
    return () => {
      this.#observers.delete(observer);
    };
  }

  /**
   * Fan out one event to every registered observer. Observer exceptions
   * are caught and DEBUG-logged so a misbehaving observer can never
   * break the lifecycle or hide an event from siblings.
   *
   * Hot-path note: when `#observers` is empty, the for-loop body never
   * runs — the per-event allocation in the caller (the event object) is
   * the only cost. The kernel never builds an event when no observers
   * are present; see {@link #emitIfObserved}.
   */
  #emit(event: DotLifecycleEvent): void {
    for (const observer of this.#observers) {
      try {
        observer(event);
      } catch (error) {
        kernelLog.debug('[{dot.app.name}] observer threw on {dot.event.kind}/{dot.event.status}', {
          'dot.app.name': this.#appName,
          'dot.event.kind': event.kind,
          'dot.event.status': event.status,
          error: error instanceof Error ? error : String(error),
        });
      }
    }
  }

  /**
   * Guarded emit. The event factory is only invoked when at least one
   * observer is registered — keeps the no-observer path allocation-free,
   * matching the kernel's zero-cost-when-off discipline (principle 5).
   */
  #emitIfObserved(makeEvent: () => DotLifecycleEvent): void {
    if (this.#observers.size === 0) return;
    this.#emit(makeEvent());
  }

  /**
   * Emit a single hook-level event. Skipped (zero allocation) when no
   * observers are registered.
   */
  #emitHook(
    phase: DotLifecycleHook,
    plugin: string,
    order: number,
    status: 'starting' | 'completed' | 'failed',
    opts?: { durationMs?: number; error?: unknown },
  ): void {
    if (this.#observers.size === 0) return;
    const event = {
      kind: 'plugin-hook' as const,
      phase,
      plugin,
      order,
      status,
      appName: this.#appName,
      timestamp: Date.now(),
      ...(opts?.durationMs === undefined ? {} : { durationMs: opts.durationMs }),
      ...(opts?.error === undefined ? {} : { error: opts.error }),
    };
    this.#emit(event);
  }

  #registerAction(record: PluginRecord<TOpen, TClose, TPhases>, action: Omit<ActionManifest, 'plugin'>): void {
    let meta: Readonly<JsonObject> | undefined;
    if (action.meta !== undefined) {
      try {
        meta = toJsonObject(action.meta);
      } catch (error) {
        const issue = makeIssue({
          code: DotLifecycleErrorCode.ActionMetaNotJson,
          plugin: record.plugin.name,
          message:
            `action "${action.id}" for binding "${action.binding}" has metadata that is not JSON-round-trip safe: ` +
            stringifyError(error),
          remediation:
            'Only put JSON-serializable data in action meta. Convert Dates to strings, remove functions/undefined fields, and avoid NaN/Infinity.',
          docsAnchor: 'action-meta-not-json',
          metadata: { actionId: action.id, binding: action.binding },
        });
        record.issues.push(issue);
      }
    }

    const stamped: ActionManifest = {
      id: action.id,
      plugin: record.plugin.name,
      binding: action.binding,
      direction: action.direction,
      ...(action.address === undefined ? {} : { address: action.address }),
      ...(action.summary === undefined ? {} : { summary: action.summary }),
      ...(meta === undefined ? {} : { meta }),
      ...(action.metaSchema === undefined ? {} : { metaSchema: action.metaSchema }),
    };

    for (const existingRecord of this.#records.values()) {
      const duplicate = existingRecord.actions.find(
        existing => existing.binding === stamped.binding && existing.id === stamped.id,
      );
      if (duplicate === undefined) continue;
      const issue = makeIssue({
        code: DotLifecycleErrorCode.DuplicateAction,
        plugin: record.plugin.name,
        message: `action "${stamped.id}" is registered more than once for binding "${stamped.binding}".`,
        remediation:
          'Action ids must be unique within a binding. Rename one action or move one of them to a different binding.',
        docsAnchor: 'duplicate-action',
        metadata: { binding: stamped.binding, id: stamped.id, firstPlugin: duplicate.plugin },
      });
      record.issues.push(issue);
      break;
    }

    record.actions.push(stamped);
  }

  /** Replace an action with a copy carrying the new summary, so manifests taken earlier keep the old one. */
  #describeAction(
    record: PluginRecord<TOpen, TClose, TPhases>,
    phase: DotLifecycleHook,
    actionId: string,
    patch: { readonly summary: string },
  ): void {
    for (const owner of this.#records.values()) {
      const action = owner.actions.find(
        candidate =>
          candidate.id === actionId &&
          (owner === record || record.projections.some(projection => projection.binding === candidate.binding)),
      );
      if (action === undefined) continue;
      owner.actions.splice(owner.actions.indexOf(action), 1, { ...action, summary: patch.summary });
      return;
    }
    throw new DotLifecycleError({
      code: DotLifecycleErrorCode.ActionNotAmendable,
      phase,
      plugin: record.plugin.name,
      message: `Plugin "${record.plugin.name}" cannot describe action "${actionId}": it is not one of its own actions, nor in a binding it registered a projection for. Call $describeAction only for actions the plugin declared or whose binding it owns.`,
    });
  }

  #registerProjection(
    record: PluginRecord<TOpen, TClose, TPhases>,
    projection: Omit<ProjectionManifest, 'plugin'>,
  ): void {
    record.projections.push({ ...projection, plugin: record.plugin.name });
  }

  #registerRouteShim(
    record: PluginRecord<TOpen, TClose, TPhases>,
    route: Parameters<DotConfigureContext['registerRoute']>[0],
  ): void {
    const meta: JsonObject = {};
    if (route.method !== undefined) meta['method'] = route.method;
    if (route.path !== undefined) meta['path'] = route.path;
    if (route.input !== undefined) {
      const input: JsonObject = {};
      if (route.input.query !== undefined) input['query'] = route.input.query;
      if (route.input.body !== undefined) input['body'] = route.input.body;
      if (Object.keys(input).length > 0) meta['input'] = input;
    }
    if (route.output !== undefined) meta['output'] = route.output;
    if (route.streaming !== undefined) meta['streaming'] = route.streaming;

    this.#registerAction(record, {
      id: route.id,
      binding: route.transport,
      direction: 'in',
      ...(route.path === undefined ? {} : { address: `${route.method ?? 'GET'} ${route.path}` }),
      ...(route.description === undefined ? {} : { summary: route.description }),
      ...(Object.keys(meta).length === 0 ? {} : { meta }),
    });
  }

  #actionFromSource(source: AnyPlugin['actions'][number]): Omit<ActionManifest, 'plugin'> {
    if (hasToDotAction(source)) {
      return source.toDotAction();
    }
    return source;
  }

  /**
   * Wrap a sync phase body with starting/completed/failed observer events.
   * `configure` is the only sync phase in the kernel today — keep the
   * async variant separate (no monomorphisation cost on the hot path).
   */
  #withPhaseEmit<Value>(phase: DotLifecycleHook, fn: () => Value): Value {
    const phaseStart = nowMs();
    this.#emitIfObserved(() => ({
      kind: 'phase',
      phase,
      status: 'starting',
      appName: this.#appName,
      timestamp: Date.now(),
    }));
    try {
      const result = fn();
      this.#emitIfObserved(() => ({
        kind: 'phase',
        phase,
        status: failed(result) ? 'failed' : 'completed',
        appName: this.#appName,
        durationMs: nowMs() - phaseStart,
        timestamp: Date.now(),
        ...(failed(result) ? { error: result } : {}),
      }));
      return result;
    } catch (error) {
      this.#emitIfObserved(() => ({
        kind: 'phase',
        phase,
        status: 'failed',
        appName: this.#appName,
        durationMs: nowMs() - phaseStart,
        error,
        timestamp: Date.now(),
      }));
      throw error;
    }
  }

  /** Async variant of {@link #withPhaseEmit}. */
  async #withPhaseEmitAsync<Value>(phase: DotLifecycleHook, fn: () => Promise<Value>): Promise<Value> {
    const phaseStart = nowMs();
    this.#emitIfObserved(() => ({
      kind: 'phase',
      phase,
      status: 'starting',
      appName: this.#appName,
      timestamp: Date.now(),
    }));
    try {
      const result = await fn();
      if (failed(result)) {
        this.#emitIfObserved(() => ({
          kind: 'phase',
          phase,
          status: 'failed',
          appName: this.#appName,
          durationMs: nowMs() - phaseStart,
          error: result,
          timestamp: Date.now(),
        }));
      } else {
        this.#emitIfObserved(() => ({
          kind: 'phase',
          phase,
          status: 'completed',
          appName: this.#appName,
          durationMs: nowMs() - phaseStart,
          timestamp: Date.now(),
        }));
      }
      return result;
    } catch (error) {
      this.#emitIfObserved(() => ({
        kind: 'phase',
        phase,
        status: 'failed',
        appName: this.#appName,
        durationMs: nowMs() - phaseStart,
        error,
        timestamp: Date.now(),
      }));
      throw error;
    }
  }

  get name(): string {
    return this.#appName;
  }

  get state(): DotLifecycleState {
    return this.#state;
  }

  get services(): Record<string, unknown> {
    return this.#aggregatedServices;
  }

  get manifest(): DotAppManifest {
    return this.#manifest;
  }

  get diagnostics(): DotDiagnosticsSnapshot {
    return this.#buildDiagnostics();
  }

  /**
   * Run the `configure` phase synchronously. Idempotent.
   *
   * @throws {DotLifecycleError} if any configure hook throws or returns a Promise.
   */
  runConfigure(): DotConfigureOutcome<TPhases> {
    if (this.#configured) return;
    if (this.#state === 'failed' || this.#state === 'disposed') {
      return this.#reuseDefect('configure');
    }

    kernelLog.debug('[{dot.app.name}] registering {dot.app.plugin.count} plugin(s) in declaration order', {
      'dot.app.name': this.#appName,
      'dot.app.plugin.count': this.#ordered.length,
    });

    const phaseLogger = this.#logger.with({ 'dot.app.phase': 'configure' });
    phaseLogger.debug('configure: starting', { 'dot.app.plugin.count': this.#ordered.length });

    try {
      return this.#withPhaseEmit('configure', () => {
        return withPhaseSpan(
          {
            appName: this.#appName,
            phase: 'configure',
            pluginCount: this.#ordered.length,
          },
          span => this.#runConfigureInner(phaseLogger.withTrace(span.spanContext())),
        );
      });
    } catch (error) {
      this.#state = 'failed';
      return UnexpectedDefect({ cause: error });
    }
  }

  /**
   * Activate the logging slot, once, before the first lifecycle record. A
   * factory that throws fails the app in `boot`.
   */
  #activateLogging(): undefined | TOpen | ReturnType<typeof UnexpectedDefect> {
    const owner = this.#loggingPlugin;
    if (owner?.logging === undefined || this.#logging !== undefined || this.#loggingClosed !== undefined) return;
    try {
      const result = owner.logging({ appName: this.#appName });
      if (!loggingHandle(result)) {
        this.#state = 'failed';
        const record = this.#records.get(owner.name);
        if (record !== undefined) this.#recordHookFailure(record, 'boot', result, 0);
        return result;
      }
      this.#logging = result;
      return;
    } catch (error) {
      this.#state = 'failed';
      return UnexpectedDefect({
        cause: new DotLifecycleError({
          code: DotLifecycleErrorCode.BootFailed,
          phase: 'boot',
          plugin: owner.name,
          message: `logging slot of plugin "${owner.name}" threw: ${stringifyError(error)}`,
          cause: error,
        }),
      });
    }
  }

  /**
   * Close the logging slot, once, after the app's last lifecycle record.
   * Never rejects: a failed close is reported and returned to its owner.
   */
  #closeLogging(): Promise<void | TClose | ReturnType<typeof UnexpectedDefect>> {
    if (this.#loggingClosed === undefined) {
      const handle = this.#logging;
      this.#logging = undefined;
      this.#loggingClosed =
        handle === undefined
          ? Promise.resolve()
          : (async (): Promise<void | TClose | ReturnType<typeof UnexpectedDefect>> => {
              try {
                const result = await handle.close();
                if (failed(result)) {
                  const record =
                    this.#loggingPlugin === undefined ? undefined : this.#records.get(this.#loggingPlugin.name);
                  if (record !== undefined) this.#recordHookFailure(record, 'dispose', result, 0);
                  reportLoggingCloseFailure(result);
                  return result;
                }
              } catch (error) {
                const failure = UnexpectedDefect({
                  cause: new DotLifecycleError({
                    code: DotLifecycleErrorCode.DisposeFailed,
                    phase: 'dispose',
                    plugin: this.#loggingPlugin?.name,
                    message: 'The logging slot failed to close.',
                    cause: error,
                  }),
                });
                const record =
                  this.#loggingPlugin === undefined ? undefined : this.#records.get(this.#loggingPlugin.name);
                if (record !== undefined) this.#recordHookFailure(record, 'dispose', failure, 0);
                reportLoggingCloseFailure(error);
                return failure;
              }
              return;
            })();
    }
    return this.#loggingClosed;
  }

  /**
   * Inner configure loop. Separated from `runConfigure` so the phase span
   * wrapper can stay thin and the loop body stays unindented — keeps the
   * intricate error-handling readable.
   */
  #runConfigureInner(phaseLogger: Logger): void | TPhases['configure'] {
    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      let pluginLogger = phaseLogger.with({ 'dot.plugin.name': plugin.name });
      const declaredStarted = nowMs();
      try {
        for (const source of plugin.actions) this.#registerAction(record, this.#actionFromSource(source));
      } catch (error) {
        const durationMs = nowMs() - declaredStarted;
        const issue = makeIssue({
          code: DotLifecycleErrorCode.ConfigureFailed,
          plugin: plugin.name,
          message: `action declaration threw for plugin "${plugin.name}": ${stringifyError(error)}`,
          remediation: `Fix the action declarations of "${plugin.name}". Declarative actions must be static and synchronous.`,
          docsAnchor: 'configure-failed',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          plugin: plugin.name,
          hook: 'configure',
          state: 'failed',
          order: record.order,
          durationMs,
          issues: [issue],
        });
        this.#emitHook('configure', plugin.name, record.order, 'failed', { durationMs, error });
        this.#state = 'failed';
        this.#manifest = this.#buildManifest();
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.ConfigureFailed,
          phase: 'configure',
          plugin: plugin.name,
          message: issue.message,
          cause: error,
        });
      }

      if (!plugin.hooks.configure) {
        pluginLogger.debug('configure: skipped (no hook)');
        continue;
      }
      record.hooks.add('configure');

      const ctx: DotConfigureContext = {
        pluginName: plugin.name,
        appName: this.#appName,
        registerService: (name, kind) => {
          record.services.push({ name, plugin: plugin.name, kind });
        },
        registerAction: action => this.#registerAction(record, action),
        registerProjection: projection => this.#registerProjection(record, projection),
        describeAction: (actionId, patch) => this.#describeAction(record, 'configure', actionId, patch),
        registerRoute: route => this.#registerRouteShim(record, route),
        registerLifecycleHook: hook => {
          record.hooks.add(hook);
        },
        declareProvides: (...caps) => {
          for (const cap of caps) record.provides.add(cap);
        },
      };

      const started = nowMs();
      this.#emitHook('configure', plugin.name, record.order, 'starting');
      let returned: void | TPhases['configure'];
      try {
        returned = withPluginHookSpan(
          {
            appName: this.#appName,
            pluginName: plugin.name,
            hook: 'configure',
            order: record.order,
          },
          span => {
            // Later records of this plugin's hook carry its span too.
            pluginLogger = pluginLogger.withTrace(span.spanContext());
            return plugin.hooks.configure?.(ctx);
          },
        );
        if (returned !== undefined && !failed(returned) && !isThenable(returned)) {
          throw new Error('configure must return undefined or a Failure', { cause: returned });
        }
      } catch (error) {
        const durationMs = nowMs() - started;
        const issue = makeIssue({
          code: DotLifecycleErrorCode.ConfigureFailed,
          plugin: plugin.name,
          message: `configure hook threw for plugin "${plugin.name}": ${stringifyError(error)}`,
          remediation: `Fix the error in the configure() hook of "${plugin.name}". configure() is for synchronous registration only — avoid throwing on declarative work.`,
          docsAnchor: 'configure-failed',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          plugin: plugin.name,
          hook: 'configure',
          state: 'failed',
          order: record.order,
          durationMs,
          issues: [issue],
        });
        this.#emitHook('configure', plugin.name, record.order, 'failed', { durationMs, error });
        this.#state = 'failed';
        this.#manifest = this.#buildManifest();
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.ConfigureFailed,
          phase: 'configure',
          plugin: plugin.name,
          message: issue.message,
          cause: error,
        });
      }

      if (isThenable(returned)) {
        // Reject async configure immediately, but observe already-started work.
        void Promise.resolve(returned).catch(() => {
          /* The invalid configure result is already reported below. */
        });
        const durationMs = nowMs() - started;
        const issue = makeIssue({
          code: DotLifecycleErrorCode.ConfigureAsync,
          plugin: plugin.name,
          message: `configure hook of plugin "${plugin.name}" returned a Promise. configure must be synchronous.`,
          remediation: 'Move async work to the boot() hook. configure() is for synchronous registration only.',
          docsAnchor: 'configure-async',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          plugin: plugin.name,
          hook: 'configure',
          state: 'failed',
          order: record.order,
          durationMs,
          issues: [issue],
        });
        this.#emitHook('configure', plugin.name, record.order, 'failed', {
          durationMs,
          error: new Error(issue.message),
        });
        this.#state = 'failed';
        this.#manifest = this.#buildManifest();
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.ConfigureAsync,
          phase: 'configure',
          plugin: plugin.name,
          message: issue.message,
        });
      }

      if (failed(returned)) {
        this.#recordHookFailure(record, 'configure', returned, nowMs() - started);
        this.#state = 'failed';
        this.#manifest = this.#buildManifest();
        return returned;
      }

      const durationMs = nowMs() - started;
      record.lifecycleDiagnostics.push({
        plugin: plugin.name,
        hook: 'configure',
        state: 'configured',
        order: record.order,
        durationMs,
        issues: [],
      });
      this.#emitHook('configure', plugin.name, record.order, 'completed', { durationMs });
      pluginLogger.debug('configure: done', { 'dot.plugin.duration.ms': durationMs });
    }

    // Also declare lifecycle-hook participation for non-configure hooks present
    // on the plugin object, so the manifest reflects them.
    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      if (plugin.hooks.boot || Object.keys(plugin.factories).length > 0) record.hooks.add('boot');
      if (plugin.hooks.start) record.hooks.add('start');
      if (plugin.hooks.stop) record.hooks.add('stop');
      if (plugin.hooks.dispose) record.hooks.add('dispose');
    }

    this.#configured = true;
    this.#state = 'configured';
    this.#manifest = this.#buildManifest();
    phaseLogger.debug('configure: complete', { 'dot.app.plugin.count': this.#ordered.length });
  }

  /**
   * Run one lifecycle transition after all previously enqueued ones.
   * The chain itself never rejects — each link swallows its error for
   * the *next* link only; the caller still receives the original
   * rejection through the returned promise.
   */
  #enqueueTransition<T>(run: () => Promise<T>): Promise<T> {
    const result = this.#transitionChain.then(run);
    // The chain link settles even when the transition fails — the caller
    // still sees the original rejection through `result`.
    this.#transitionChain = result.catch(() => null);
    return result;
  }

  /** Public boot() — idempotent + concurrent-safe. */
  async boot(): Promise<DotBootOutcome<TOpen, TClose, TPhases> | DotConfigureOutcome<TPhases>> {
    if (this.#bootInflight) return this.#bootInflight;
    this.#bootInflight = this.#enqueueTransition(() => this.#bootTransition()).finally(() => {
      this.#bootInflight = null;
    });
    return this.#bootInflight;
  }

  /** State checks + boot body. Runs at the head of the transition queue. */
  async #bootTransition(): Promise<DotBootOutcome<TOpen, TClose, TPhases> | DotConfigureOutcome<TPhases>> {
    if (this.#state === 'failed' || this.#state === 'disposed') {
      return this.#reuseDefect('boot');
    }
    if (this.#state === 'booted' || this.#state === 'started' || this.#state === 'stopped') {
      return;
    }
    const configured = this.runConfigure();
    if (failed(configured)) return configured;
    return this.#runBoot();
  }

  /** Boot an already configured app, without reaching configure callbacks. */
  bootConfigured(): Promise<DotBootOutcome<TOpen, TClose, TPhases>> {
    if (this.#bootConfiguredInflight) return this.#bootConfiguredInflight;
    this.#bootConfiguredInflight = this.#enqueueTransition(async () => {
      if (this.#state === 'failed' || this.#state === 'disposed') return this.#reuseDefect('boot');
      if (this.#state !== 'configured') return;
      return this.#runBoot();
    }).finally(() => {
      this.#bootConfiguredInflight = null;
    });
    return this.#bootConfiguredInflight;
  }

  async #runBoot(): Promise<DotBootOutcome<TOpen, TClose, TPhases>> {
    try {
      const activated = this.#activateLogging();
      if (failed(activated)) return activated;
    } catch (error) {
      return UnexpectedDefect({ cause: error });
    }
    const phaseLogger = this.#logger.with({ 'dot.app.phase': 'boot' });
    phaseLogger.debug('boot: starting', { 'dot.app.plugin.count': this.#ordered.length });

    return this.#withPhaseEmitAsync('boot', () =>
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'boot',
          pluginCount: this.#ordered.length,
        },
        span => this.#runBootInner(phaseLogger.withTrace(span.spanContext())),
      ),
    );
  }

  /**
   * Resolve a plugin's needs into a hook context (alias-keyed), joined with
   * the `$`-prefixed kernel keys and — for post-boot hooks — the plugin's own
   * published services (local keys).
   *
   * @throws {DotLifecycleError} `ARKI_DOT_E012` when a need has no
   *   provider among earlier-booted plugins. Teardown hooks can never hit
   *   this: the service map only grows, and reverse-order teardown keeps
   *   providers alive until their consumers are done.
   */
  #buildHookCtx(
    record: PluginRecord<TOpen, TClose, TPhases>,
    phase: DotLifecycleHook,
    includeOwnProvides: boolean,
    signal: AbortSignal,
  ): Record<string, unknown> {
    const ctx: Record<string, unknown> = {
      $app: this.#appName,
      $plugin: record.plugin.name,
      $config: this.#config,
      $signal: signal,
      $describeAction: (actionId: string, patch: { readonly summary: string }) =>
        this.#describeAction(record, phase, actionId, patch),
    };
    for (const [alias, witness] of Object.entries(record.plugin.needs)) {
      const wireKey = wireKeyOf(witness, alias);
      if (!this.#serviceMap.has(wireKey)) {
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.UnsatisfiedNeed,
          phase,
          plugin: record.plugin.name,
          message:
            `Plugin "${record.plugin.name}" needs service "${wireKey}" but no earlier plugin provides it. ` +
            `Register a provider with .use() before this plugin. Services flow strictly forward — ` +
            `if a later plugin provides "${wireKey}", move that provider earlier; if two plugins need ` +
            `each other's services, that is a cycle: merge them or extract the shared piece into ` +
            `a third plugin both consume.`,
        });
      }
      const value = this.#serviceMap.get(wireKey);
      // A lazy-lifting witness (`service.lazy<T>()`) always receives a
      // handle: lazy provides pass through, eager provides are lifted into
      // a pre-initialized wrapper. The wrapper is created per-injection and
      // never published, so the kernel's auto-dispose does not touch it —
      // the underlying value's lifecycle stays with its provider.
      ctx[alias] = isLazyWitness(witness) && !isLazy(value) ? lazyOf(value) : value;
      const provider = this.#providerByWireKey.get(wireKey);
      if (provider !== undefined && !this.#wiringEdges.some(e => e.from === record.plugin.name && e.to === provider)) {
        this.#wiringEdges.push({ from: record.plugin.name, to: provider, kind: 'requires' });
      }
    }
    if (includeOwnProvides) {
      Object.assign(ctx, record.publishedServices);
    }
    return ctx;
  }

  /**
   * Request cancellation when the injected Clock reaches the hook budget.
   * Owned work must settle before cleanup; JavaScript that ignores its signal
   * cannot be forcibly stopped. Construction reports canonical Deadline, while
   * legacy hooks retain the lifecycle timeout diagnostic after they settle.
   */
  async #withHookBudget<T>(
    pluginName: string,
    hook: DotLifecycleHook,
    hookAbort: AbortController,
    run: () => Promise<T> | T,
  ): Promise<T> {
    const budget = this.#hookTimeoutMs;
    if (budget === undefined) return run();
    let timeout: DotLifecycleError | undefined;
    const cancel = this.#clock.setTimer(() => {
      timeout = new DotLifecycleError({
        code: DotLifecycleErrorCode.HookTimeout,
        phase: hook,
        plugin: pluginName,
        message: `${hook} hook of plugin "${pluginName}" exceeded its ${budget}ms budget; cancellation was requested and owned work must settle before cleanup.`,
      });
      hookAbort.abort(timeout);
    }, budget);
    try {
      const result = await run();
      // Owned construction reports the canonical deadline after joining its scope.
      if (timeout !== undefined && !isFailure<unknown>(result)) throw timeout;
      return result;
    } finally {
      cancel();
    }
  }

  /**
   * Inner boot loop. Separated from `#runBoot` so the phase span wrapper
   * stays thin and the loop body — which orchestrates rollback on
   * partial failure — stays unindented.
   */
  async #runBootInner(phaseLogger: Logger): Promise<DotBootOutcome<TOpen, TClose, TPhases>> {
    const bootedRecords: PluginRecord<TOpen, TClose, TPhases>[] = [];

    /** Shared failure path: mark diagnostics, roll back, throw. */
    const fail = async (args: {
      record: PluginRecord<TOpen, TClose, TPhases>;
      code: (typeof DotLifecycleErrorCode)[keyof typeof DotLifecycleErrorCode];
      message: string;
      remediation: string;
      docsAnchor: string;
      durationMs: number;
      cause?: unknown;
      /** Records to dispose (reverse order applied here). */
      rollback: readonly PluginRecord<TOpen, TClose, TPhases>[];
    }): Promise<DotBootOutcome<TOpen, TClose, TPhases>> => {
      const issue = makeIssue({
        code: args.code,
        plugin: args.record.plugin.name,
        message: args.message,
        remediation: args.remediation,
        docsAnchor: args.docsAnchor,
      });
      args.record.issues.push(issue);
      args.record.lifecycleDiagnostics.push({
        plugin: args.record.plugin.name,
        hook: 'boot',
        state: 'failed',
        order: args.record.order,
        durationMs: args.durationMs,
        issues: [issue],
      });
      this.#emitHook('boot', args.record.plugin.name, args.record.order, 'failed', {
        durationMs: args.durationMs,
        error: args.cause ?? new Error(args.message),
      });
      phaseLogger.error('boot: FAILED — rolling back already-booted plugins', {
        'dot.plugin.name': args.record.plugin.name,
        'dot.app.rollback.count': args.rollback.length,
      });
      const disposeFailures = await this.#runDisposeForRecords(reverseRecords(args.rollback), phaseLogger);
      const logging = await this.#closeLogging();
      if (failed(logging)) disposeFailures.failures.push(logging);
      this.#state = 'failed';
      this.#manifest = this.#buildManifest();
      return startupOutcome(
        UnexpectedDefect({
          cause: new DotLifecycleError({
            code: args.code,
            phase: 'boot',
            plugin: args.record.plugin.name,
            message: args.message,
            cause: args.cause,
          }),
        }),
        disposeFailures.failures,
      );
    };

    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      let pluginLogger = phaseLogger.with({ 'dot.plugin.name': plugin.name });
      const started = nowMs();

      // Resolve needs BEFORE invoking the hook — a plugin with needs but no
      // boot hook still fails fast when its wiring is unsatisfied.
      let ctx: Record<string, unknown>;
      const hookAbort = new AbortController();
      try {
        ctx = this.#buildHookCtx(record, 'boot', false, hookAbort.signal);
      } catch (error) {
        const message = error instanceof DotLifecycleError ? error.message : stringifyError(error);
        return fail({
          record,
          code: DotLifecycleErrorCode.UnsatisfiedNeed,
          message,
          remediation:
            `Add a provider for the missing service with .use() before "${plugin.name}", or rename an ` +
            `existing provider's keys to match. If a later plugin provides it, reorder — services flow ` +
            `strictly forward. Mutual needs between two plugins are a cycle: merge them or extract the ` +
            `shared piece into a third plugin both consume.`,
          docsAnchor: 'unsatisfied-need',
          durationMs: nowMs() - started,
          rollback: bootedRecords,
        });
      }

      const bootHook = plugin.hooks.boot;
      const factories = Object.entries(plugin.factories);
      if (!bootHook && factories.length === 0) {
        record.booted = true;
        bootedRecords.push(record);
        pluginLogger.debug('boot: skipped (no hook)');
        continue;
      }
      record.hooks.add('boot');

      this.#emitHook('boot', plugin.name, record.order, 'starting');
      let construction: Awaited<ReturnType<typeof plugin.runtime.construct>>;
      try {
        construction = await this.#withHookBudget(plugin.name, 'boot', hookAbort, () =>
          withPluginHookSpan(
            { appName: this.#appName, pluginName: plugin.name, hook: 'boot', order: record.order },
            span => {
              pluginLogger = pluginLogger.withTrace(span.spanContext());
              return plugin.runtime.construct(
                plugin.factories,
                bootHook,
                ctx as never,
                { deadline: hookAbort.signal },
                value => {
                  if (this.#lazyOwners.has(value)) return false;
                  this.#lazyOwners.add(value);
                  return true;
                },
              );
            },
          ),
        );
      } catch (error) {
        construction = this.#hookDefect('boot', plugin.name, error);
      }
      if (!constructed<TOpen, TClose>(construction)) {
        const timedOut = Deadline.is(construction);
        const durationMs = nowMs() - started;
        const issue = makeIssue({
          code: timedOut ? DotLifecycleErrorCode.HookTimeout : DotLifecycleErrorCode.BootFailed,
          plugin: plugin.name,
          message: `Plugin "${plugin.name}" construction failed.`,
          remediation: 'Inspect the plugin failure and its owned cleanup outcomes.',
          docsAnchor: timedOut ? 'hook-timeout' : 'boot-failed',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          plugin: plugin.name,
          hook: 'boot',
          state: 'failed',
          order: record.order,
          durationMs,
          issues: [issue],
        });
        this.#emitHook('boot', plugin.name, record.order, 'failed', { durationMs, error: construction });
        pluginLogger.error('boot: FAILED — closing owned scopes', { 'dot.plugin.name': plugin.name });
        const cleanup = await this.#runDisposeForRecords(reverseRecords(bootedRecords), phaseLogger);
        const logging = await this.#closeLogging();
        if (failed(logging)) cleanup.failures.push(logging);
        this.#state = 'failed';
        this.#manifest = this.#buildManifest();
        return startupOutcome(construction, cleanup.failures);
      }
      record.lifetime = construction;
      const result = construction.services;

      const publishedServices: ServiceRecord = result;
      record.publishedServices = publishedServices;
      record.booted = true;

      for (const localKey of Object.keys(publishedServices)) {
        const wireKey = plugin.renames[localKey] ?? localKey;
        if (localKey.startsWith('$') || wireKey.startsWith('$')) {
          // The plugin() constraint bans this at compile time; erased plugins can
          // still reach here. A `$` publish would shadow $app/$plugin/$config
          // in the plugin's own post-boot hook contexts.
          return fail({
            record,
            code: DotLifecycleErrorCode.ReservedServiceKey,
            message:
              `Plugin "${plugin.name}" publishes service "${wireKey}" — the "$" prefix is reserved ` +
              `for kernel context keys ($app, $plugin, $config).`,
            remediation: `Rename the "${wireKey}" provides key of "${plugin.name}" — "$"-prefixed keys would shadow the kernel context.`,
            docsAnchor: 'reserved-service-key',
            durationMs: nowMs() - started,
            rollback: [...bootedRecords, record],
          });
        }
        if (this.#serviceMap.has(wireKey)) {
          const owner = this.#providerByWireKey.get(wireKey) ?? 'unknown';
          // The current plugin HAS booted — include it in the rollback.
          return fail({
            record,
            code: DotLifecycleErrorCode.ServiceCollision,
            message: `Plugin "${plugin.name}" publishes service "${wireKey}" which plugin "${owner}" already provides.`,
            remediation: `Mount one of the two with rename(plugin, { '${wireKey}': '<newKey>' }) to keep both instances, or remove the duplicate provider.`,
            docsAnchor: 'service-collision',
            durationMs: nowMs() - started,
            rollback: [...bootedRecords, record],
          });
        }
      }
      for (const [localKey, value] of Object.entries(publishedServices)) {
        const wireKey = plugin.renames[localKey] ?? localKey;
        this.#serviceMap.set(wireKey, value);
        this.#providerByWireKey.set(wireKey, plugin.name);
        this.#aggregatedServices[wireKey] = value;
        record.provides.add(wireKey);
      }
      bootedRecords.push(record);

      const durationMs = nowMs() - started;
      record.lifecycleDiagnostics.push({
        plugin: plugin.name,
        hook: 'boot',
        state: 'booted',
        order: record.order,
        durationMs,
        issues: [],
      });
      this.#emitHook('boot', plugin.name, record.order, 'completed', { durationMs });
      pluginLogger.debug('boot: done', {
        'dot.plugin.duration.ms': durationMs,
        'dot.plugin.services.published': Object.keys(publishedServices).length,
      });
    }

    this.#state = 'booted';
    this.#manifest = this.#buildManifest();
    phaseLogger.debug('boot: complete', { 'dot.app.plugin.count': this.#ordered.length });
  }

  /** Public start(). Boots first if needed. Idempotent + concurrent-safe. */
  async start(): Promise<DotStartOutcome<TOpen, TClose, TPhases> | DotConfigureOutcome<TPhases>> {
    if (this.#startInflight) return this.#startInflight;
    this.#startInflight = this.#enqueueTransition(async () => {
      const configured = this.runConfigure();
      if (failed(configured)) return configured;
      return this.#startTransition();
    }).finally(() => {
      this.#startInflight = null;
    });
    return this.#startInflight;
  }

  /** Start an already configured app; configure failures are unreachable. */
  startConfigured(): Promise<DotStartOutcome<TOpen, TClose, TPhases>> {
    if (this.#startConfiguredInflight) return this.#startConfiguredInflight;
    this.#startConfiguredInflight = this.#enqueueTransition(() => this.#startTransition()).finally(() => {
      this.#startConfiguredInflight = null;
    });
    return this.#startConfiguredInflight;
  }

  /** Start an already booted app; configure and boot failures are unreachable. */
  startBooted(): Promise<DotStartedOutcome<TClose, TPhases>> {
    if (this.#startBootedInflight) return this.#startBootedInflight;
    this.#startBootedInflight = this.#enqueueTransition(() => this.#startBootedTransition()).finally(() => {
      this.#startBootedInflight = null;
    });
    return this.#startBootedInflight;
  }

  /** State checks + start body. Runs at the head of the transition queue. */
  async #startTransition(): Promise<DotStartOutcome<TOpen, TClose, TPhases>> {
    if (this.#state === 'failed' || this.#state === 'disposed') {
      return this.#reuseDefect('start');
    }
    if (this.#state === 'started') return;
    if (this.#state === 'defined' || this.#state === 'configured') {
      // Direct #runBoot — we already hold the head of the transition
      // queue; going through public boot() would enqueue behind
      // ourselves and deadlock.
      const booted = await this.#runBoot();
      if (failed(booted)) return booted;
    }
    return this.#startBootedTransition();
  }

  async #startBootedTransition(): Promise<DotStartedOutcome<TClose, TPhases>> {
    if (this.#state === 'failed' || this.#state === 'disposed') return this.#reuseDefect('start');
    if (this.#state === 'started') return;
    // From booted or stopped, run start hooks.
    const phaseLogger = this.#logger.with({ 'dot.app.phase': 'start' });
    phaseLogger.debug('start: starting', { 'dot.app.plugin.count': this.#ordered.length });

    return this.#withPhaseEmitAsync('start', () =>
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'start',
          pluginCount: this.#ordered.length,
        },
        span => this.#runStartInner(phaseLogger.withTrace(span.spanContext())),
      ),
    );
  }

  /**
   * Inner start loop. Separated from `start()` so the phase span wrapper
   * stays thin and the rollback-cascade error path stays readable.
   */
  async #runStartInner(phaseLogger: Logger): Promise<DotStartedOutcome<TClose, TPhases>> {
    const startedRecords: PluginRecord<TOpen, TClose, TPhases>[] = [];
    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      const pluginLogger = phaseLogger.with({ 'dot.plugin.name': plugin.name });
      if (!plugin.hooks.start) {
        record.started = true;
        startedRecords.push(record);
        pluginLogger.debug('start: skipped (no hook)');
        continue;
      }
      record.hooks.add('start');

      const result = await this.#runHook(record, 'start', pluginLogger);
      if (failed(result)) {
        pluginLogger.error('start: FAILED — rolling back', { 'dot.app.rollback.started.count': startedRecords.length });
        const stopFailures = await this.#runStopForRecords(reverseRecords(startedRecords), phaseLogger);
        const bootedForDispose = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.booted);
        const disposeFailures = await this.#runDisposeForRecords(reverseRecords(bootedForDispose), phaseLogger);
        const logging = await this.#closeLogging();
        if (failed(logging)) disposeFailures.failures.push(logging);
        this.#state = 'failed';
        this.#manifest = this.#buildManifest();
        return startupOutcome(result, [...stopFailures, ...disposeFailures.failures]);
      }

      record.started = true;
      startedRecords.push(record);
    }

    this.#state = 'started';
    this.#manifest = this.#buildManifest();
    phaseLogger.debug('start: complete', { 'dot.app.plugin.count': this.#ordered.length });
  }

  /** Public stop(). Idempotent + concurrent-safe. */
  async stop(): Promise<DotStopOutcome<TPhases>> {
    if (this.#stopInflight) return this.#stopInflight;
    this.#stopInflight = this.#enqueueTransition(() => this.#stopTransition()).finally(() => {
      this.#stopInflight = null;
    });
    return this.#stopInflight;
  }

  /** State checks + stop body. Runs at the head of the transition queue. */
  async #stopTransition(): Promise<DotStopOutcome<TPhases>> {
    // stop() after dispose is a no-op (idempotent across terminal states only
    // for `disposed`; `failed` was already cleaned up).
    if (this.#state === 'disposed') return;
    if (this.#state === 'failed') return this.#reuseDefect('stop');
    // For non-started states (defined/configured/booted/stopped): no-op.
    if (this.#state !== 'started') {
      // Mark booted as "stopped" for state-machine clarity.
      if (this.#state === 'booted') this.#state = 'stopped';
      return;
    }
    return this.#runStop();
  }

  async #runStop(): Promise<DotStopOutcome<TPhases>> {
    const phaseLogger = this.#logger.with({ 'dot.app.phase': 'stop' });
    phaseLogger.debug('stop: starting', { 'dot.app.plugin.count': this.#ordered.length });

    return this.#withPhaseEmitAsync('stop', () =>
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'stop',
          pluginCount: this.#ordered.length,
        },
        async span => {
          const tracedLogger = phaseLogger.withTrace(span.spanContext());
          const startedRecords = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.started);
          const failures = await this.#runStopForRecords(reverseRecords(startedRecords), tracedLogger);
          this.#state = 'stopped';
          this.#manifest = this.#buildManifest();
          if (failures.length > 0) {
            tracedLogger.warn('stop: complete with failures', { 'dot.app.failure.count': failures.length });
            return closeOutcome(failures);
          }
          tracedLogger.debug('stop: complete', { 'dot.app.plugin.count': this.#ordered.length });
          return;
        },
      ),
    );
  }

  async #runStopForRecords(
    records: readonly PluginRecord<TOpen, TClose, TPhases>[],
    phaseLogger: Logger,
  ): Promise<(TPhases['stop'] | SupervisorFailure)[]> {
    const failures: (TPhases['stop'] | SupervisorFailure)[] = [];
    for (const record of records) {
      if (record.plugin.hooks.stop) {
        const result = await this.#runHook(record, 'stop', phaseLogger.with({ 'dot.plugin.name': record.plugin.name }));
        if (failed(result)) failures.push(result);
      }
      record.started = false;
    }
    return failures;
  }

  /** Public dispose(). Idempotent + concurrent-safe. */
  async dispose(): Promise<DotDisposeOutcome<TClose, TPhases>> {
    if (this.#disposeInflight) return this.#disposeInflight;
    this.#disposeInflight = this.#enqueueTransition(() => this.#disposeTransition());
    return this.#disposeInflight;
  }

  /** State check + dispose body. Runs at the head of the transition queue. */
  async #disposeTransition(): Promise<DotDisposeOutcome<TClose, TPhases>> {
    if (this.#state === 'disposed') return;
    return this.#runDispose();
  }

  async #runDispose(): Promise<DotDisposeOutcome<TClose, TPhases>> {
    const phaseLogger = this.#logger.with({ 'dot.app.phase': 'dispose' });
    phaseLogger.debug('dispose: starting', { 'dot.app.plugin.count': this.#ordered.length });

    return this.#withPhaseEmitAsync('dispose', () =>
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'dispose',
          pluginCount: this.#ordered.length,
        },
        span => this.#runDisposeInner(phaseLogger.withTrace(span.spanContext())),
      ),
    );
  }

  /**
   * Inner dispose orchestration. Separated from `#runDispose` so the
   * phase span wrapper stays thin and the multi-state cascade (started
   * → stop+dispose, failed → no-op, default → dispose-only) stays
   * readable.
   */
  async #runDisposeInner(phaseLogger: Logger): Promise<DotDisposeOutcome<TClose, TPhases>> {
    const failures: CleanupMember<TClose, TPhases>[] = [];
    if (this.#state === 'started') {
      const startedRecords = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.started);
      failures.push(...(await this.#runStopForRecords(reverseRecords(startedRecords), phaseLogger)));
      this.#state = 'stopped';
    }
    if (this.#state !== 'failed') {
      const bootedRecords = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.booted);
      const disposal = await this.#runDisposeForRecords(reverseRecords(bootedRecords), phaseLogger);
      failures.push(...disposal.failures);
    }
    const failedStartup = this.#state === 'failed';
    phaseLogger.debug('dispose: complete', { 'dot.app.failure.count': failures.length });
    if (!failedStartup) {
      const logging = await this.#closeLogging();
      if (failed(logging)) failures.push(logging);
    }
    this.#state = 'disposed';
    this.#manifest = this.#buildManifest();
    return closeOutcome(failures);
  }

  async #runDisposeForRecords(
    records: readonly PluginRecord<TOpen, TClose, TPhases>[],
    phaseLogger: Logger,
  ): Promise<{ readonly failures: DisposeMember<TClose, TPhases>[] }> {
    const failures: DisposeMember<TClose, TPhases>[] = [];
    for (const record of records) {
      const lifetime = record.lifetime;
      // Quiesce joins tasks before user finalizers. close() owns the final
      // task/resource result, so its result is recorded exactly once below.
      if (lifetime !== undefined) {
        try {
          await lifetime.quiesce();
        } catch (error) {
          const failure = this.#hookDefect('dispose', record.plugin.name, error);
          failures.push(failure);
          this.#recordHookFailure(record, 'dispose', failure, 0);
        }
      }
      if (record.plugin.hooks.dispose) {
        const result = await this.#runHook(
          record,
          'dispose',
          phaseLogger.with({ 'dot.plugin.name': record.plugin.name }),
        );
        if (failed(result)) failures.push(result);
      }
      if (lifetime !== undefined) {
        const startedAt = nowMs();
        try {
          const result = await lifetime.close();
          if (failed(result)) {
            failures.push(result);
            this.#recordHookFailure(record, 'dispose', result, nowMs() - startedAt);
          }
        } catch (error) {
          const failure = this.#hookDefect('dispose', record.plugin.name, error);
          failures.push(failure);
          this.#recordHookFailure(record, 'dispose', failure, nowMs() - startedAt);
        } finally {
          record.lifetime = undefined;
        }
      }
      record.booted = false;
    }
    return { failures };
  }

  #hookDefect(phase: DotLifecycleHook, plugin: string, error: unknown): SupervisorFailure {
    const code =
      phase === 'boot'
        ? DotLifecycleErrorCode.BootFailed
        : phase === 'start'
          ? DotLifecycleErrorCode.StartFailed
          : phase === 'stop'
            ? DotLifecycleErrorCode.StopFailed
            : DotLifecycleErrorCode.DisposeFailed;
    const diagnostic =
      error instanceof DotLifecycleError
        ? error
        : new DotLifecycleError({
            code,
            phase,
            plugin,
            message: `${phase} hook threw for plugin "${plugin}": ${stringifyError(error)}`,
            cause: error,
          });
    return diagnostic.code === DotLifecycleErrorCode.HookTimeout
      ? Deadline({ cause: diagnostic })
      : UnexpectedDefect({ cause: diagnostic });
  }

  #recordHookFailure(
    record: PluginRecord<TOpen, TClose, TPhases>,
    phase: DotLifecycleHook,
    failure: Failure,
    durationMs: number,
  ): void {
    const code = Deadline.is(failure)
      ? DotLifecycleErrorCode.HookTimeout
      : phase === 'configure'
        ? DotLifecycleErrorCode.ConfigureFailed
        : phase === 'boot'
          ? DotLifecycleErrorCode.BootFailed
          : phase === 'start'
            ? DotLifecycleErrorCode.StartFailed
            : phase === 'stop'
              ? DotLifecycleErrorCode.StopFailed
              : DotLifecycleErrorCode.DisposeFailed;
    const issue = makeIssue({
      code,
      plugin: record.plugin.name,
      message: `${phase} failed for plugin "${record.plugin.name}": ${failure.message}`,
      remediation: failure.remediation ?? 'Inspect the returned failure and the plugin hook.',
      docsAnchor: phase + '-failed',
      metadata: { phase, owner: record.plugin.name, failureCode: failure.code },
    });
    record.issues.push(issue);
    record.lifecycleDiagnostics.push({
      plugin: record.plugin.name,
      hook: phase,
      state: 'failed',
      order: record.order,
      durationMs,
      issues: [issue],
    });
    this.#emitHook(phase, record.plugin.name, record.order, 'failed', { durationMs, error: failure });
  }

  async #runHook<Phase extends 'start' | 'stop' | 'dispose'>(
    record: PluginRecord<TOpen, TClose, TPhases>,
    phase: Phase,
    logger: Logger,
  ): Promise<void | TPhases[Phase] | SupervisorFailure> {
    record.hooks.add(phase);
    const startedAt = nowMs();
    const hookAbort = new AbortController();
    this.#emitHook(phase, record.plugin.name, record.order, 'starting');
    let result: void | TPhases[Phase] | SupervisorFailure;
    try {
      const ctx = this.#buildHookCtx(record, phase, true, hookAbort.signal);
      result = await this.#withHookBudget(record.plugin.name, phase, hookAbort, async () =>
        withPluginHookSpan(
          { appName: this.#appName, pluginName: record.plugin.name, hook: phase, order: record.order },
          span => {
            logger = logger.withTrace(span.spanContext());
            return record.plugin.hooks[phase]?.(ctx as never);
          },
        ),
      );
      if (result !== undefined && !failed(result)) {
        throw new Error(`${phase} must return undefined or a Failure`, { cause: result });
      }
    } catch (error) {
      result = this.#hookDefect(phase, record.plugin.name, error);
    }
    const durationMs = nowMs() - startedAt;
    if (failed(result)) {
      this.#recordHookFailure(record, phase, result, durationMs);
      logger.error(phase + ': failed', { 'dot.plugin.failure.code': result.code });
    } else {
      record.lifecycleDiagnostics.push({
        plugin: record.plugin.name,
        hook: phase,
        state: phase === 'start' ? 'started' : phase === 'stop' ? 'stopped' : 'disposed',
        order: record.order,
        durationMs,
        issues: [],
      });
      this.#emitHook(phase, record.plugin.name, record.order, 'completed', { durationMs });
      logger.debug(phase + ': done', { 'dot.plugin.duration.ms': durationMs });
    }
    return result;
  }

  #reuseDefect(phase: DotLifecycleHook): ReturnType<typeof UnexpectedDefect> {
    return UnexpectedDefect({ cause: this.#reuseError(phase) });
  }

  #reuseError(phase: DotLifecycleHook): DotLifecycleError {
    const code =
      this.#state === 'disposed' ? DotLifecycleErrorCode.ReuseAfterDispose : DotLifecycleErrorCode.ReuseAfterFailure;
    const reason = this.#state === 'disposed' ? 'disposed' : 'failed';
    return new DotLifecycleError({
      code,
      phase,
      message: `Cannot ${phase}() — app "${this.#appName}" is ${reason}. Create a fresh app instance.`,
    });
  }

  #buildManifest(): DotAppManifest {
    const plugins: PluginManifest[] = [];
    const actions: ActionManifest[] = [];
    const services: ServiceManifest[] = [];
    const lifecycle: LifecycleManifest[] = [];
    const projections: ProjectionManifest[] = [];
    // Capability edges between features are derived at construction from
    // static `provides` (keyed); the rest are observed at boot time: consumer
    // plugin → the plugin whose published wire key satisfied its need. The
    // per-plugin `dependencies` array (wire-key strings) is the declarative view.
    const dependencies: DependencyEdge[] = this.#wiringEdges.map(e => ({ ...e }));

    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      const needWireKeys = Object.entries(plugin.needs).map(([alias, witness]) => wireKeyOf(witness, alias));
      plugins.push({
        name: plugin.name,
        ...(plugin.role === undefined ? {} : { role: plugin.role }),
        dependencies: needWireKeys,
        provides: [...record.provides],
      });
      actions.push(...record.actions);
      services.push(...record.services);
      projections.push(...record.projections);
      lifecycle.push({
        plugin: plugin.name,
        hooks: [...record.hooks],
      });
    }

    return {
      manifestVersion: 2,
      app: {
        name: this.#appName,
        version: this.#appVersion,
      },
      plugins,
      actions,
      services,
      lifecycle,
      dependencies,
      projections,
    };
  }

  #buildDiagnostics(): DotDiagnosticsSnapshot {
    const pluginDiagnostics: PluginDiagnostic[] = [];
    const actionDiagnostics: ActionDiagnostic[] = [];
    const serviceDiagnostics: ServiceDiagnostic[] = [];
    const lifecycleDiagnostics: LifecycleDiagnostic[] = [];
    const issues: DiagnosticIssue[] = [];

    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      // Per-plugin status: failed if any issue with severity error exists, ok otherwise.
      const hasError = record.issues.some(i => i.severity === 'error');
      const status: PluginDiagnostic['status'] = hasError ? 'failed' : 'ok';
      pluginDiagnostics.push({
        plugin: plugin.name,
        status,
        issues: [...record.issues],
      });

      for (const action of record.actions) {
        actionDiagnostics.push({
          id: action.id,
          plugin: plugin.name,
          binding: action.binding,
          ...(action.summary === undefined ? {} : { summary: action.summary }),
          status: hasError ? 'failed' : 'ok',
          issues: [],
        });
      }
      for (const svc of record.services) {
        serviceDiagnostics.push({
          service: svc.name,
          plugin: plugin.name,
          status: hasError
            ? 'failed'
            : record.booted || this.#state === 'defined' || this.#state === 'configured'
              ? 'ok'
              : 'ok',
          issues: [],
        });
      }
      lifecycleDiagnostics.push(...record.lifecycleDiagnostics);
      issues.push(...record.issues);
    }

    return {
      snapshotVersion: 2,
      generatedAt: new Date().toISOString(),
      app: {
        name: this.#appName,
        state: this.#state,
      },
      plugins: pluginDiagnostics,
      actions: actionDiagnostics,
      services: serviceDiagnostics,
      lifecycle: lifecycleDiagnostics,
      issues,
    };
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'then' in value &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

function reverseRecords<Open extends Failure, Close extends Failure, Phases extends PluginPhases>(
  records: readonly PluginRecord<Open, Close, Phases>[],
): readonly PluginRecord<Open, Close, Phases>[] {
  return [...records].reverse();
}

function hasToDotAction(
  source: AnyPlugin['actions'][number],
): source is { toDotAction(): Omit<ActionManifest, 'plugin'> } {
  return (
    typeof source === 'object' && source !== null && 'toDotAction' in source && typeof source.toDotAction === 'function'
  );
}

/** Re-export `ServiceKind` for the kernel's internal use. */

export { type ServiceKind } from '../manifest.js';
export { type Plugin } from '../plugin-contract.js';
