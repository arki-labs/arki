/**
 * @arki/dot — TypeScript-first application composition framework
 *
 * Public surface:
 *   - `defineApp(name)` — the entry point for composing applications.
 *   - `plugin(config)` — author lifecycle-aware plugins with typed needs/provides.
 *   - `service<T>()` / `token<T>()(key)` — service witnesses for DI wiring.
 *   - `rename(plugin, map)` — mount-time multi-instance primitive.
 *   - Lifecycle / manifest / diagnostics types.
 *   - `testApp` / `bootTestApp` — test harnesses for plugin authors.
 */

// #region Kernel — public surface
export { defineApp } from './define-app.js';
export type {
  DotApp,
  DotAppBuilder,
  DotAppConfigured,
  NormalizeProvides,
  UseAllAvail,
  UseAllGuard,
  UseGuard,
} from './define-app.js';

export { isLazy, lazy, lazyOf, plugin, provide, rename, service, token, DotPluginError } from './plugin-contract.js';
export type {
  AnyPlugin,
  ActionSource,
  CtxOf,
  DotConfigureContext,
  EmptyShape,
  InferredProvides,
  KernelCtx,
  Lazy,
  LazyService,
  NeedsShape,
  NoReservedKeys,
  Plugin,
  PluginNeeds,
  PluginProvides,
  RenamedProvides,
  Service,
  ServiceRecord,
  Token,
  WireNeeds,
} from './plugin-contract.js';

export { initPlugins } from './init-plugins.js';
export type { InitPluginsFactory } from './init-plugins.js';

export {
  DotLifecycleError,
  DotLifecycleErrorCode,
  DOT_LIFECYCLE_HOOKS,
} from './lifecycle.js';
export type {
  DotLifecycleHook,
  DotLifecycleState,
  DotLifecyclePluginFailure,
  DotLifecycleErrorCodeValue,
} from './lifecycle.js';

export type {
  DotAppManifest,
  ActionDirection,
  ActionManifest,
  JsonObject,
  JsonValue,
  PluginManifest,
  ProjectionManifest,
  ServiceManifest,
  LifecycleManifest,
  DependencyEdge,
  DependencyEdgeKind,
  ServiceKind,
} from './manifest.js';
export { toJsonObject } from './manifest.js';

export type {
  DotDiagnosticsSnapshot,
  PluginDiagnostic,
  ActionDiagnostic,
  ServiceDiagnostic,
  LifecycleDiagnostic,
  DiagnosticIssue,
  DiagnosticSeverity,
  DiagnosticStatus,
} from './diagnostics.js';

export type {
  DotLifecycleEvent,
  DotLifecycleEventStatus,
  DotLifecycleObserver,
  DotPhaseLifecycleEvent,
  DotPluginHookLifecycleEvent,
} from './lifecycle-observer.js';

export { renderTimeline } from './timeline.js';
export type { RenderTimelineOptions } from './timeline.js';

export { testApp, bootTestApp, testPlugin } from './test-harness.js';
export type { TestAppOptions, TestPluginBuilder } from './test-harness.js';

export { hookSignals } from './signals.js';
export type { HookSignalsOptions, SignalTarget } from './signals.js';

// Task 9b: CLI envelope type is exported so adapter packages can produce the
// same shape from related tooling (release-tooling, plugin scaffolds, etc.).
export type { DotCliEnvelope, DotCliEnvelopeStatus } from './cli/render-explain.js';
// #endregion
