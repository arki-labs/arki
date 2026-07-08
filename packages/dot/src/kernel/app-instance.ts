/**
 * Internal DotApp implementation — the kernel's lifecycle scheduler.
 *
 * Not exported from the public surface. Tests reach it only through
 * `defineApp(...)` and its returned `DotApp` interface.
 */

import { Logger } from '@arki/log';
import { createDebugLogger } from '@arki/log/debug';

import type {
  ActionDiagnostic,
  DiagnosticIssue,
  DotDiagnosticsSnapshot,
  LifecycleDiagnostic,
  PluginDiagnostic,
  ServiceDiagnostic,
} from '../diagnostics.js';
import type { DotLifecycleEvent, DotLifecycleObserver } from '../lifecycle-observer.js';
import type { DotLifecycleHook, DotLifecyclePluginFailure, DotLifecycleState } from '../lifecycle.js';
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
import type { AnyPlugin, DotConfigureContext, Lazy, ServiceRecord } from '../plugin-contract.js';
import { DotLifecycleError, DotLifecycleErrorCode } from '../lifecycle.js';
import { toJsonObject } from '../manifest.js';
import { isLazy, isLazyWitness, lazyOf } from '../plugin-contract.js';
import { withPhaseSpan, withPluginHookSpan } from './otel.js';

const debugKernel = createDebugLogger('arki:dot:kernel');

const DOCS_BASE = 'https://docs.arki.dev/dot/diagnostics';

/** Per-plugin mutable bookkeeping. */
type PluginRecord = {
  plugin: AnyPlugin;
  /** Declaration order (0-based) — v2 boot order IS declaration order. */
  order: number;
  /** Actions declared statically or registered during `configure`. */
  actions: ActionManifest[];
  /** Projection renderers registered during `configure`. */
  projections: ProjectionManifest[];
  /** Services declared during `configure`. */
  services: ServiceManifest[];
  /** Lifecycle hooks the plugin participates in. */
  hooks: Set<DotLifecycleHook>;
  /** Provides capability strings declared during `configure`, joined with published wire keys. */
  provides: Set<string>;
  /**
   * Services published by this plugin, keyed by LOCAL publish keys (pre-rename).
   * The plugin's own stop/dispose contexts read these; the app-facing service
   * map uses the renamed wire keys.
   */
  publishedServices: ServiceRecord;
  /** Whether the plugin's `boot` hook completed successfully. */
  booted: boolean;
  /** Whether the plugin's `start` hook completed successfully. */
  started: boolean;
  /** Diagnostic issues collected for this plugin. */
  issues: DiagnosticIssue[];
  /** Per-hook diagnostic entries. */
  lifecycleDiagnostics: LifecycleDiagnostic[];
};

/** Resolve a needs-shape witness to its wire key. */
function wireKeyOf(witness: object, alias: string): string {
  return 'key' in witness && typeof (witness as { key: unknown }).key === 'string'
    ? (witness as { key: string }).key
    : alias;
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

export type DotAppInternalConfig = {
  appName: string;
  appVersion?: string;
  plugins: readonly AnyPlugin[];
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
};

/**
 * Internal app implementation. Public consumers see the `DotApp` interface
 * from `../define-app.ts`.
 */
export class DotAppImpl {
  readonly #appName: string;
  readonly #appVersion: string | undefined;
  readonly #config: Readonly<Record<string, unknown>>;

  /** Plugins in declaration order — v2 boot order IS declaration order. */
  readonly #ordered: readonly AnyPlugin[];
  readonly #records: Map<string, PluginRecord>;

  /** Macro-state of the app. */
  #state: DotLifecycleState = 'defined';

  /** Per-hook watchdog budget (ms); `undefined` = no watchdog. */
  readonly #hookTimeoutMs: number | undefined;

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
  #bootInflight: Promise<void> | null = null;
  /** In-flight start promise — used for concurrent start() coalescing. */
  #startInflight: Promise<void> | null = null;
  /** In-flight stop promise — used for concurrent stop() coalescing. */
  #stopInflight: Promise<void> | null = null;
  /** In-flight dispose promise — used for concurrent dispose() coalescing. */
  #disposeInflight: Promise<void> | null = null;
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

  /**
   * In-process lifecycle observers. Fan-out is synchronous; observer
   * exceptions are caught and dropped (DEBUG-logged). Mutable through
   * `subscribe()` even after lifecycle starts — observers added later
   * see only events from their subscription onwards.
   */
  readonly #observers: Set<DotLifecycleObserver>;

  constructor(config: DotAppInternalConfig) {
    this.#appName = config.appName;
    this.#appVersion = config.appVersion;
    this.#hookTimeoutMs = config.hookTimeoutMs;
    this.#config = Object.freeze({ ...config.config });
    this.#logger = new Logger('arki:dot:lifecycle', { 'dot.app.name': config.appName });
    this.#observers = new Set(config.observers);

    // Declaration order is boot order in v2. Duplicate names are surfaced at
    // construction (the `configure` phase pseudo-time).
    debugKernel('[%s] registering %d plugin(s) in declaration order', this.#appName, config.plugins.length);
    this.#ordered = [...config.plugins];

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

    // Initial empty manifest — filled in by `runConfigure`.
    this.#manifest = this.#buildManifest();
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
        debugKernel('[%s] observer threw on %s/%s: %O', this.#appName, event.kind, event.status, error);
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

  #registerAction(record: PluginRecord, action: Omit<ActionManifest, 'plugin'>): void {
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

  #registerProjection(record: PluginRecord, projection: Omit<ProjectionManifest, 'plugin'>): void {
    record.projections.push({ ...projection, plugin: record.plugin.name });
  }

  #registerRouteShim(
    record: PluginRecord,
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
  #withPhaseEmit(phase: DotLifecycleHook, fn: () => void): void {
    const phaseStart = performance.now();
    this.#emitIfObserved(() => ({
      kind: 'phase',
      phase,
      status: 'starting',
      appName: this.#appName,
      timestamp: Date.now(),
    }));
    try {
      fn();
      this.#emitIfObserved(() => ({
        kind: 'phase',
        phase,
        status: 'completed',
        appName: this.#appName,
        durationMs: performance.now() - phaseStart,
        timestamp: Date.now(),
      }));
    } catch (error) {
      this.#emitIfObserved(() => ({
        kind: 'phase',
        phase,
        status: 'failed',
        appName: this.#appName,
        durationMs: performance.now() - phaseStart,
        error,
        timestamp: Date.now(),
      }));
      throw error;
    }
  }

  /** Async variant of {@link #withPhaseEmit}. */
  async #withPhaseEmitAsync(phase: DotLifecycleHook, fn: () => Promise<void>): Promise<void> {
    const phaseStart = performance.now();
    this.#emitIfObserved(() => ({
      kind: 'phase',
      phase,
      status: 'starting',
      appName: this.#appName,
      timestamp: Date.now(),
    }));
    try {
      await fn();
      this.#emitIfObserved(() => ({
        kind: 'phase',
        phase,
        status: 'completed',
        appName: this.#appName,
        durationMs: performance.now() - phaseStart,
        timestamp: Date.now(),
      }));
    } catch (error) {
      this.#emitIfObserved(() => ({
        kind: 'phase',
        phase,
        status: 'failed',
        appName: this.#appName,
        durationMs: performance.now() - phaseStart,
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
  runConfigure(): void {
    if (this.#configured) return;
    if (this.#state === 'failed' || this.#state === 'disposed') {
      throw this.#reuseError('configure');
    }

    const phaseLogger = this.#logger.withAttribute('dot.app.phase', 'configure');
    phaseLogger.debug('configure: starting', { 'dot.app.plugin.count': this.#ordered.length });

    this.#withPhaseEmit('configure', () => {
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'configure',
          pluginCount: this.#ordered.length,
          logger: phaseLogger,
        },
        () => this.#runConfigureInner(phaseLogger),
      );
    });
  }

  /**
   * Inner configure loop. Separated from `runConfigure` so the phase span
   * wrapper can stay thin and the loop body stays unindented — keeps the
   * intricate error-handling readable.
   */
  #runConfigureInner(phaseLogger: Logger): void {
    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      const pluginLogger = phaseLogger.withAttribute('dot.plugin.name', plugin.name);
      const declaredStarted = performance.now();
      try {
        for (const source of plugin.actions) this.#registerAction(record, this.#actionFromSource(source));
      } catch (error) {
        const durationMs = performance.now() - declaredStarted;
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
        registerRoute: route => this.#registerRouteShim(record, route),
        registerLifecycleHook: hook => {
          record.hooks.add(hook);
        },
        declareProvides: (...caps) => {
          for (const cap of caps) record.provides.add(cap);
        },
      };

      const started = performance.now();
      this.#emitHook('configure', plugin.name, record.order, 'starting');
      let returned: unknown;
      try {
        returned = withPluginHookSpan(
          {
            appName: this.#appName,
            pluginName: plugin.name,
            pluginVersion: plugin.version,
            hook: 'configure',
            order: record.order,
            logger: pluginLogger,
          },
          () => plugin.hooks.configure!(ctx),
        );
      } catch (error) {
        const durationMs = performance.now() - started;
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
        const durationMs = performance.now() - started;
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

      const durationMs = performance.now() - started;
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
      if (plugin.hooks.boot) record.hooks.add('boot');
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
  async boot(): Promise<void> {
    if (this.#bootInflight) return this.#bootInflight;
    this.#bootInflight = this.#enqueueTransition(() => this.#bootTransition()).finally(() => {
      this.#bootInflight = null;
    });
    return this.#bootInflight;
  }

  /** State checks + boot body. Runs at the head of the transition queue. */
  async #bootTransition(): Promise<void> {
    if (this.#state === 'failed' || this.#state === 'disposed') {
      throw this.#reuseError('boot');
    }
    if (this.#state === 'booted' || this.#state === 'started' || this.#state === 'stopped') {
      return;
    }
    return this.#runBoot();
  }

  async #runBoot(): Promise<void> {
    if (!this.#configured) {
      this.runConfigure();
    }

    const phaseLogger = this.#logger.withAttribute('dot.app.phase', 'boot');
    phaseLogger.debug('boot: starting', { 'dot.app.plugin.count': this.#ordered.length });

    return this.#withPhaseEmitAsync('boot', () =>
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'boot',
          pluginCount: this.#ordered.length,
          logger: phaseLogger,
        },
        () => this.#runBootInner(phaseLogger),
      ),
    );
  }

  /**
   * Resolve a plugin's needs into a hook context (alias-keyed), joined with
   * the `$`-prefixed kernel keys and — for post-boot hooks — the plugin's own
   * published services (local keys).
   *
   * @throws {DotLifecycleError} `DOT_LIFECYCLE_E012` when a need has no
   *   provider among earlier-booted plugins. Teardown hooks can never hit
   *   this: the service map only grows, and reverse-order teardown keeps
   *   providers alive until their consumers are done.
   */
  #buildHookCtx(record: PluginRecord, phase: DotLifecycleHook, includeOwnProvides: boolean): Record<string, unknown> {
    const ctx: Record<string, unknown> = {
      $app: this.#appName,
      $plugin: record.plugin.name,
      $config: this.#config,
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
   * Race one hook invocation against the app's `hookTimeoutMs` watchdog.
   * No budget configured → plain pass-through. On timeout the returned
   * promise rejects with `DOT_LIFECYCLE_E015` naming the plugin and hook,
   * and the call site's existing catch path applies the phase's normal
   * failure rules (boot rollback, start cascade, teardown aggregation).
   * The hook's own promise cannot be cancelled — the watchdog makes a
   * hang visible and bounded; it does not kill the hung work.
   */
  async #withHookBudget<T>(pluginName: string, hook: DotLifecycleHook, run: () => Promise<T> | T): Promise<T> {
    const budget = this.#hookTimeoutMs;
    if (budget === undefined) return run();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const watchdog = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new DotLifecycleError({
            code: DotLifecycleErrorCode.HookTimeout,
            phase: hook,
            plugin: pluginName,
            message:
              `${hook} hook of plugin "${pluginName}" exceeded the ${budget.toString()}ms hookTimeoutMs watchdog. ` +
              `The kernel treats the hook as failed and applies its normal rollback/aggregation rules, but ` +
              `cannot cancel the hook's promise — find the hang (a missing await? a connection that never ` +
              `settles?) or raise the budget in defineApp(name, { hookTimeoutMs }).`,
          }),
        );
      }, budget);
      // A pending watchdog must never keep an otherwise-finished process alive.
      timer.unref?.();
    });
    try {
      return await Promise.race([Promise.resolve(run()), watchdog]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Inner boot loop. Separated from `#runBoot` so the phase span wrapper
   * stays thin and the loop body — which orchestrates rollback on
   * partial failure — stays unindented.
   */
  async #runBootInner(phaseLogger: Logger): Promise<void> {
    const bootedRecords: PluginRecord[] = [];

    /** Shared failure path: mark diagnostics, roll back, throw. */
    const fail = async (args: {
      record: PluginRecord;
      code: (typeof DotLifecycleErrorCode)[keyof typeof DotLifecycleErrorCode];
      message: string;
      remediation: string;
      docsAnchor: string;
      durationMs: number;
      cause?: unknown;
      /** Records to dispose (reverse order applied here). */
      rollback: readonly PluginRecord[];
    }): Promise<never> => {
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
      this.#state = 'failed';
      this.#manifest = this.#buildManifest();
      throw new DotLifecycleError({
        code: args.code,
        phase: 'boot',
        plugin: args.record.plugin.name,
        message: args.message,
        cause: args.cause,
        failures: disposeFailures.length > 0 ? disposeFailures : undefined,
      });
    };

    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      const pluginLogger = phaseLogger.withAttribute('dot.plugin.name', plugin.name);
      const started = performance.now();

      // Resolve needs BEFORE invoking the hook — a plugin with needs but no
      // boot hook still fails fast when its wiring is unsatisfied.
      let ctx: Record<string, unknown>;
      try {
        ctx = this.#buildHookCtx(record, 'boot', false);
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
          durationMs: performance.now() - started,
          rollback: bootedRecords,
        });
      }

      if (!plugin.hooks.boot) {
        record.booted = true;
        bootedRecords.push(record);
        pluginLogger.debug('boot: skipped (no hook)');
        continue;
      }
      record.hooks.add('boot');

      this.#emitHook('boot', plugin.name, record.order, 'starting');
      let result: ServiceRecord | void;
      try {
        result = await this.#withHookBudget(plugin.name, 'boot', () =>
          withPluginHookSpan(
            {
              appName: this.#appName,
              pluginName: plugin.name,
              pluginVersion: plugin.version,
              hook: 'boot',
              order: record.order,
              logger: pluginLogger,
            },
            // Erasure boundary: hooks are stored as `(ctx: never) => ...`;
            // the kernel is the one caller allowed to cross it.
            () => plugin.hooks.boot!(ctx as never),
          ),
        );
      } catch (error) {
        const timedOut = error instanceof DotLifecycleError && error.code === DotLifecycleErrorCode.HookTimeout;
        return fail({
          record,
          code: timedOut ? DotLifecycleErrorCode.HookTimeout : DotLifecycleErrorCode.BootFailed,
          message: timedOut
            ? error.message
            : `boot hook threw for plugin "${plugin.name}": ${stringifyError(error)}`,
          remediation: timedOut
            ? `Find the hang in the boot() hook of "${plugin.name}" — a missing await or a connection that never settles — or raise defineApp's hookTimeoutMs.`
            : `Fix the error in the boot() hook of "${plugin.name}". If boot opens partial resources before throwing, clean them up locally — DOT only disposes plugins whose boot completed.`,
          docsAnchor: timedOut ? 'hook-timeout' : 'boot-failed',
          durationMs: performance.now() - started,
          cause: error,
          rollback: bootedRecords,
        });
      }

      const publishedServices: ServiceRecord = result ?? {};
      record.publishedServices = publishedServices;
      record.booted = true;

      for (const [localKey, value] of Object.entries(publishedServices)) {
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
            remediation: `Rename the "${wireKey}" key returned from the boot() hook of "${plugin.name}" — "$"-prefixed keys would shadow the kernel context.`,
            docsAnchor: 'reserved-service-key',
            durationMs: performance.now() - started,
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
            durationMs: performance.now() - started,
            rollback: [...bootedRecords, record],
          });
        }
        this.#serviceMap.set(wireKey, value);
        this.#providerByWireKey.set(wireKey, plugin.name);
        this.#aggregatedServices[wireKey] = value;
        record.provides.add(wireKey);
      }
      bootedRecords.push(record);

      const durationMs = performance.now() - started;
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
  async start(): Promise<void> {
    if (this.#startInflight) return this.#startInflight;
    this.#startInflight = this.#enqueueTransition(() => this.#startTransition()).finally(() => {
      this.#startInflight = null;
    });
    return this.#startInflight;
  }

  /** State checks + start body. Runs at the head of the transition queue. */
  async #startTransition(): Promise<void> {
    if (this.#state === 'failed' || this.#state === 'disposed') {
      throw this.#reuseError('start');
    }
    if (this.#state === 'started') return;
    if (this.#state === 'defined' || this.#state === 'configured') {
      // Direct #runBoot — we already hold the head of the transition
      // queue; going through public boot() would enqueue behind
      // ourselves and deadlock.
      await this.#runBoot();
    }
    // From booted or stopped, run start hooks.
    const phaseLogger = this.#logger.withAttribute('dot.app.phase', 'start');
    phaseLogger.debug('start: starting', { 'dot.app.plugin.count': this.#ordered.length });

    return this.#withPhaseEmitAsync('start', () =>
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'start',
          pluginCount: this.#ordered.length,
          logger: phaseLogger,
        },
        () => this.#runStartInner(phaseLogger),
      ),
    );
  }

  /**
   * Inner start loop. Separated from `start()` so the phase span wrapper
   * stays thin and the rollback-cascade error path stays readable.
   */
  async #runStartInner(phaseLogger: Logger): Promise<void> {
    const startedRecords: PluginRecord[] = [];
    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      const pluginLogger = phaseLogger.withAttribute('dot.plugin.name', plugin.name);
      if (!plugin.hooks.start) {
        pluginLogger.debug('start: skipped (no hook)');
        continue;
      }
      record.hooks.add('start');

      const ctx = this.#buildHookCtx(record, 'start', true);

      const startedAt = performance.now();
      this.#emitHook('start', plugin.name, record.order, 'starting');
      try {
        await this.#withHookBudget(plugin.name, 'start', () =>
          withPluginHookSpan(
            {
              appName: this.#appName,
              pluginName: plugin.name,
              pluginVersion: plugin.version,
              hook: 'start',
              order: record.order,
              logger: pluginLogger,
            },
            () => plugin.hooks.start!(ctx as never),
          ),
        );
      } catch (error) {
        const durationMs = performance.now() - startedAt;
        const timedOut = error instanceof DotLifecycleError && error.code === DotLifecycleErrorCode.HookTimeout;
        const issue = makeIssue({
          code: timedOut ? DotLifecycleErrorCode.HookTimeout : DotLifecycleErrorCode.StartFailed,
          plugin: plugin.name,
          message: timedOut
            ? error.message
            : `start hook threw for plugin "${plugin.name}": ${stringifyError(error)}`,
          remediation: timedOut
            ? `Find the hang in the start() hook of "${plugin.name}" — or raise defineApp's hookTimeoutMs. DOT rolls back as for any start failure.`
            : `Fix the error in the start() hook of "${plugin.name}". DOT will stop all already-started plugins and dispose all booted plugins in reverse order.`,
          docsAnchor: timedOut ? 'hook-timeout' : 'start-failed',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          plugin: plugin.name,
          hook: 'start',
          state: 'failed',
          order: record.order,
          durationMs,
          issues: [issue],
        });
        this.#emitHook('start', plugin.name, record.order, 'failed', { durationMs, error });

        pluginLogger.error('start: FAILED — rolling back', {
          'dot.app.rollback.started.count': startedRecords.length,
        });
        const stopFailures = await this.#runStopForRecords(reverseRecords(startedRecords), phaseLogger);
        const bootedForDispose = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.booted);
        const disposeFailures = await this.#runDisposeForRecords(reverseRecords(bootedForDispose), phaseLogger);
        this.#state = 'failed';
        this.#manifest = this.#buildManifest();
        const failures = [...stopFailures, ...disposeFailures];
        throw new DotLifecycleError({
          code: timedOut ? DotLifecycleErrorCode.HookTimeout : DotLifecycleErrorCode.StartFailed,
          phase: 'start',
          plugin: plugin.name,
          message: issue.message,
          cause: error,
          failures: failures.length > 0 ? failures : undefined,
        });
      }

      record.started = true;
      startedRecords.push(record);
      const durationMs = performance.now() - startedAt;
      record.lifecycleDiagnostics.push({
        plugin: plugin.name,
        hook: 'start',
        state: 'started',
        order: record.order,
        durationMs,
        issues: [],
      });
      this.#emitHook('start', plugin.name, record.order, 'completed', { durationMs });
      pluginLogger.debug('start: done', { 'dot.plugin.duration.ms': durationMs });
    }

    this.#state = 'started';
    this.#manifest = this.#buildManifest();
    phaseLogger.debug('start: complete', { 'dot.app.plugin.count': this.#ordered.length });
  }

  /** Public stop(). Idempotent + concurrent-safe. */
  async stop(): Promise<void> {
    if (this.#stopInflight) return this.#stopInflight;
    this.#stopInflight = this.#enqueueTransition(() => this.#stopTransition()).finally(() => {
      this.#stopInflight = null;
    });
    return this.#stopInflight;
  }

  /** State checks + stop body. Runs at the head of the transition queue. */
  async #stopTransition(): Promise<void> {
    // stop() after dispose is a no-op (idempotent across terminal states only
    // for `disposed`; `failed` was already cleaned up).
    if (this.#state === 'disposed') return;
    if (this.#state === 'failed') throw this.#reuseError('stop');
    // For non-started states (defined/configured/booted/stopped): no-op.
    if (this.#state !== 'started') {
      // Mark booted as "stopped" for state-machine clarity.
      if (this.#state === 'booted') this.#state = 'stopped';
      return;
    }
    return this.#runStop();
  }

  async #runStop(): Promise<void> {
    const phaseLogger = this.#logger.withAttribute('dot.app.phase', 'stop');
    phaseLogger.debug('stop: starting', { 'dot.app.plugin.count': this.#ordered.length });

    return this.#withPhaseEmitAsync('stop', () =>
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'stop',
          pluginCount: this.#ordered.length,
          logger: phaseLogger,
        },
        async () => {
          const startedRecords = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.started);
          const failures = await this.#runStopForRecords(reverseRecords(startedRecords), phaseLogger);
          this.#state = 'stopped';
          this.#manifest = this.#buildManifest();
          if (failures.length > 0) {
            phaseLogger.warn('stop: complete with failures', { 'dot.app.failure.count': failures.length });
            throw new DotLifecycleError({
              code: DotLifecycleErrorCode.StopFailed,
              phase: 'stop',
              message: `${failures.length} plugin(s) failed during stop`,
              failures,
            });
          }
          phaseLogger.debug('stop: complete', { 'dot.app.plugin.count': this.#ordered.length });
        },
      ),
    );
  }

  async #runStopForRecords(records: readonly PluginRecord[], phaseLogger: Logger): Promise<DotLifecyclePluginFailure[]> {
    const failures: DotLifecyclePluginFailure[] = [];
    for (const record of records) {
      if (!record.plugin.hooks.stop) continue;
      const pluginLogger = phaseLogger.withAttribute('dot.plugin.name', record.plugin.name);
      record.hooks.add('stop');
      const ctx = this.#buildHookCtx(record, 'stop', true);
      const startedAt = performance.now();
      this.#emitHook('stop', record.plugin.name, record.order, 'starting');
      try {
        await this.#withHookBudget(record.plugin.name, 'stop', () =>
          withPluginHookSpan(
            {
              appName: this.#appName,
              pluginName: record.plugin.name,
              pluginVersion: record.plugin.version,
              hook: 'stop',
              order: record.order,
              logger: pluginLogger,
            },
            () => record.plugin.hooks.stop!(ctx as never),
          ),
        );
        record.started = false;
        const durationMs = performance.now() - startedAt;
        record.lifecycleDiagnostics.push({
          plugin: record.plugin.name,
          hook: 'stop',
          state: 'stopped',
          order: record.order,
          durationMs,
          issues: [],
        });
        this.#emitHook('stop', record.plugin.name, record.order, 'completed', { durationMs });
        pluginLogger.debug('stop: done', { 'dot.plugin.duration.ms': durationMs });
      } catch (error) {
        const durationMs = performance.now() - startedAt;
        const issue = makeIssue({
          code: DotLifecycleErrorCode.StopFailed,
          plugin: record.plugin.name,
          message: `stop hook threw for plugin "${record.plugin.name}": ${stringifyError(error)}`,
          remediation: `Fix the error in the stop() hook of "${record.plugin.name}". Stop continues through individual failures and reports an aggregate error.`,
          docsAnchor: 'stop-failed',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          plugin: record.plugin.name,
          hook: 'stop',
          state: 'failed',
          order: record.order,
          durationMs,
          issues: [issue],
        });
        this.#emitHook('stop', record.plugin.name, record.order, 'failed', { durationMs, error });
        failures.push({ plugin: record.plugin.name, phase: 'stop', error });
        pluginLogger.error('stop: failed (continuing)', {
          'dot.plugin.error.message': stringifyError(error),
        });
      }
    }
    return failures;
  }

  /** Public dispose(). Idempotent + concurrent-safe. */
  async dispose(): Promise<void> {
    if (this.#disposeInflight) return this.#disposeInflight;
    this.#disposeInflight = this.#enqueueTransition(() => this.#disposeTransition()).finally(() => {
      this.#disposeInflight = null;
    });
    return this.#disposeInflight;
  }

  /** State check + dispose body. Runs at the head of the transition queue. */
  async #disposeTransition(): Promise<void> {
    if (this.#state === 'disposed') return;
    return this.#runDispose();
  }

  async #runDispose(): Promise<void> {
    const phaseLogger = this.#logger.withAttribute('dot.app.phase', 'dispose');
    phaseLogger.debug('dispose: starting', { 'dot.app.plugin.count': this.#ordered.length });

    return this.#withPhaseEmitAsync('dispose', () =>
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'dispose',
          pluginCount: this.#ordered.length,
          logger: phaseLogger,
        },
        () => this.#runDisposeInner(phaseLogger),
      ),
    );
  }

  /**
   * Inner dispose orchestration. Separated from `#runDispose` so the
   * phase span wrapper stays thin and the multi-state cascade (started
   * → stop+dispose, failed → no-op, default → dispose-only) stays
   * readable.
   */
  async #runDisposeInner(phaseLogger: Logger): Promise<void> {
    // From started, stop first.
    if (this.#state === 'started') {
      phaseLogger.debug('dispose: cascading from started — running stop first');
      // Inline stop without throwing — we want to dispose anyway, but capture failures.
      const startedRecords = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.started);
      const stopFailures = await this.#runStopForRecords(reverseRecords(startedRecords), phaseLogger);
      this.#state = 'stopped';

      const bootedRecords = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.booted);
      const disposeFailures = await this.#runDisposeForRecords(reverseRecords(bootedRecords), phaseLogger);
      this.#state = 'disposed';
      this.#manifest = this.#buildManifest();
      const failures = [...stopFailures, ...disposeFailures];
      if (failures.length > 0) {
        phaseLogger.warn('dispose: complete with failures', { 'dot.app.failure.count': failures.length });
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.DisposeFailed,
          phase: 'dispose',
          message: `${failures.length} plugin(s) failed during stop+dispose cascade`,
          failures,
        });
      }
      phaseLogger.debug('dispose: complete (cascaded from started)');
      return;
    }

    // From booted/stopped/configured/defined: only dispose booted plugins.
    if (this.#state === 'failed') {
      // Already cleaned up at the failure site — mark disposed.
      this.#state = 'disposed';
      this.#manifest = this.#buildManifest();
      phaseLogger.debug('dispose: complete (no-op; cleanup happened at failure site)');
      return;
    }

    const bootedRecords = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.booted);
    const failures = await this.#runDisposeForRecords(reverseRecords(bootedRecords), phaseLogger);
    this.#state = 'disposed';
    this.#manifest = this.#buildManifest();
    if (failures.length > 0) {
      phaseLogger.warn('dispose: complete with failures', { 'dot.app.failure.count': failures.length });
      throw new DotLifecycleError({
        code: DotLifecycleErrorCode.DisposeFailed,
        phase: 'dispose',
        message: `${failures.length} plugin(s) failed during dispose`,
        failures,
      });
    }
    phaseLogger.debug('dispose: complete', { 'dot.app.plugin.count': this.#ordered.length });
  }

  async #runDisposeForRecords(records: readonly PluginRecord[], phaseLogger: Logger): Promise<DotLifecyclePluginFailure[]> {
    const failures: DotLifecyclePluginFailure[] = [];

    // A lazy handle can be published under several keys — a `service.lazy`
    // consumer republishing its provider's handle passes it through by
    // identity. Auto-dispose belongs to the handle's FIRST publisher
    // (declaration order): dispose runs in reverse, so cleaning the handle
    // with a republisher would kill it before the original provider's own
    // dispose hook gets to use it. `records` arrives reversed, so plain
    // overwrite leaves the earliest-declared plugin as each handle's owner.
    const ownerOf = new Map<Lazy<unknown>, PluginRecord>();
    for (const record of records) {
      for (const value of Object.values(record.publishedServices)) {
        if (isLazy(value)) ownerOf.set(value, record);
      }
    }

    for (const record of records) {
      const seen = new Set<Lazy<unknown>>();
      const lazyPublishes = Object.entries(record.publishedServices).filter(
        (entry): entry is [string, Lazy<unknown>] => {
          const value = entry[1];
          if (!isLazy(value) || ownerOf.get(value) !== record || seen.has(value)) return false;
          seen.add(value);
          return true;
        },
      );
      const hasHook = record.plugin.hooks.dispose !== undefined;
      if (!hasHook && lazyPublishes.length === 0) {
        record.booted = false;
        continue;
      }
      const pluginLogger = phaseLogger.withAttribute('dot.plugin.name', record.plugin.name);
      if (hasHook) {
        await this.#runDisposeHook(record, pluginLogger, failures);
      }
      // Auto-dispose lazy service handles AFTER the plugin's own dispose hook
      // (the hook may still use them). Never-initialized handles no-op.
      for (const [serviceKey, handle] of lazyPublishes) {
        try {
          await handle.dispose();
        } catch (error) {
          const issue = makeIssue({
            code: DotLifecycleErrorCode.DisposeFailed,
            plugin: record.plugin.name,
            message: `lazy service "${serviceKey}" cleanup threw for plugin "${record.plugin.name}": ${stringifyError(error)}`,
            remediation: `Fix the error in the dispose callback passed to lazy(...) for service "${serviceKey}". Dispose continues through individual failures and reports an aggregate error.`,
            docsAnchor: 'dispose-failed',
          });
          record.issues.push(issue);
          failures.push({ plugin: record.plugin.name, phase: 'dispose', error });
          pluginLogger.error('dispose: lazy service cleanup failed (continuing)', {
            'dot.plugin.service.key': serviceKey,
            'dot.plugin.error.message': stringifyError(error),
          });
        }
      }
      if (!hasHook) {
        record.booted = false;
      }
    }
    return failures;
  }

  /** Run a single plugin's dispose hook with spans/events/diagnostics. */
  async #runDisposeHook(record: PluginRecord, pluginLogger: Logger, failures: DotLifecyclePluginFailure[]): Promise<void> {
      record.hooks.add('dispose');
      const ctx = this.#buildHookCtx(record, 'dispose', true);
      const startedAt = performance.now();
      this.#emitHook('dispose', record.plugin.name, record.order, 'starting');
      try {
        await this.#withHookBudget(record.plugin.name, 'dispose', () =>
          withPluginHookSpan(
            {
              appName: this.#appName,
              pluginName: record.plugin.name,
              pluginVersion: record.plugin.version,
              hook: 'dispose',
              order: record.order,
              logger: pluginLogger,
            },
            () => record.plugin.hooks.dispose!(ctx as never),
          ),
        );
        record.booted = false;
        const durationMs = performance.now() - startedAt;
        record.lifecycleDiagnostics.push({
          plugin: record.plugin.name,
          hook: 'dispose',
          state: 'disposed',
          order: record.order,
          durationMs,
          issues: [],
        });
        this.#emitHook('dispose', record.plugin.name, record.order, 'completed', { durationMs });
        pluginLogger.debug('dispose: done', { 'dot.plugin.duration.ms': durationMs });
      } catch (error) {
        const durationMs = performance.now() - startedAt;
        const issue = makeIssue({
          code: DotLifecycleErrorCode.DisposeFailed,
          plugin: record.plugin.name,
          message: `dispose hook threw for plugin "${record.plugin.name}": ${stringifyError(error)}`,
          remediation: `Fix the error in the dispose() hook of "${record.plugin.name}". Dispose continues through individual failures and reports an aggregate error.`,
          docsAnchor: 'dispose-failed',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          plugin: record.plugin.name,
          hook: 'dispose',
          state: 'failed',
          order: record.order,
          durationMs,
          issues: [issue],
        });
        this.#emitHook('dispose', record.plugin.name, record.order, 'failed', { durationMs, error });
        failures.push({ plugin: record.plugin.name, phase: 'dispose', error });
        pluginLogger.error('dispose: failed (continuing)', {
          'dot.plugin.error.message': stringifyError(error),
        });
      }
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
    // Edges are observed at boot time: consumer plugin → the plugin whose
    // published wire key satisfied its need. Before boot, the per-plugin
    // `dependencies` array (wire-key strings) is the declarative view.
    const dependencies: DependencyEdge[] = this.#wiringEdges.map(e => ({ ...e }));

    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      const needWireKeys = Object.entries(plugin.needs).map(([alias, witness]) => wireKeyOf(witness, alias));
      plugins.push({
        name: plugin.name,
        version: plugin.version,
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

function reverseRecords(records: readonly PluginRecord[]): readonly PluginRecord[] {
  // eslint-disable-next-line unicorn/no-array-reverse -- lib target is ES2022, toReversed is ES2023.
  return [...records].reverse();
}

function hasToDotAction(
  source: AnyPlugin['actions'][number],
): source is { toDotAction(): Omit<ActionManifest, 'plugin'> } {
  return (
    typeof source === 'object' &&
    source !== null &&
    'toDotAction' in source &&
    typeof source.toDotAction === 'function'
  );
}

/** Re-export `ServiceKind` for the kernel's internal use. */

export { type ServiceKind } from '../manifest.js';
export { type Plugin } from '../plugin-contract.js';
