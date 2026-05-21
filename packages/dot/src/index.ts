/**
 * @arki/dot — TypeScript-first application composition framework
 *
 * Public surface:
 *   - `defineApp(name)` — the modern entry point for composing applications.
 *   - `defineDotPlugin(config)` — define lifecycle-aware plugins.
 *   - Lifecycle / manifest / diagnostics types.
 *   - `testApp` / `bootTestApp` — test harnesses for plugin authors.
 */

// #region New kernel — public surface (Task 9a)
export { defineApp } from './define-app.js';
export type { DotApp, DotAppBuilder, DotAppConfigured } from './define-app.js';

export { defineDotPlugin } from './plugin-contract.js';
export type {
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

export { testApp, bootTestApp } from './test-harness.js';
export type { TestAppOptions } from './test-harness.js';

// Task 9b: CLI envelope type is exported so adapter packages can produce the
// same shape from related tooling (release-tooling, plugin scaffolds, etc.).
export type { DotCliEnvelope, DotCliEnvelopeStatus } from './cli/render-explain.js';
// #endregion
