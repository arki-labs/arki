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
  collectTransitiveDeps,
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

export type {
  PackageClassification,
  PackageWave,
  ParsedCliArgs,
  PublicMetadataDefaults,
  ReleaseCommand,
  ReleaseCommandEnvelope,
  ReleaseConfig,
  ReleaseError,
  ReleaseErrorSeverity,
  ReleaseStatus,
  ReleaseWave,
  ReleaseWaveId,
} from './types';
