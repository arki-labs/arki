/**
 * Narrow public surface for pip authors.
 *
 * Exposes the new-kernel pip contract and the entry points a pip
 * author needs to author + test pips — `defineDotPip`, `defineApp`,
 * `testApp` / `bootTestApp`, plus lifecycle / manifest / diagnostics types.
 *
 * Does NOT re-export the legacy `Dot` / `createDot` builder or the legacy
 * auth/db/event-sourcing modules. Adapter packages (e.g. `@arki/env/dot`,
 * `@arki/kv/dot`, `@arki/db/dot`) import from this subpath so their
 * `*.d.ts` graphs do not pull in the legacy surface — keeping their
 * compile times tight and decoupling adapters from the legacy retirement
 * schedule (Task 12).
 *
 * @example
 * ```ts
 * import { defineDotPip, type DotPip } from '@arki/dot/pip';
 * ```
 */

export { defineDotPip, DotPipError } from './pip-contract.js';
export type {
  AnyDotPip,
  DotPip,
  DotBootContext,
  DotBootResult,
  DotConfigureContext,
  DotDisposeContext,
  DotManifestContext,
  DotManifestContribution,
  DotStartContext,
  DotStopContext,
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
