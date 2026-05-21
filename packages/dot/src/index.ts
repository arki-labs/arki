/**
 * @arki/dot — TypeScript-first application composition framework
 *
 * Public surface:
 *   - `defineApp(name)` — the modern entry point for composing applications.
 *   - `defineDotPlugin(config)` — define lifecycle-aware plugins.
 *   - Lifecycle / manifest / diagnostics types.
 *   - `testApp` / `bootTestApp` — test harnesses for plugin authors.
 *
 * Legacy surface (re-exported, deprecated):
 *   - `Dot`, `createDot`, `definePlugin`, and the legacy auth/db/event-sourcing
 *     modules — see the `./legacy` barrel.
 *
 * New code MUST use `defineApp`. The legacy `createDot` builder is preserved
 * for backward compatibility and will be removed in a future major version.
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

// #region Legacy surface (Task 9c — quarantined, @deprecated)
//
// Re-exported from `./legacy` so in-tree consumers (games-platform, kapodopera)
// keep working until Task 12 migrates them to `defineApp`. Public consumers
// installing `@arki/dot` from npm MUST use the new kernel surface above.
export * from './legacy/index.js';
// #endregion
