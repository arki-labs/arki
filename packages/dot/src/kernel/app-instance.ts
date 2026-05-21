/**
 * Internal DotApp implementation — the kernel's lifecycle scheduler.
 *
 * Not exported from the public surface. Tests reach it only through
 * `defineApp(...)` and its returned `DotApp` interface.
 */

import { createDebugLogger } from '@arki/logger/debug';

import type {
  DiagnosticIssue,
  DotDiagnosticsSnapshot,
  LifecycleDiagnostic,
  PluginDiagnostic,
  RouteDiagnostic,
  ServiceDiagnostic,
} from '../diagnostics.js';
import type { DotLifecycleHook, DotLifecyclePluginFailure, DotLifecycleState } from '../lifecycle.js';
import type {
  DependencyEdge,
  DependencyEdgeKind,
  DotAppManifest,
  LifecycleManifest,
  PluginManifest,
  RouteManifest,
  ServiceManifest,
} from '../manifest.js';
import type {
  AnyDotPlugin,
  DotBootContext,
  DotBootResult,
  DotConfigureContext,
  DotDisposeContext,
  DotStartContext,
  DotStopContext,
} from '../plugin-contract.js';
import { buildDependencyEdges, topologicalSort } from '../dependency-graph.js';
import { DotLifecycleError, DotLifecycleErrorCode } from '../lifecycle.js';
import { pluginProvides } from '../plugin-contract.js';

const debugKernel = createDebugLogger('arki:dot:kernel');
const debugLifecycle = createDebugLogger('arki:dot:lifecycle');

const DOCS_BASE = 'https://docs.arki.dev/dot/diagnostics';

/** Per-plugin mutable bookkeeping. */
type PluginRecord = {
  plugin: AnyDotPlugin;
  /** Topological order (0-based). */
  order: number;
  /** Routes registered during `configure`. */
  routes: RouteManifest[];
  /** Services declared during `configure`. */
  services: ServiceManifest[];
  /** Lifecycle hooks the plugin participates in. */
  hooks: Set<DotLifecycleHook>;
  /** Provides declared during `configure` (joined with plugin.provides). */
  provides: Set<string>;
  /** Extra dependency edges declared during `configure`. */
  extraDependencies: { to: string; kind: DependencyEdgeKind }[];
  /** Services published by this plugin (populated after `boot`). */
  publishedServices: Record<string, unknown>;
  /** Whether the plugin's `boot` hook completed successfully. */
  booted: boolean;
  /** Whether the plugin's `start` hook completed successfully. */
  started: boolean;
  /** Diagnostic issues collected for this plugin. */
  issues: DiagnosticIssue[];
  /** Per-hook diagnostic entries. */
  lifecycleDiagnostics: LifecycleDiagnostic[];
};

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
  plugins: readonly AnyDotPlugin[];
  /** Runtime config bag passed to every `boot` hook. */
  config?: Readonly<Record<string, unknown>>;
};

/**
 * Internal app implementation. Public consumers see the `DotApp` interface
 * from `../define-app.ts`.
 */
export class DotAppImpl {
  readonly #appName: string;
  readonly #appVersion: string | undefined;
  readonly #config: Readonly<Record<string, unknown>>;

  /** Plugins in topological order (set after the constructor sorts them). */
  readonly #ordered: readonly AnyDotPlugin[];
  readonly #records: Map<string, PluginRecord>;

  /** Macro-state of the app. */
  #state: DotLifecycleState = 'defined';

  /** Manifest finalised after `configure`. */
  #manifest: DotAppManifest;

  /** Cached services map — populated as plugins boot. */
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

  constructor(config: DotAppInternalConfig) {
    this.#appName = config.appName;
    this.#appVersion = config.appVersion;
    this.#config = Object.freeze({ ...config.config });

    // Topological sort happens up-front — surfaces cycle/dup/missing-dep errors
    // at construction (the `configure` phase pseudo-time).
    debugKernel('[%s] topologically sorting %d plugin(s)', this.#appName, config.plugins.length);
    this.#ordered = topologicalSort(config.plugins);

    this.#records = new Map();
    for (const [order, plugin] of this.#ordered.entries()) {
      this.#records.set(plugin.name, {
        plugin,
        order,
        routes: [],
        services: [],
        hooks: new Set<DotLifecycleHook>(),
        provides: new Set(pluginProvides(plugin)),
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

    debugLifecycle('[%s] configure: starting (%d plugin(s))', this.#appName, this.#ordered.length);
    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      if (!plugin.configure) {
        debugLifecycle('[%s] configure: %s (no hook)', this.#appName, plugin.name);
        continue;
      }
      record.hooks.add('configure');

      const ctx: DotConfigureContext = {
        pluginName: plugin.name,
        appName: this.#appName,
        registerService: (name, kind) => {
          record.services.push({ name, plugin: plugin.name, kind });
        },
        registerRoute: route => {
          record.routes.push({ ...route, plugin: plugin.name });
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
      let returned: unknown;
      try {
        returned = plugin.configure(ctx);
      } catch (error) {
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
          durationMs: performance.now() - started,
          issues: [issue],
        });
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
          durationMs: performance.now() - started,
          issues: [issue],
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

      record.lifecycleDiagnostics.push({
        plugin: plugin.name,
        hook: 'configure',
        state: 'configured',
        order: record.order,
        durationMs: performance.now() - started,
        issues: [],
      });
      debugLifecycle('[%s] configure: %s done', this.#appName, plugin.name);
    }

    // Also declare lifecycle-hook participation for non-configure hooks present
    // on the plugin object, so the manifest reflects them.
    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      if (plugin.boot) record.hooks.add('boot');
      if (plugin.start) record.hooks.add('start');
      if (plugin.stop) record.hooks.add('stop');
      if (plugin.dispose) record.hooks.add('dispose');
    }

    this.#configured = true;
    this.#state = 'configured';
    this.#manifest = this.#buildManifest();
    debugLifecycle('[%s] configure: complete', this.#appName);
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

    debugLifecycle('[%s] boot: starting', this.#appName);
    const bootedRecords: PluginRecord[] = [];

    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      if (!plugin.boot) {
        record.booted = true;
        bootedRecords.push(record);
        debugLifecycle('[%s] boot: %s (no hook)', this.#appName, plugin.name);
        continue;
      }
      record.hooks.add('boot');

      const ctx: DotBootContext = {
        pluginName: plugin.name,
        appName: this.#appName,
        services: this.#serviceMap,
        config: this.#config,
      };

      const started = performance.now();
      let result: DotBootResult<Record<string, unknown>>;
      try {
        const maybeResult = await plugin.boot(ctx);
        result = maybeResult ?? {};
      } catch (error) {
        const issue = makeIssue({
          code: DotLifecycleErrorCode.BootFailed,
          plugin: plugin.name,
          message: `boot hook threw for plugin "${plugin.name}": ${stringifyError(error)}`,
          remediation: `Fix the error in the boot() hook of "${plugin.name}". If boot opens partial resources before throwing, clean them up locally — DOT only disposes plugins whose boot completed.`,
          docsAnchor: 'boot-failed',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          plugin: plugin.name,
          hook: 'boot',
          state: 'failed',
          order: record.order,
          durationMs: performance.now() - started,
          issues: [issue],
        });

        debugLifecycle(
          '[%s] boot: %s FAILED — disposing %d already-booted plugin(s)',
          this.#appName,
          plugin.name,
          bootedRecords.length,
        );
        // Dispose already-booted plugins in reverse-topological order.
        const disposeFailures = await this.#runDisposeForRecords(reverseRecords(bootedRecords));
        this.#state = 'failed';
        this.#manifest = this.#buildManifest();
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.BootFailed,
          phase: 'boot',
          plugin: plugin.name,
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

      record.lifecycleDiagnostics.push({
        plugin: plugin.name,
        hook: 'boot',
        state: 'booted',
        order: record.order,
        durationMs: performance.now() - started,
        issues: [],
      });
      debugLifecycle('[%s] boot: %s done', this.#appName, plugin.name);
    }

    this.#state = 'booted';
    this.#manifest = this.#buildManifest();
    debugLifecycle('[%s] boot: complete', this.#appName);
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
    debugLifecycle('[%s] start: starting', this.#appName);
    const startedRecords: PluginRecord[] = [];
    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      if (!plugin.start) {
        debugLifecycle('[%s] start: %s (no hook)', this.#appName, plugin.name);
        continue;
      }
      record.hooks.add('start');

      const ctx: DotStartContext<Record<string, unknown>> = {
        pluginName: plugin.name,
        appName: this.#appName,
        services: this.#aggregatedServices,
      };

      const startedAt = performance.now();
      try {
        await plugin.start(ctx);
      } catch (error) {
        const issue = makeIssue({
          code: DotLifecycleErrorCode.StartFailed,
          plugin: plugin.name,
          message: `start hook threw for plugin "${plugin.name}": ${stringifyError(error)}`,
          remediation: `Fix the error in the start() hook of "${plugin.name}". DOT will stop all already-started plugins and dispose all booted plugins in reverse order.`,
          docsAnchor: 'start-failed',
        });
        record.issues.push(issue);
        record.lifecycleDiagnostics.push({
          plugin: plugin.name,
          hook: 'start',
          state: 'failed',
          order: record.order,
          durationMs: performance.now() - startedAt,
          issues: [issue],
        });

        debugLifecycle(
          '[%s] start: %s FAILED — stopping %d started + disposing all booted',
          this.#appName,
          plugin.name,
          startedRecords.length,
        );
        const stopFailures = await this.#runStopForRecords(reverseRecords(startedRecords));
        const bootedForDispose = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.booted);
        const disposeFailures = await this.#runDisposeForRecords(reverseRecords(bootedForDispose));
        this.#state = 'failed';
        this.#manifest = this.#buildManifest();
        const failures = [...stopFailures, ...disposeFailures];
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.StartFailed,
          phase: 'start',
          plugin: plugin.name,
          message: issue.message,
          cause: error,
          failures: failures.length > 0 ? failures : undefined,
        });
      }

      record.started = true;
      startedRecords.push(record);
      record.lifecycleDiagnostics.push({
        plugin: plugin.name,
        hook: 'start',
        state: 'started',
        order: record.order,
        durationMs: performance.now() - startedAt,
        issues: [],
      });
      debugLifecycle('[%s] start: %s done', this.#appName, plugin.name);
    }

    this.#state = 'started';
    this.#manifest = this.#buildManifest();
    debugLifecycle('[%s] start: complete', this.#appName);
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
    debugLifecycle('[%s] stop: starting', this.#appName);
    const startedRecords = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.started);
    const failures = await this.#runStopForRecords(reverseRecords(startedRecords));
    this.#state = 'stopped';
    this.#manifest = this.#buildManifest();
    if (failures.length > 0) {
      debugLifecycle('[%s] stop: complete with %d failure(s)', this.#appName, failures.length);
      throw new DotLifecycleError({
        code: DotLifecycleErrorCode.StopFailed,
        phase: 'stop',
        message: `${failures.length} plugin(s) failed during stop`,
        failures,
      });
    }
    debugLifecycle('[%s] stop: complete', this.#appName);
  }

  async #runStopForRecords(records: readonly PluginRecord[]): Promise<DotLifecyclePluginFailure[]> {
    const failures: DotLifecyclePluginFailure[] = [];
    for (const record of records) {
      if (!record.plugin.stop) continue;
      record.hooks.add('stop');
      const ctx: DotStopContext<Record<string, unknown>> = {
        pluginName: record.plugin.name,
        appName: this.#appName,
        services: this.#aggregatedServices,
      };
      const startedAt = performance.now();
      try {
        await record.plugin.stop(ctx);
        record.started = false;
        record.lifecycleDiagnostics.push({
          plugin: record.plugin.name,
          hook: 'stop',
          state: 'stopped',
          order: record.order,
          durationMs: performance.now() - startedAt,
          issues: [],
        });
      } catch (error) {
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
          durationMs: performance.now() - startedAt,
          issues: [issue],
        });
        failures.push({ plugin: record.plugin.name, phase: 'stop', error });
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
    // From started, stop first.
    if (this.#state === 'started') {
      // Inline stop without throwing — we want to dispose anyway, but capture failures.
      const startedRecords = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.started);
      const stopFailures = await this.#runStopForRecords(reverseRecords(startedRecords));
      this.#state = 'stopped';

      const bootedRecords = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.booted);
      const disposeFailures = await this.#runDisposeForRecords(reverseRecords(bootedRecords));
      this.#state = 'disposed';
      this.#manifest = this.#buildManifest();
      const failures = [...stopFailures, ...disposeFailures];
      if (failures.length > 0) {
        throw new DotLifecycleError({
          code: DotLifecycleErrorCode.DisposeFailed,
          phase: 'dispose',
          message: `${failures.length} plugin(s) failed during stop+dispose cascade`,
          failures,
        });
      }
      return;
    }

    // From booted/stopped/configured/defined: only dispose booted plugins.
    if (this.#state === 'failed') {
      // Already cleaned up at the failure site — mark disposed.
      this.#state = 'disposed';
      this.#manifest = this.#buildManifest();
      return;
    }

    const bootedRecords = this.#ordered.map(p => this.#records.get(p.name)!).filter(r => r.booted);
    const failures = await this.#runDisposeForRecords(reverseRecords(bootedRecords));
    this.#state = 'disposed';
    this.#manifest = this.#buildManifest();
    if (failures.length > 0) {
      throw new DotLifecycleError({
        code: DotLifecycleErrorCode.DisposeFailed,
        phase: 'dispose',
        message: `${failures.length} plugin(s) failed during dispose`,
        failures,
      });
    }
  }

  async #runDisposeForRecords(records: readonly PluginRecord[]): Promise<DotLifecyclePluginFailure[]> {
    const failures: DotLifecyclePluginFailure[] = [];
    for (const record of records) {
      if (!record.plugin.dispose) {
        record.booted = false;
        continue;
      }
      record.hooks.add('dispose');
      const ctx: DotDisposeContext<Record<string, unknown>> = {
        pluginName: record.plugin.name,
        appName: this.#appName,
        services: this.#aggregatedServices,
      };
      const startedAt = performance.now();
      try {
        await record.plugin.dispose(ctx);
        record.booted = false;
        record.lifecycleDiagnostics.push({
          plugin: record.plugin.name,
          hook: 'dispose',
          state: 'disposed',
          order: record.order,
          durationMs: performance.now() - startedAt,
          issues: [],
        });
      } catch (error) {
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
          durationMs: performance.now() - startedAt,
          issues: [issue],
        });
        failures.push({ plugin: record.plugin.name, phase: 'dispose', error });
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
    const plugins: PluginManifest[] = [];
    const routes: RouteManifest[] = [];
    const services: ServiceManifest[] = [];
    const lifecycle: LifecycleManifest[] = [];
    const dependencies: DependencyEdge[] = buildDependencyEdges(this.#ordered).map(e => ({ ...e }));

    for (const plugin of this.#ordered) {
      const record = this.#records.get(plugin.name)!;
      plugins.push({
        name: plugin.name,
        version: plugin.version,
        dependencies: plugin.dependencies ?? [],
        provides: [...record.provides],
      });
      routes.push(...record.routes);
      services.push(...record.services);
      lifecycle.push({
        plugin: plugin.name,
        hooks: [...record.hooks],
      });
      // Append extra dependency edges declared during configure.
      for (const dep of record.extraDependencies) {
        dependencies.push({ from: plugin.name, to: dep.to, kind: dep.kind });
      }

      // Optional manifest contribution from the plugin itself.
      const contribution =
        typeof plugin.manifest === 'function'
          ? plugin.manifest({
              pluginName: plugin.name,
              services: this.#aggregatedServices as Readonly<Partial<Record<string, unknown>>>,
            })
          : plugin.manifest;
      if (contribution) {
        for (const svc of contribution.services ?? []) {
          services.push({ name: svc.name, plugin: plugin.name, kind: svc.kind });
        }
        for (const route of contribution.routes ?? []) {
          routes.push({ ...route, plugin: plugin.name });
        }
        for (const cap of contribution.provides ?? []) {
          if (!plugins.at(-1)!.provides.includes(cap)) {
            (plugins.at(-1)!.provides as string[]).push(cap);
          }
        }
        for (const dep of contribution.dependencies ?? []) {
          dependencies.push({ from: plugin.name, to: dep.to, kind: dep.kind ?? 'uses' });
        }
      }
    }

    return {
      app: {
        name: this.#appName,
        version: this.#appVersion,
      },
      plugins,
      routes,
      services,
      lifecycle,
      dependencies,
    };
  }

  #buildDiagnostics(): DotDiagnosticsSnapshot {
    const pluginDiagnostics: PluginDiagnostic[] = [];
    const routeDiagnostics: RouteDiagnostic[] = [];
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

      for (const route of record.routes) {
        routeDiagnostics.push({
          id: route.id,
          plugin: plugin.name,
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
      generatedAt: new Date().toISOString(),
      app: {
        name: this.#appName,
        state: this.#state,
      },
      plugins: pluginDiagnostics,
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

function reverseRecords(records: readonly PluginRecord[]): readonly PluginRecord[] {
  // eslint-disable-next-line unicorn/no-array-reverse -- lib target is ES2022, toReversed is ES2023.
  return [...records].reverse();
}

/** Re-export `ServiceKind` and `RouteTransport` for the kernel's internal use. */

export { type ServiceKind, type RouteTransport } from '../manifest.js';
export { type DotPlugin } from '../plugin-contract.js';
