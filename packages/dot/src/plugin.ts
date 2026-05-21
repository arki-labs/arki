/**
 * Narrow public surface for plugin authors.
 *
 * Exposes the new-kernel plugin contract and the entry points a plugin
 * author needs to author + test plugins — `defineDotPlugin`, `defineApp`,
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
 * import { defineDotPlugin, type DotPlugin } from '@arki/dot/plugin';
 * ```
 */

export { defineDotPlugin } from './plugin-contract.js';
export type {
  AnyDotPlugin,
  DotPlugin,
  DotBootContext,
  DotBootResult,
  DotConfigureContext,
  DotDisposeContext,
  DotManifestContext,
  DotManifestContribution,
  DotStartContext,
  DotStopContext,
} from './plugin-contract.js';

export { defineApp } from './define-app.js';
export type { DotApp, DotAppBuilder, DotAppConfigured } from './define-app.js';

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
  PluginManifest,
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
  PluginDiagnostic,
  RouteDiagnostic,
  ServiceDiagnostic,
  LifecycleDiagnostic,
  DiagnosticIssue,
  DiagnosticSeverity,
  DiagnosticStatus,
} from './diagnostics.js';
