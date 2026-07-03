/**
 * @arki/dot — TypeScript-first application composition framework
 *
 * Public surface:
 *   - `defineApp(name)` — the entry point for composing applications.
 *   - `pip(config)` — author lifecycle-aware pips with typed needs/provides.
 *   - `service<T>()` / `token<T>()(key)` — service witnesses for DI wiring.
 *   - `rename(pip, map)` — mount-time multi-instance primitive.
 *   - Lifecycle / manifest / diagnostics types.
 *   - `testApp` / `bootTestApp` — test harnesses for pip authors.
 */

// #region Kernel — public surface
export { defineApp } from './define-app.js';
export type { DotApp, DotAppBuilder, DotAppConfigured, UseGuard } from './define-app.js';

export { isLazy, lazy, lazyOf, pip, provide, rename, service, token, DotPipError } from './pip-contract.js';
export type {
  AnyPip,
  CtxOf,
  DotConfigureContext,
  EmptyShape,
  KernelCtx,
  Lazy,
  LazyService,
  NeedsShape,
  Pip,
  PipNeeds,
  PipProvides,
  RenamedProvides,
  Service,
  ServiceRecord,
  Token,
  WireNeeds,
} from './pip-contract.js';

export {
  DotLifecycleError,
  DotLifecycleErrorCode,
  DOT_LIFECYCLE_HOOKS,
} from './lifecycle.js';
export type {
  DotLifecycleHook,
  DotLifecycleState,
  DotLifecyclePipFailure,
  DotLifecycleErrorCodeValue,
} from './lifecycle.js';

export type {
  DotAppManifest,
  PipManifest,
  RouteManifest,
  ServiceManifest,
  LifecycleManifest,
  DependencyEdge,
  DependencyEdgeKind,
  ServiceKind,
  RouteTransport,
} from './manifest.js';

export type {
  DotDiagnosticsSnapshot,
  PipDiagnostic,
  RouteDiagnostic,
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
  DotPipHookLifecycleEvent,
} from './lifecycle-observer.js';

export { renderTimeline } from './timeline.js';
export type { RenderTimelineOptions } from './timeline.js';

export { testApp, bootTestApp } from './test-harness.js';
export type { TestAppOptions } from './test-harness.js';

// Task 9b: CLI envelope type is exported so adapter packages can produce the
// same shape from related tooling (release-tooling, pip scaffolds, etc.).
export type { DotCliEnvelope, DotCliEnvelopeStatus } from './cli/render-explain.js';
// #endregion
