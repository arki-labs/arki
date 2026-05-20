/**
 * Public surface of `@arki/arki-release` for in-monorepo consumers.
 *
 * Re-exports the shared types, JSON envelope helpers, and CLI primitives
 * so future tasks (and tests) can import a single entry point:
 *
 *   import { createEnvelope, emitEnvelope } from '@arki/arki-release';
 *   import type { ReleaseCommandEnvelope } from '@arki/arki-release';
 */

export { createEnvelope, emitEnvelope, renderHumanText } from './json-output';
export type { CreateEnvelopeOptions, EmitEnvelopeOptions } from './json-output';

export { dispatch, parseArgs } from './cli';

export { CONFIG_ERROR_CODES, defaultConfigPath, loadConfig, ReleaseConfigError, validateConfig } from './config';

export {
  buildDependencyGraph,
  collectReachableArkiDeps,
} from './dependency-graph';
export type { DependencyGraph, DependencyNode } from './dependency-graph';

export {
  classifyManifests,
  discoverManifests,
  INVENTORY_ERROR_CODES,
  runInventory,
} from './inventory';
export type {
  ClassifyManifestsOptions,
  InventoryItem,
  InventorySummary,
  ParsedManifest,
  RunInventoryOptions,
} from './inventory';

export {
  CATALOG_ERROR_CODES,
  CatalogLoadError,
  isCatalogRef,
  loadCatalogs,
  resolveCatalogRef,
} from './catalogs';
export type { ResolveCatalogResult } from './catalogs';

export { MANIFEST_ERROR_CODES, materializeManifest } from './manifest';

export type {
  CatalogTables,
  InventoryBlocker,
  MaterializationContext,
  MaterializationResult,
  PackageClassification,
  PackageWave,
  ParsedCliArgs,
  PublicMetadataDefaults,
  PublishableManifest,
  ReleaseCommand,
  ReleaseCommandEnvelope,
  ReleaseConfig,
  ReleaseError,
  ReleaseErrorSeverity,
  ReleaseStatus,
  ReleaseWave,
  ReleaseWaveId,
} from './types';
