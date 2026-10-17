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

export {
  buildCopyPlan,
  DEFAULT_FILE_EXCLUDES,
  DEFAULT_FILE_INCLUDES,
  executeCopyPlan,
  removeDirectory,
} from './files';
export type { BuildCopyPlanOptions, CopyPlanEntry } from './files';

export { EXPORT_ERROR_CODES, exportPublicTree } from './export-public';

export {
  DEFAULT_PACKAGE_MANAGERS,
  defaultProcessRunner,
  FIXTURE_ERROR_CODES,
  runFixtureMatrix,
} from './fixture';
export type { FixtureOptions, ProcessResult, ProcessRunner } from './fixture';

export {
  DEFAULT_EXCLUDE_DIRS,
  DEFAULT_LEAK_PATTERNS,
  DEFAULT_SCAN_EXTENSIONS,
  LEAK_ERROR_CODES,
  NEUTRAL_ALLOW_PATTERNS,
  scanDirectory,
  scanFile,
  scanText,
} from './leaks';
export type { ScanDirectoryOptions } from './leaks';

export {
  auditPack,
  auditPackEntry,
  DEFAULT_PACK_RULES,
  PACK_ERROR_CODES,
  runNpmPack,
} from './pack';
export type { NpmPackResult } from './pack';
export type { ExecRunner, GitRunner, NpmRunner, RunOutput } from './runners';
export { defaultGitRunner, defaultNpmRunner, execRunner } from './runners';

export { renderScorecardText, runScorecard, SCORECARD_ERROR_CODES } from './scorecard';
export type { ScorecardOptions } from './scorecard';

export { HISTORY_ERROR_CODES, renderHistoryText, runHistory } from './history';
export type {
  HistoryItem,
  HistoryOptions,
  HistoryStatus,
  HistorySummary,
} from './history';

export {
  renderSyncPackageReposText,
  runSyncPackageRepos,
  SYNC_REPO_ERROR_CODES,
} from './sync-package-repos';

export type {
  CatalogTables,
  ExportItem,
  ExportItemStatus,
  ExportOptions,
  ExportSummary,
  FixtureMatrix,
  FixtureMatrixSummary,
  FixtureRun,
  FixtureRunStatus,
  FixtureStage,
  FixtureStageName,
  FixtureStageStatus,
  InventoryBlocker,
  LeakHit,
  LeakPattern,
  LeakSeverity,
  MaterializationContext,
  MaterializationResult,
  NpmPackEntry,
  NpmPackFileEntry,
  PackAuditContext,
  PackAuditResult,
  PackAuditRule,
  PackageClassification,
  PackageManagerId,
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
  ScorecardDimension,
  ScorecardDimensionResult,
  ScorecardPackageResult,
  ScorecardStatus,
  ScorecardSummary,
  SyncRepoItem,
  SyncRepoOptions,
  SyncRepoStatus,
  SyncRepoSummary,
  HistoryRepoStatus,
} from './types';
