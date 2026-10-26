/**
 * The unit author's surface: the `unit` / `infra` / `entrypoint` constructors,
 * handles, tokens, `rename` and the contract types.
 *
 * Exposes the unit contract and the entry points a unit author needs to
 * author + test units — `infra`, `entrypoint` (and their `fromFeatures`
 * forms), `unit`, `service`, `token`, `provide`, `rename`, `defineApp`,
 * `testApp` / `bootTestApp`, plus lifecycle / manifest / diagnostics types.
 *
 * Adapter packages (e.g. `@arki/dot/env`, `@arki/kv/dot`, `@arki/db/dot`)
 * import from this subpath so their `*.d.ts` graphs stay tight.
 *
 * @example
 * ```ts
 * import { infra, service, type Unit } from '@arki/dot/unit';
 * ```
 */

export {
  handleOf,
  isLazy,
  lazy,
  lazyOf,
  entrypoint,
  infra,
  provide,
  rename,
  service,
  token,
  unit,
  DotUnitError,
} from './unit-contract.js';
export { LazyClosed } from './lazy.js';
export { resolveDeferred } from './deferred.js';
export type { Deferred } from './deferred.js';
export type {
  EntrypointBinder,
  FeaturesContext,
  FromFeaturesDefinition,
  InfraBinder,
  PhasedAuthoredUnit,
  PlainAuthoredUnit,
  EntrypointRole,
  InfraRole,
  NoRole,
  UnitBinder,
} from './unit-contract.js';
export type {
  AnyHandle,
  AnyUnit,
  AuthoredUnit,
  FactoryContract,
  FactoryContractOf,
  UnitFactoryGuard,
  UnitSourceGuard,
  UnitPreparation,
  LoggingSlot,
  BootSlot,
  UnitRole,
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
  Unit,
  UnitNeeds,
  InferredOwnership,
  ProvidedValues,
  ProvidedValue,
  UnitOwnership,
  UnitOpenFailure,
  UnitCloseFailure,
  UnitPhases,
  EmptyPhases,
  UnitPhaseFailures,
  InferredPhases,
  MergePhases,
  UnitProvides,
  Provided,
  ProvidesFactories,
  ProjectionDeclaration,
  RenamedProvides,
  Service,
  ServiceRecord,
  Token,
  WireNeeds,
} from './unit-contract.js';

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

export { initUnits } from './init-units.js';
export type { InitUnitsFactory } from './init-units.js';

export { testApp, bootTestApp } from './test-harness.js';
export type { TestAppOptions } from './test-harness.js';

export type {
  DotLifecycleHook,
  DotLifecycleState,
  DotLifecycleUnitFailure,
  DotLifecycleErrorCodeValue,
} from './lifecycle.js';
export { DotLifecycleError, DotLifecycleErrorCode, DOT_LIFECYCLE_HOOKS } from './lifecycle.js';

export type {
  DotAppManifest,
  ActionDirection,
  ActionManifest,
  JsonObject,
  JsonValue,
  UnitManifest,
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
  UnitDiagnostic,
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
  DotUnitHookLifecycleEvent,
} from './lifecycle-observer.js';

export { renderTimeline } from './timeline.js';
export type { RenderTimelineOptions } from './timeline.js';

export { telemetryFor } from './telemetry.js';
export type { DotTelemetry } from './telemetry.js';
