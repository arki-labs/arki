/**
 * Narrow public surface for pip authors.
 *
 * Exposes the pip contract and the entry points a pip author needs to
 * author + test pips — `pip`, `service`, `token`, `provide`, `rename`,
 * `defineApp`, `testApp` / `bootTestApp`, plus lifecycle / manifest /
 * diagnostics types.
 *
 * Adapter packages (e.g. `@arki/env/dot`, `@arki/kv/dot`, `@arki/db/dot`)
 * import from this subpath so their `*.d.ts` graphs stay tight.
 *
 * @example
 * ```ts
 * import { pip, service, type Pip } from '@arki/dot/pip';
 * ```
 */

export { isLazy, lazy, lazyOf, pip, provide, rename, service, token, DotPipError } from './pip-contract.js';
export type {
  AnyPip,
  CtxOf,
  DotConfigureContext,
  EmptyShape,
  InferredProvides,
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

export { defineApp } from './define-app.js';
export type { DotApp, DotAppBuilder, DotAppConfigured } from './define-app.js';

export { testApp, bootTestApp } from './test-harness.js';
export type { TestAppOptions } from './test-harness.js';

export type {
  DotLifecycleHook,
  DotLifecycleState,
  DotLifecyclePipFailure,
  DotLifecycleErrorCodeValue,
} from './lifecycle.js';
export { DotLifecycleError, DotLifecycleErrorCode, DOT_LIFECYCLE_HOOKS } from './lifecycle.js';

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
