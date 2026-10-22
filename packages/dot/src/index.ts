/**
 * @arki/dot — Compose an app from typed units that boot in declaration order and dispose in reverse.
 *
 * Public surface:
 *   - `defineApp(name)` — the entry point for composing applications.
 *   - `infra(config)` — author lifecycle-aware units with typed needs/provides.
 *   - `service<T>()` / `token<T>()(key)` — service witnesses for DI wiring.
 *   - `rename(unit, map)` — mount-time multi-instance primitive.
 *   - Lifecycle / manifest / diagnostics types.
 *   - `testApp` / `bootTestApp` — test harnesses for unit authors.
 */

// #region Kernel — public surface
export { defineApp } from './define-app.js';
export type {
  DotApp,
  DotAppBuilder,
  DotAppConfigured,
  DotAppLifecycle,
  DotServeBuilder,
  FeatureUnits,
  NormalizeProvides,
  UseAllAvail,
  UseAllGuard,
  UseGuard,
} from './define-app.js';

export { entrypoint, infra, isLazy, lazy, lazyOf, provide, rename, service, token, DotUnitError } from './unit-contract.js';
export { LazyClosed } from './lazy.js';
export type {
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
  RenamedProvides,
  Service,
  ServiceRecord,
  Token,
  WireNeeds,
} from './unit-contract.js';

export { initUnits } from './init-units.js';
export type { InitUnitsFactory } from './init-units.js';

export { DotLifecycleError, DotLifecycleErrorCode, DOT_LIFECYCLE_HOOKS } from './lifecycle.js';
export type {
  DotLifecycleHook,
  DotLifecycleState,
  DotLifecycleUnitFailure,
  DotLifecycleErrorCodeValue,
} from './lifecycle.js';

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
export { DOT_MANIFEST_ERROR_CODE, DotManifestError, toJsonObject } from './manifest.js';

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
  DotHandlerCompletedEvent,
  DotHandlerFailedEvent,
  DotHandlerLifecycleEvent,
  DotHandlerStartingEvent,
  DotHandlerTransport,
  DotPhaseLifecycleEvent,
  DotUnitHookLifecycleEvent,
} from './lifecycle-observer.js';

export type { DotHandlerObserver, DotHandlerOutcome, DotHandlerRef } from './unit-contract.js';
export { logHandlers, reportErrors } from './handler-observers.js';
export type { ReportErrorsOptions } from './handler-observers.js';

export { renderTimeline } from './timeline.js';
export type { RenderTimelineOptions } from './timeline.js';

export { fake, testApp, bootTestApp, testUnit } from './test-harness.js';
export type { TestAppOptions, TestUnitBuilder } from './test-harness.js';

export { hookSignals } from './signals.js';
export type { HookSignalsOptions, SignalTarget } from './signals.js';

// #endregion

export { telemetryFor } from './telemetry.js';
export type { DotTelemetry } from './telemetry.js';
