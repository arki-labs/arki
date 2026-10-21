/**
 * The plugin author's surface: `plugin`, handles, tokens, `rename` and the contract types.
 *
 * Exposes the plugin contract and the entry points a plugin author needs to
 * author + test plugins — `plugin`, `service`, `token`, `provide`, `rename`,
 * `defineApp`, `testApp` / `bootTestApp`, plus lifecycle / manifest /
 * diagnostics types.
 *
 * Adapter packages (e.g. `@arki/dot/env`, `@arki/kv/dot`, `@arki/db/dot`)
 * import from this subpath so their `*.d.ts` graphs stay tight.
 *
 * @example
 * ```ts
 * import { plugin, service, type Plugin } from '@arki/dot/plugin';
 * ```
 */

export {
  handleOf,
  isLazy,
  lazy,
  lazyOf,
  plugin,
  provide,
  rename,
  service,
  token,
  DotPluginError,
} from './plugin-contract.js';
export { LazyClosed } from './lazy.js';
export type {
  AnyHandle,
  AnyPlugin,
  AuthoredPlugin,
  FactoryContract,
  FactoryContractOf,
  PluginFactoryGuard,
  PluginSourceGuard,
  PluginPreparation,
  LoggingSlot,
  DotPluginRole,
  ActionDeclaration,
  ActionSource,
  CtxOf,
  DotConfigureContext,
  DotLoggingContext,
  DotLoggingHandle,
  EmptyShape,
  EmptyOwnership,
  PhaseHooks,
  Handle,
  Handles,
  KernelCtx,
  Lazy,
  LazyHandle,
  LazyService,
  NeedsShape,
  NoReservedKeys,
  Plugin,
  PluginNeeds,
  InferredOwnership,
  ProvidedValues,
  ProvidedValue,
  PluginOwnership,
  PluginOpenFailure,
  PluginCloseFailure,
  PluginPhases,
  EmptyPhases,
  PluginPhaseFailures,
  InferredPhases,
  MergePhases,
  PluginProvides,
  Provided,
  ProvidesFactories,
  ProjectionDeclaration,
  RenamedProvides,
  Service,
  ServiceRecord,
  Token,
  WireNeeds,
} from './plugin-contract.js';

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

export { initPlugins } from './init-plugins.js';
export type { InitPluginsFactory } from './init-plugins.js';

export { testApp, bootTestApp } from './test-harness.js';
export type { TestAppOptions } from './test-harness.js';

export type {
  DotLifecycleHook,
  DotLifecycleState,
  DotLifecyclePluginFailure,
  DotLifecycleErrorCodeValue,
} from './lifecycle.js';
export { DotLifecycleError, DotLifecycleErrorCode, DOT_LIFECYCLE_HOOKS } from './lifecycle.js';

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

export { telemetryFor } from './telemetry.js';
export type { DotTelemetry } from './telemetry.js';
