/**
 * Internal DotApp implementation — the kernel's lifecycle scheduler.
 *
 * Not exported from the public surface. Tests reach it only through
 * `defineApp(...)` and its returned `DotApp` interface.
 */

import { Logger } from '@arki/log';
import { createDebugLogger } from '@arki/log/debug';

import type {
  DiagnosticIssue,
  DotDiagnosticsSnapshot,
  LifecycleDiagnostic,
  PipDiagnostic,
  RouteDiagnostic,
  ServiceDiagnostic,
} from '../diagnostics.js';
import type { DotLifecycleEvent, DotLifecycleObserver } from '../lifecycle-observer.js';
import type { DotLifecycleHook, DotLifecyclePipFailure, DotLifecycleState } from '../lifecycle.js';
import type {
  DependencyEdge,
  DependencyEdgeKind,
  DotAppManifest,
  LifecycleManifest,
  PipManifest,
  RouteManifest,
  ServiceManifest,
} from '../manifest.js';
import type {
  AnyDotPip,
  DotBootContext,
  DotBootResult,
  DotConfigureContext,
  DotDisposeContext,
  DotStartContext,
  DotStopContext,
} from '../pip-contract.js';
import { buildDependencyEdges, topologicalSort } from '../dependency-graph.js';
import { DotLifecycleError, DotLifecycleErrorCode } from '../lifecycle.js';
import { pipProvides } from '../pip-contract.js';
import { withPhaseSpan, withPipHookSpan } from './otel.js';

const debugKernel = createDebugLogger('arki:dot:kernel');

const DOCS_BASE = 'https://docs.arki.dev/dot/diagnostics';

/** Per-pip mutable bookkeeping. */
type PipRecord = {
  pip: AnyDotPip;
  /** Topological order (0-based). */
  order: number;
  /** Routes registered during `configure`. */
  routes: RouteManifest[];
  /** Services declared during `configure`. */
  services: ServiceManifest[];
  /** Lifecycle hooks the pip participates in. */
  hooks: Set<DotLifecycleHook>;
  /** Provides declared during `configure` (joined with pip.provides). */
  provides: Set<string>;
  /** Extra dependency edges declared during `configure`. */
  extraDependencies: { to: string; kind: DependencyEdgeKind }[];
  /** Services published by this pip (populated after `boot`). */
  publishedServices: Record<string, unknown>;
  /** Whether the pip's `boot` hook completed successfully. */
  booted: boolean;
  /** Whether the pip's `start` hook completed successfully. */
  started: boolean;
  /** Diagnostic issues collected for this pip. */
  issues: DiagnosticIssue[];
  /** Per-hook diagnostic entries. */
  lifecycleDiagnostics: LifecycleDiagnostic[];
};

/** Helper for stable issue construction. */
function makeIssue(args: {
  code: string;
  severity?: 'info' | 'warning' | 'error';
  pip?: string;
  message: string;
  remediation: string;
  docsAnchor: string;
  metadata?: Record<string, unknown>;
}): DiagnosticIssue {
  return {
    code: args.code,
    severity: args.severity ?? 'error',
    pip: args.pip,
    message: args.message,
    remediation: args.remediation,
    docsUrl: `${DOCS_BASE}#${args.docsAnchor}`,
    metadata: args.metadata,
  };
}

export type DotAppInternalConfig = {
  appName: string;
  appVersion?: string;
  pips: readonly AnyDotPip[];
  /** Runtime config bag passed to every `boot` hook. */
  config?: Readonly<Record<string, unknown>>;
  /**
   * Observers registered at construction time, before any phase fires.
   * Required if a consumer wants to see `configure`-phase events — those
   * happen before there's a public seam to call `subscribe()` on.
   */
  observers?: readonly DotLifecycleObserver[];
};

/**
 * Internal app implementation. Public consumers see the `DotApp` interface
 * from `../define-app.ts`.
 */
export class DotAppImpl {
  readonly #appName: string;
  readonly #appVersion: string | undefined;
  readonly #config: Readonly<Record<string, unknown>>;

  /** Pips in topological order (set after the constructor sorts them). */
  readonly #ordered: readonly AnyDotPip[];
  readonly #records: Map<string, PipRecord>;

  /** Macro-state of the app. */
  #state: DotLifecycleState = 'defined';

  /** Manifest finalised after `configure`. */
  #manifest: DotAppManifest;

  /** Cached services map — populated as pips boot. */
  readonly #serviceMap = new Map<string, unknown>();

  /** Cached merged services record for `start`/`stop`/`dispose` contexts. */
  #aggregatedServices: Record<string, unknown> = {};

  /** Configure has already happened (idempotent). */
  #configured = false;

  /** In-flight boot promise — used for concurrent boot() coalescing. */
  #bootInflight: Promise<void> | null = null;
  /** In-flight stop promise — used for concurrent stop() coalescing. */
  #stopInflight: Promise<void> | null = null;
  /** In-flight dispose promise — used for concurrent dispose() coalescing. */
  #disposeInflight: Promise<void> | null = null;

  /**
   * Structured lifecycle logger. One per app instance; named so consumers
   * can elevate it to DEBUG via `DEBUG=arki:dot:lifecycle` without
   * touching unrelated namespaces. Every line carries the app name plus
   * any phase/pip attributes from the call site. The span helpers
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
    this.#config = Object.freeze({ ...config.config });
    this.#logger = new Logger('arki:dot:lifecycle', { 'dot.app.name': config.appName });
    this.#observers = new Set(config.observers);

    // Topological sort happens up-front — surfaces cycle/dup/missing-dep errors
    // at construction (the `configure` phase pseudo-time).
    debugKernel('[%s] topologically sorting %d pip(s)', this.#appName, config.pips.length);
    this.#ordered = topologicalSort(config.pips);

    this.#records = new Map();
    for (const [order, pip] of this.#ordered.entries()) {
      this.#records.set(pip.name, {
        pip,
        order,
        routes: [],
        services: [],
        hooks: new Set<DotLifecycleHook>(),
        provides: new Set(pipProvides(pip)),
        extraDependencies: [],
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
    pip: string,
    order: number,
    status: 'starting' | 'completed' | 'failed',
    opts?: { durationMs?: number; error?: unknown },
  ): void {
    if (this.#observers.size === 0) return;
    const event = {
      kind: 'pip-hook' as const,
      phase,
      pip,
      order,
      status,
      appName: this.#appName,
      timestamp: Date.now(),
      ...(opts?.durationMs === undefined ? {} : { durationMs: opts.durationMs }),
      ...(opts?.error === undefined ? {} : { error: opts.error }),
    };
    this.#emit(event);
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
    phaseLogger.debug('configure: starting', { 'dot.app.pip.count': this.#ordered.length });

    this.#withPhaseEmit('configure', () => {
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'configure',
          pipCount: this.#ordered.length,
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
    for (const pip of this.#ordered) {
      const record = this.#records.get(pip.name)!;
      const pipLogger = phaseLogger.withAttribute('dot.pip.name', pip.name);
      if (!pip.configure) {
        pipLogger.debug('configure: skipped (no hook)');
        continue;
      }
      record.hooks.add('configure');

      const ctx: DotConfigureContext = {
        pipName: pip.name,
        appName: this.#appName,
        registerService: (name, kind) => {
          record.services.push({ name, pip: pip.name, kind });
        },
        registerRoute: route => {
          record.routes.push({ ...route, pip: pip.name });
        },
        registerLifecycleHook: hook => {
          record.hooks.add(hook);
        },
        declareProvides: (...caps) => {
          for (const cap of caps) record.provides.add(cap);
        },
        declareDependency: (to, kind) => {
          record.extraDependencies.push({ to, kind: kind ?? 'uses' });
        },
      };

      const started = performance.now();
      this.#emitHook('configure', pip.name, record.order, 'starting');
      let returned: unknown;
      try {
        returned = withPipHookSpan(
          {
            appName: this.#appName,
            pipName: pip.name,
            pipVersion: pip.version,
            hook: 'configure',
            order: record.order,
            logger: pipLogger,
          },
          () => pip.configure!(ctx),
        );
      } catch (error) {
        const durationMs = performance.now() - started;
        const issue = makeIssue({
          code: DotLifecycleErrorCode.ConfigureFailed,
          pip: pip.name,
          message: `configure hook threw for pip "${pip.name}": ${stringifyError(error)}`,
          remediation: `Fix the error in the configure() hook of "${pip.name}". configure() is for synchronous registration only — avoid throwing on declarative work.`,
          docsAnchor: 'configure-failed',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          pip: pip.name,
          hook: 'configure',
          state: 'failed',
          order: record.order,
          durationMs,
          issues: [issue],
        });
        this.#emitHook('configure', pip.name, record.order, 'failed', { durationMs, error });
        this.#state = 'failed';
        this.#manifest = this.#buildManifest();
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.ConfigureFailed,
          phase: 'configure',
          pip: pip.name,
          message: issue.message,
          cause: error,
        });
      }

      if (isThenable(returned)) {
        const durationMs = performance.now() - started;
        const issue = makeIssue({
          code: DotLifecycleErrorCode.ConfigureAsync,
          pip: pip.name,
          message: `configure hook of pip "${pip.name}" returned a Promise. configure must be synchronous.`,
          remediation: 'Move async work to the boot() hook. configure() is for synchronous registration only.',
          docsAnchor: 'configure-async',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          pip: pip.name,
          hook: 'configure',
          state: 'failed',
          order: record.order,
          durationMs,
          issues: [issue],
        });
        this.#emitHook('configure', pip.name, record.order, 'failed', {
          durationMs,
          error: new Error(issue.message),
        });
        this.#state = 'failed';
        this.#manifest = this.#buildManifest();
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.ConfigureAsync,
          phase: 'configure',
          pip: pip.name,
          message: issue.message,
        });
      }

      const durationMs = performance.now() - started;
      record.lifecycleDiagnostics.push({
        pip: pip.name,
        hook: 'configure',
        state: 'configured',
        order: record.order,
        durationMs,
        issues: [],
      });
      this.#emitHook('configure', pip.name, record.order, 'completed', { durationMs });
      pipLogger.debug('configure: done', { 'dot.pip.duration.ms': durationMs });
    }

    // Also declare lifecycle-hook participation for non-configure hooks present
    // on the pip object, so the manifest reflects them.
    for (const pip of this.#ordered) {
      const record = this.#records.get(pip.name)!;
      if (pip.boot) record.hooks.add('boot');
      if (pip.start) record.hooks.add('start');
      if (pip.stop) record.hooks.add('stop');
      if (pip.dispose) record.hooks.add('dispose');
    }

    this.#configured = true;
    this.#state = 'configured';
    this.#manifest = this.#buildManifest();
    phaseLogger.debug('configure: complete', { 'dot.app.pip.count': this.#ordered.length });
  }

  /** Public boot() — idempotent + concurrent-safe. */
  async boot(): Promise<void> {
    if (this.#state === 'failed' || this.#state === 'disposed') {
      throw this.#reuseError('boot');
    }
    if (this.#state === 'booted' || this.#state === 'started' || this.#state === 'stopped') {
      return;
    }
    if (this.#bootInflight) return this.#bootInflight;

    this.#bootInflight = this.#runBoot().finally(() => {
      this.#bootInflight = null;
    });
    return this.#bootInflight;
  }

  async #runBoot(): Promise<void> {
    if (!this.#configured) {
      this.runConfigure();
    }

    const phaseLogger = this.#logger.withAttribute('dot.app.phase', 'boot');
    phaseLogger.debug('boot: starting', { 'dot.app.pip.count': this.#ordered.length });

    return this.#withPhaseEmitAsync('boot', () =>
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'boot',
          pipCount: this.#ordered.length,
          logger: phaseLogger,
        },
        () => this.#runBootInner(phaseLogger),
      ),
    );
  }

  /**
   * Inner boot loop. Separated from `#runBoot` so the phase span wrapper
   * stays thin and the loop body — which orchestrates rollback on
   * partial failure — stays unindented.
   */
  async #runBootInner(phaseLogger: Logger): Promise<void> {
    const bootedRecords: PipRecord[] = [];

    for (const pip of this.#ordered) {
      const record = this.#records.get(pip.name)!;
      const pipLogger = phaseLogger.withAttribute('dot.pip.name', pip.name);
      if (!pip.boot) {
        record.booted = true;
        bootedRecords.push(record);
        pipLogger.debug('boot: skipped (no hook)');
        continue;
      }
      record.hooks.add('boot');

      const ctx: DotBootContext = {
        pipName: pip.name,
        appName: this.#appName,
        services: this.#serviceMap,
        config: this.#config,
      };

      const started = performance.now();
      this.#emitHook('boot', pip.name, record.order, 'starting');
      let result: DotBootResult<Record<string, unknown>>;
      try {
        const maybeResult = await withPipHookSpan(
          {
            appName: this.#appName,
            pipName: pip.name,
            pipVersion: pip.version,
            hook: 'boot',
            order: record.order,
            logger: pipLogger,
          },
          () => pip.boot!(ctx),
        );
        result = maybeResult ?? {};
      } catch (error) {
        const durationMs = performance.now() - started;
        const issue = makeIssue({
          code: DotLifecycleErrorCode.BootFailed,
          pip: pip.name,
          message: `boot hook threw for pip "${pip.name}": ${stringifyError(error)}`,
          remediation: `Fix the error in the boot() hook of "${pip.name}". If boot opens partial resources before throwing, clean them up locally — DOT only disposes pips whose boot completed.`,
          docsAnchor: 'boot-failed',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          pip: pip.name,
          hook: 'boot',
          state: 'failed',
          order: record.order,
          durationMs,
          issues: [issue],
        });
        this.#emitHook('boot', pip.name, record.order, 'failed', { durationMs, error });

        pipLogger.error('boot: FAILED — rolling back already-booted pips', {
          'dot.app.rollback.count': bootedRecords.length,
        });
        // Dispose already-booted pips in reverse-topological order.
        const disposeFailures = await this.#runDisposeForRecords(reverseRecords(bootedRecords), phaseLogger);
        this.#state = 'failed';
        this.#manifest = this.#buildManifest();
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.BootFailed,
          phase: 'boot',
          pip: pip.name,
          message: issue.message,
          cause: error,
          failures: disposeFailures.length > 0 ? disposeFailures : undefined,
        });
      }

      const publishedServices = result.services ?? {};
      record.publishedServices = publishedServices;
      for (const [name, value] of Object.entries(publishedServices)) {
        this.#serviceMap.set(name, value);
      }
      Object.assign(this.#aggregatedServices, publishedServices);
      record.booted = true;
      bootedRecords.push(record);

      const durationMs = performance.now() - started;
      record.lifecycleDiagnostics.push({
        pip: pip.name,
        hook: 'boot',
        state: 'booted',
        order: record.order,
        durationMs,
        issues: [],
      });
      this.#emitHook('boot', pip.name, record.order, 'completed', { durationMs });
      pipLogger.debug('boot: done', {
        'dot.pip.duration.ms': durationMs,
        'dot.pip.services.published': Object.keys(publishedServices).length,
      });
    }

    this.#state = 'booted';
    this.#manifest = this.#buildManifest();
    phaseLogger.debug('boot: complete', { 'dot.app.pip.count': this.#ordered.length });
  }

  /** Public start(). Boots first if needed. Idempotent. */
  async start(): Promise<void> {
    if (this.#state === 'failed' || this.#state === 'disposed') {
      throw this.#reuseError('start');
    }
    if (this.#state === 'started') return;
    if (this.#state === 'defined' || this.#state === 'configured') {
      await this.boot();
    }
    // From booted or stopped, run start hooks.
    const phaseLogger = this.#logger.withAttribute('dot.app.phase', 'start');
    phaseLogger.debug('start: starting', { 'dot.app.pip.count': this.#ordered.length });

    return this.#withPhaseEmitAsync('start', () =>
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'start',
          pipCount: this.#ordered.length,
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
    const startedRecords: PipRecord[] = [];
    for (const pip of this.#ordered) {
      const record = this.#records.get(pip.name)!;
      const pipLogger = phaseLogger.withAttribute('dot.pip.name', pip.name);
      if (!pip.start) {
        pipLogger.debug('start: skipped (no hook)');
        continue;
      }
      record.hooks.add('start');

      const ctx: DotStartContext<Record<string, unknown>> = {
        pipName: pip.name,
        appName: this.#appName,
        services: this.#aggregatedServices,
      };

      const startedAt = performance.now();
      this.#emitHook('start', pip.name, record.order, 'starting');
      try {
        await withPipHookSpan(
          {
            appName: this.#appName,
            pipName: pip.name,
            pipVersion: pip.version,
            hook: 'start',
            order: record.order,
            logger: pipLogger,
          },
          () => pip.start!(ctx),
        );
      } catch (error) {
        const durationMs = performance.now() - startedAt;
        const issue = makeIssue({
          code: DotLifecycleErrorCode.StartFailed,
          pip: pip.name,
          message: `start hook threw for pip "${pip.name}": ${stringifyError(error)}`,
          remediation: `Fix the error in the start() hook of "${pip.name}". DOT will stop all already-started pips and dispose all booted pips in reverse order.`,
          docsAnchor: 'start-failed',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          pip: pip.name,
          hook: 'start',
          state: 'failed',
          order: record.order,
          durationMs,
          issues: [issue],
        });
        this.#emitHook('start', pip.name, record.order, 'failed', { durationMs, error });

        pipLogger.error('start: FAILED — rolling back', {
          'dot.app.rollback.started.count': startedRecords.length,
        });
        const stopFailures = await this.#runStopForRecords(reverseRecords(startedRecords), phaseLogger);
        const bootedForDispose = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.booted);
        const disposeFailures = await this.#runDisposeForRecords(reverseRecords(bootedForDispose), phaseLogger);
        this.#state = 'failed';
        this.#manifest = this.#buildManifest();
        const failures = [...stopFailures, ...disposeFailures];
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.StartFailed,
          phase: 'start',
          pip: pip.name,
          message: issue.message,
          cause: error,
          failures: failures.length > 0 ? failures : undefined,
        });
      }

      record.started = true;
      startedRecords.push(record);
      const durationMs = performance.now() - startedAt;
      record.lifecycleDiagnostics.push({
        pip: pip.name,
        hook: 'start',
        state: 'started',
        order: record.order,
        durationMs,
        issues: [],
      });
      this.#emitHook('start', pip.name, record.order, 'completed', { durationMs });
      pipLogger.debug('start: done', { 'dot.pip.duration.ms': durationMs });
    }

    this.#state = 'started';
    this.#manifest = this.#buildManifest();
    phaseLogger.debug('start: complete', { 'dot.app.pip.count': this.#ordered.length });
  }

  /** Public stop(). Idempotent + concurrent-safe. */
  async stop(): Promise<void> {
    if (this.#state === 'failed' || this.#state === 'disposed') {
      // stop() after dispose is a no-op (idempotent across terminal states only
      // for `disposed`; `failed` was already cleaned up).
      if (this.#state === 'disposed') return;
      throw this.#reuseError('stop');
    }
    if (this.#stopInflight) return this.#stopInflight;
    // For non-started states (defined/configured/booted/stopped): no-op.
    if (this.#state !== 'started') {
      // Mark booted as "stopped" for state-machine clarity.
      if (this.#state === 'booted') this.#state = 'stopped';
      return;
    }

    this.#stopInflight = this.#runStop().finally(() => {
      this.#stopInflight = null;
    });
    return this.#stopInflight;
  }

  async #runStop(): Promise<void> {
    const phaseLogger = this.#logger.withAttribute('dot.app.phase', 'stop');
    phaseLogger.debug('stop: starting', { 'dot.app.pip.count': this.#ordered.length });

    return this.#withPhaseEmitAsync('stop', () =>
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'stop',
          pipCount: this.#ordered.length,
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
              message: `${failures.length} pip(s) failed during stop`,
              failures,
            });
          }
          phaseLogger.debug('stop: complete', { 'dot.app.pip.count': this.#ordered.length });
        },
      ),
    );
  }

  async #runStopForRecords(records: readonly PipRecord[], phaseLogger: Logger): Promise<DotLifecyclePipFailure[]> {
    const failures: DotLifecyclePipFailure[] = [];
    for (const record of records) {
      if (!record.pip.stop) continue;
      const pipLogger = phaseLogger.withAttribute('dot.pip.name', record.pip.name);
      record.hooks.add('stop');
      const ctx: DotStopContext<Record<string, unknown>> = {
        pipName: record.pip.name,
        appName: this.#appName,
        services: this.#aggregatedServices,
      };
      const startedAt = performance.now();
      this.#emitHook('stop', record.pip.name, record.order, 'starting');
      try {
        await withPipHookSpan(
          {
            appName: this.#appName,
            pipName: record.pip.name,
            pipVersion: record.pip.version,
            hook: 'stop',
            order: record.order,
            logger: pipLogger,
          },
          () => record.pip.stop!(ctx),
        );
        record.started = false;
        const durationMs = performance.now() - startedAt;
        record.lifecycleDiagnostics.push({
          pip: record.pip.name,
          hook: 'stop',
          state: 'stopped',
          order: record.order,
          durationMs,
          issues: [],
        });
        this.#emitHook('stop', record.pip.name, record.order, 'completed', { durationMs });
        pipLogger.debug('stop: done', { 'dot.pip.duration.ms': durationMs });
      } catch (error) {
        const durationMs = performance.now() - startedAt;
        const issue = makeIssue({
          code: DotLifecycleErrorCode.StopFailed,
          pip: record.pip.name,
          message: `stop hook threw for pip "${record.pip.name}": ${stringifyError(error)}`,
          remediation: `Fix the error in the stop() hook of "${record.pip.name}". Stop continues through individual failures and reports an aggregate error.`,
          docsAnchor: 'stop-failed',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          pip: record.pip.name,
          hook: 'stop',
          state: 'failed',
          order: record.order,
          durationMs,
          issues: [issue],
        });
        this.#emitHook('stop', record.pip.name, record.order, 'failed', { durationMs, error });
        failures.push({ pip: record.pip.name, phase: 'stop', error });
        pipLogger.error('stop: failed (continuing)', {
          'dot.pip.error.message': stringifyError(error),
        });
      }
    }
    return failures;
  }

  /** Public dispose(). Idempotent + concurrent-safe. */
  async dispose(): Promise<void> {
    if (this.#state === 'disposed') return;
    if (this.#disposeInflight) return this.#disposeInflight;

    this.#disposeInflight = this.#runDispose().finally(() => {
      this.#disposeInflight = null;
    });
    return this.#disposeInflight;
  }

  async #runDispose(): Promise<void> {
    const phaseLogger = this.#logger.withAttribute('dot.app.phase', 'dispose');
    phaseLogger.debug('dispose: starting', { 'dot.app.pip.count': this.#ordered.length });

    return this.#withPhaseEmitAsync('dispose', () =>
      withPhaseSpan(
        {
          appName: this.#appName,
          phase: 'dispose',
          pipCount: this.#ordered.length,
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
          message: `${failures.length} pip(s) failed during stop+dispose cascade`,
          failures,
        });
      }
      phaseLogger.debug('dispose: complete (cascaded from started)');
      return;
    }

    // From booted/stopped/configured/defined: only dispose booted pips.
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
        message: `${failures.length} pip(s) failed during dispose`,
        failures,
      });
    }
    phaseLogger.debug('dispose: complete', { 'dot.app.pip.count': this.#ordered.length });
  }

  async #runDisposeForRecords(records: readonly PipRecord[], phaseLogger: Logger): Promise<DotLifecyclePipFailure[]> {
    const failures: DotLifecyclePipFailure[] = [];
    for (const record of records) {
      if (!record.pip.dispose) {
        record.booted = false;
        continue;
      }
      const pipLogger = phaseLogger.withAttribute('dot.pip.name', record.pip.name);
      record.hooks.add('dispose');
      const ctx: DotDisposeContext<Record<string, unknown>> = {
        pipName: record.pip.name,
        appName: this.#appName,
        services: this.#aggregatedServices,
      };
      const startedAt = performance.now();
      this.#emitHook('dispose', record.pip.name, record.order, 'starting');
      try {
        await withPipHookSpan(
          {
            appName: this.#appName,
            pipName: record.pip.name,
            pipVersion: record.pip.version,
            hook: 'dispose',
            order: record.order,
            logger: pipLogger,
          },
          () => record.pip.dispose!(ctx),
        );
        record.booted = false;
        const durationMs = performance.now() - startedAt;
        record.lifecycleDiagnostics.push({
          pip: record.pip.name,
          hook: 'dispose',
          state: 'disposed',
          order: record.order,
          durationMs,
          issues: [],
        });
        this.#emitHook('dispose', record.pip.name, record.order, 'completed', { durationMs });
        pipLogger.debug('dispose: done', { 'dot.pip.duration.ms': durationMs });
      } catch (error) {
        const durationMs = performance.now() - startedAt;
        const issue = makeIssue({
          code: DotLifecycleErrorCode.DisposeFailed,
          pip: record.pip.name,
          message: `dispose hook threw for pip "${record.pip.name}": ${stringifyError(error)}`,
          remediation: `Fix the error in the dispose() hook of "${record.pip.name}". Dispose continues through individual failures and reports an aggregate error.`,
          docsAnchor: 'dispose-failed',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          pip: record.pip.name,
          hook: 'dispose',
          state: 'failed',
          order: record.order,
          durationMs,
          issues: [issue],
        });
        this.#emitHook('dispose', record.pip.name, record.order, 'failed', { durationMs, error });
        failures.push({ pip: record.pip.name, phase: 'dispose', error });
        pipLogger.error('dispose: failed (continuing)', {
          'dot.pip.error.message': stringifyError(error),
        });
      }
    }
    return failures;
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
    const pips: PipManifest[] = [];
    const routes: RouteManifest[] = [];
    const services: ServiceManifest[] = [];
    const lifecycle: LifecycleManifest[] = [];
    const dependencies: DependencyEdge[] = buildDependencyEdges(this.#ordered).map(e => ({ ...e }));

    for (const pip of this.#ordered) {
      const record = this.#records.get(pip.name)!;
      pips.push({
        name: pip.name,
        version: pip.version,
        dependencies: pip.dependencies ?? [],
        provides: [...record.provides],
      });
      routes.push(...record.routes);
      services.push(...record.services);
      lifecycle.push({
        pip: pip.name,
        hooks: [...record.hooks],
      });
      // Append extra dependency edges declared during configure.
      for (const dep of record.extraDependencies) {
        dependencies.push({ from: pip.name, to: dep.to, kind: dep.kind });
      }

      // Optional manifest contribution from the pip itself.
      const contribution =
        typeof pip.manifest === 'function'
          ? pip.manifest({
              pipName: pip.name,
              services: this.#aggregatedServices as Readonly<Partial<Record<string, unknown>>>,
            })
          : pip.manifest;
      if (contribution) {
        for (const svc of contribution.services ?? []) {
          services.push({ name: svc.name, pip: pip.name, kind: svc.kind });
        }
        for (const route of contribution.routes ?? []) {
          routes.push({ ...route, pip: pip.name });
        }
        for (const cap of contribution.provides ?? []) {
          if (!pips.at(-1)!.provides.includes(cap)) {
            (pips.at(-1)!.provides as string[]).push(cap);
          }
        }
        for (const dep of contribution.dependencies ?? []) {
          dependencies.push({ from: pip.name, to: dep.to, kind: dep.kind ?? 'uses' });
        }
      }
    }

    return {
      app: {
        name: this.#appName,
        version: this.#appVersion,
      },
      pips,
      routes,
      services,
      lifecycle,
      dependencies,
    };
  }

  #buildDiagnostics(): DotDiagnosticsSnapshot {
    const pipDiagnostics: PipDiagnostic[] = [];
    const routeDiagnostics: RouteDiagnostic[] = [];
    const serviceDiagnostics: ServiceDiagnostic[] = [];
    const lifecycleDiagnostics: LifecycleDiagnostic[] = [];
    const issues: DiagnosticIssue[] = [];

    for (const pip of this.#ordered) {
      const record = this.#records.get(pip.name)!;
      // Per-pip status: failed if any issue with severity error exists, ok otherwise.
      const hasError = record.issues.some(i => i.severity === 'error');
      const status: PipDiagnostic['status'] = hasError ? 'failed' : 'ok';
      pipDiagnostics.push({
        pip: pip.name,
        status,
        issues: [...record.issues],
      });

      for (const route of record.routes) {
        routeDiagnostics.push({
          id: route.id,
          pip: pip.name,
          status: hasError ? 'failed' : 'ok',
          issues: [],
        });
      }
      for (const svc of record.services) {
        serviceDiagnostics.push({
          service: svc.name,
          pip: pip.name,
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
      generatedAt: new Date().toISOString(),
      app: {
        name: this.#appName,
        state: this.#state,
      },
      pips: pipDiagnostics,
      routes: routeDiagnostics,
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

function reverseRecords(records: readonly PipRecord[]): readonly PipRecord[] {
  // eslint-disable-next-line unicorn/no-array-reverse -- lib target is ES2022, toReversed is ES2023.
  return [...records].reverse();
}

/** Re-export `ServiceKind` and `RouteTransport` for the kernel's internal use. */

export { type RouteTransport, type ServiceKind } from '../manifest.js';
export { type DotPip } from '../pip-contract.js';
