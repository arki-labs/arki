/**
 * Public-tree exporter — materialize `.release/arki-public/` from the
 * release allowlists + per-package manifests.
 *
 * This module is the first step in the pipeline that writes files to
 * disk. Everything upstream (inventory, leak scanner, materializer) is
 * pure; the exporter combines those primitives + raw-JSON re-reads of
 * each source manifest to produce a clean, deterministic tree under
 * `config.publicTreePath`.
 *
 * Pipeline:
 *
 *   1. Resolve and validate the output path. Path-safety guard refuses
 *      anything that escapes `rootCwd`.
 *   2. Wipe the output dir so regeneration is deterministic.
 *   3. Run `runInventory` and keep only the `public-candidate` items
 *      (plus `blocked-by-leak` when `includeBlockedByLeak: true`).
 *   4. Load the root catalogs and build the workspace/private-package
 *      maps from the inventory.
 *   5. For each candidate:
 *        a. Re-read the source manifest as raw JSON (for fields the
 *           inventory's narrow `ParsedManifest` doesn't capture).
 *        b. Materialize the publishable manifest. Fatal errors here
 *           skip the package with `status: 'failed'`.
 *        c. Run the pre-output leak gate over the SOURCE directory (the
 *           same files we're about to copy). Any error-severity hit
 *           skips the package unless `leakScan: false`.
 *        d. Build + execute the deterministic copy plan.
 *        e. Overwrite the destination `package.json` with the
 *           materialized one (pretty-printed, trailing newline).
 *   6. Write the top-level `package.json`, `.gitignore`, and `README.md`
 *      for the generated tree.
 *   7. Return the envelope.
 *
 * Determinism guarantees: the second run produces byte-identical
 * output. The exporter never preserves mtimes (modern publish tooling
 * ignores them) and never embeds timestamps into emitted files —
 * `generatedAt` lives in the envelope only.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import debugFactory from 'debug';

import { loadCatalogs } from './catalogs';
import {
  buildCopyPlan,
  executeCopyPlan,
  removeDirectory,
  type CopyPlanEntry,
} from './files';
import { runInventory, type InventoryItem, type ParsedManifest } from './inventory';
import { createEnvelope } from './json-output';
import { DEFAULT_LEAK_PATTERNS, scanDirectory } from './leaks';
import { materializeManifest } from './manifest';
import type {
  CatalogTables,
  ExportItem,
  ExportOptions,
  ExportSummary,
  LeakHit,
  PublicMetadataDefaults,
  PublishableManifest,
  ReleaseCommandEnvelope,
  ReleaseError,
} from './types';

const debug = debugFactory('arki:release:export');

/** Stable error codes emitted by the exporter. */
export const EXPORT_ERROR_CODES = {
  /** Resolved output path escapes the workspace root. */
  outputPathOutsideRoot: 'EXPORT_E001',
  /** Pre-output leak gate refused a package because source contained leaks. */
  leakInSource: 'EXPORT_E002',
  /** Materialization produced fatal errors — package not exported. */
  materializationFailed: 'EXPORT_E003',
  /** The pre-output leak gate was disabled by the caller. */
  leakGateDisabled: 'EXPORT_E004',
  /** Source manifest could not be re-read (I/O failure). */
  manifestReadFailed: 'EXPORT_E005',
} as const;

/**
 * The publish-relevant superset of `package.json` fields. {@link ParsedManifest}
 * is intentionally narrow (dep-graph only); the exporter re-reads each
 * manifest from disk so the materializer sees `description`, `exports`,
 * `keywords`, etc. without widening the inventory contract.
 */
interface RawManifest {
  readonly name: string;
  readonly version: string;
  readonly private?: boolean;
  readonly description?: string;
  readonly type?: 'module' | 'commonjs';
  readonly sideEffects?: boolean | readonly string[];
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly main?: string;
  readonly module?: string;
  readonly types?: string;
  readonly files?: readonly string[];
  readonly keywords?: readonly string[];
  readonly repository?: { readonly type: string; readonly url: string };
  readonly bugs?: { readonly url: string };
  readonly homepage?: string;
  readonly license?: string;
  readonly publishConfig?: Readonly<Record<string, unknown>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  readonly bundleDependencies?: readonly string[];
  readonly engines?: Readonly<Record<string, string>>;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
}

/**
 * The main exporter entrypoint — see module-level docs for the pipeline.
 */
export async function exportPublicTree(
  options: ExportOptions,
): Promise<ReleaseCommandEnvelope<ExportItem, ExportSummary>> {
  const { rootCwd, config } = options;
  const leakScan = options.leakScan !== false;
  const includeBlockedByLeak = options.includeBlockedByLeak === true;

  const requestedOutput = options.outputPath ?? config.publicTreePath;
  const outputPath = path.resolve(rootCwd, requestedOutput);

  const errors: ReleaseError[] = [];

  // 1. Path-safety guard — refuse to clean / write outside rootCwd.
  const relativeFromRoot = path.relative(rootCwd, outputPath);
  if (
    relativeFromRoot.length === 0 ||
    relativeFromRoot.startsWith('..') ||
    path.isAbsolute(relativeFromRoot)
  ) {
    errors.push({
      code: EXPORT_ERROR_CODES.outputPathOutsideRoot,
      severity: 'error',
      message: `Refusing to export to \`${outputPath}\` — path is outside the workspace root \`${rootCwd}\`.`,
      target: outputPath,
      remediation: 'Pass --output as a path inside the workspace, or adjust `publicTreePath` in arki.release.config.ts.',
    });
    const summary: ExportSummary = {
      message: `Export refused: output path \`${outputPath}\` escapes the workspace root.`,
      totalCandidates: 0,
      exported: 0,
      skipped: 0,
      failed: 0,
      outputPath,
    };
    return createEnvelope<ExportItem, ExportSummary>({
      command: 'export-public',
      status: 'failure',
      summary,
      items: [],
      errors,
    });
  }

  // 2. Surface the leak-gate-disabled warning loudly so it lives in the
  // envelope every CI gate parses.
  if (!leakScan) {
    errors.push({
      code: EXPORT_ERROR_CODES.leakGateDisabled,
      severity: 'warning',
      message: 'Pre-output leak gate disabled (--no-leak-scan). Manual audit required before publish.',
      remediation: 'Re-run without --no-leak-scan to enforce the gate.',
    });
  }

  // 3. Discover candidates via the inventory.
  const inventoryEnv = await runInventory({ cwd: rootCwd, config });
  const candidates = inventoryEnv.items.filter(item => {
    if (item.classification === 'public-candidate') return true;
    if (includeBlockedByLeak && item.classification === 'blocked-by-leak') return true;
    return false;
  });

  debug('inventory: %d items, %d candidates', inventoryEnv.items.length, candidates.length);

  // 4. Catalogs + workspace/version maps.
  const rootManifest = await loadRootManifest(rootCwd);
  const catalogs = loadCatalogs(rootManifest);
  const workspaceVersions = new Map<string, string>(
    inventoryEnv.items.map(item => [item.name, item.version]),
  );
  const privateArkiPackages = new Set<string>(
    inventoryEnv.items.filter(item => item.private).map(item => item.name),
  );

  // 5. Wipe + recreate output dir.
  await removeDirectory(outputPath);
  await mkdir(outputPath, { recursive: true });
  await mkdir(path.join(outputPath, 'packages'), { recursive: true });

  // 6. Per-package export.
  const exportItems: ExportItem[] = [];
  let exported = 0;
  let skipped = 0;
  let failed = 0;

  for (const item of candidates) {
    const result = await exportSinglePackage({
      item,
      rootCwd,
      outputPath,
      catalogs,
      workspaceVersions,
      privateArkiPackages,
      metadataDefaults: config.publicMetadataDefaults,
      leakScan,
      leakPatterns: config.leakPatterns,
    });
    exportItems.push(result.exportItem);
    if (result.exportItem.status === 'exported') exported += 1;
    else if (result.exportItem.status === 'skipped') skipped += 1;
    else failed += 1;
    for (const err of result.envelopeErrors) errors.push(err);
  }

  // 7. Root tree scaffolding.
  await writeRootScaffolding(outputPath, options.skipWorkspacesRoot ?? false);

  const status: 'success' | 'failure' = failed > 0 ? 'failure' : 'success';
  const summary: ExportSummary = {
    message:
      failed === 0
        ? `Public tree exported: ${exported.toString()} packages → ${outputPath}.`
        : `Public tree exported with ${failed.toString()} failures (${exported.toString()} exported, ${skipped.toString()} skipped).`,
    totalCandidates: candidates.length,
    exported,
    skipped,
    failed,
    outputPath,
  };

  return createEnvelope<ExportItem, ExportSummary>({
    command: 'export-public',
    status,
    summary,
    items: exportItems,
    errors,
  });
}

/**
 * Inputs to {@link exportSinglePackage}. Internal — not part of the
 * module's public surface but typed so the function stays testable.
 */
interface ExportSingleOptions {
  readonly item: InventoryItem;
  readonly rootCwd: string;
  readonly outputPath: string;
  readonly catalogs: CatalogTables;
  readonly workspaceVersions: ReadonlyMap<string, string>;
  readonly privateArkiPackages: ReadonlySet<string>;
  readonly metadataDefaults: PublicMetadataDefaults;
  readonly leakScan: boolean;
  readonly leakPatterns?: ReadonlyArray<import('./types').LeakPattern>;
}

/** Result returned by {@link exportSinglePackage}. */
interface ExportSingleResult {
  readonly exportItem: ExportItem;
  readonly envelopeErrors: readonly ReleaseError[];
}

/**
 * Export a single package. The function is intentionally fail-soft —
 * any error becomes a `status: 'failed' | 'skipped'` entry plus matching
 * envelope errors rather than an exception. The exporter as a whole
 * keeps going so the operator gets one cohesive report.
 */
async function exportSinglePackage(opts: ExportSingleOptions): Promise<ExportSingleResult> {
  const sourceManifestPath = path.resolve(opts.rootCwd, opts.item.manifestPath);
  const packageSourceDir = path.dirname(sourceManifestPath);
  const packageDirName = path.basename(packageSourceDir);
  const packageDestDir = path.join(opts.outputPath, 'packages', packageDirName);

  const baseItem = {
    name: opts.item.name,
    version: opts.item.version,
    sourcePath: path.relative(opts.rootCwd, packageSourceDir),
    destPath: path.relative(opts.rootCwd, packageDestDir),
  };

  // a. Re-read raw manifest from disk.
  let raw: RawManifest;
  try {
    raw = await readRawManifest(sourceManifestPath);
  } catch (cause) {
    const error: ReleaseError = {
      code: EXPORT_ERROR_CODES.manifestReadFailed,
      severity: 'error',
      message: `Failed to re-read ${opts.item.name} manifest at ${sourceManifestPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      target: opts.item.name,
      remediation: 'Verify the manifest exists and is valid JSON.',
    };
    return {
      exportItem: {
        ...baseItem,
        fileCount: 0,
        status: 'failed',
        reason: error.message,
        errors: [error],
      },
      envelopeErrors: [error],
    };
  }

  // b. Materialize the publishable manifest.
  const parsedForMaterializer = synthesizeParsedManifest(opts.item, raw);
  const materialization = materializeManifest(parsedForMaterializer, {
    catalogs: opts.catalogs,
    workspaceVersions: opts.workspaceVersions,
    privateArkiPackages: opts.privateArkiPackages,
    metadataDefaults: opts.metadataDefaults,
  });

  const fatalMaterializationErrors = materialization.errors.filter(e => e.severity === 'error');
  if (fatalMaterializationErrors.length > 0) {
    const summary: ReleaseError = {
      code: EXPORT_ERROR_CODES.materializationFailed,
      severity: 'error',
      message: `${opts.item.name}: materialization produced ${fatalMaterializationErrors.length.toString()} fatal error(s).`,
      target: opts.item.name,
      remediation: 'Resolve the underlying RELEASE_E0xx errors (see envelope.errors) and re-run.',
    };
    const allErrors: ReleaseError[] = [summary, ...materialization.errors];
    return {
      exportItem: {
        ...baseItem,
        fileCount: 0,
        status: 'failed',
        reason: summary.message,
        errors: allErrors,
      },
      envelopeErrors: allErrors,
    };
  }

  // c. Pre-output leak gate over the SOURCE directory.
  if (opts.leakScan) {
    const patterns = opts.leakPatterns ?? DEFAULT_LEAK_PATTERNS;
    const hits = await scanDirectory(packageSourceDir, { patterns });
    const blockingHits = hits.filter(h => h.severity === 'error');
    if (blockingHits.length > 0) {
      const summary = buildLeakGateError(opts.item.name, blockingHits);
      const allErrors: ReleaseError[] = [summary, ...materialization.errors];
      return {
        exportItem: {
          ...baseItem,
          fileCount: 0,
          status: 'skipped',
          reason: 'leak hits in source',
          errors: allErrors,
        },
        envelopeErrors: allErrors,
      };
    }
  }

  // d. Build + execute the copy plan.
  const plan = await buildCopyPlan({
    packageSourceDir,
    packageDestDir,
    manifestFiles: raw.files,
  });
  await mkdir(packageDestDir, { recursive: true });
  await executeCopyPlan(plan);

  // e. Overwrite the copied package.json with the materialized one.
  await writeJsonFile(
    path.join(packageDestDir, 'package.json'),
    serializePublishableManifest(materialization.manifest),
  );

  return {
    exportItem: {
      ...baseItem,
      fileCount: countDistinctFiles(plan),
      status: 'exported',
      errors: materialization.errors,
    },
    envelopeErrors: materialization.errors,
  };
}

/**
 * Build the leak-gate skip error from one or more blocking hits.
 *
 * The first hit drives the message wording; the rest are surfaced via
 * the `LeakHit[]` payload so operators can see every hit at once.
 */
function buildLeakGateError(packageName: string, hits: readonly LeakHit[]): ReleaseError {
  const first = hits[0];
  const previewParts: string[] = [];
  for (const hit of hits.slice(0, 3)) {
    previewParts.push(`${hit.patternId}@${hit.sourcePath}:${hit.line.toString()}`);
  }
  const preview = previewParts.join(', ');
  const more = hits.length > 3 ? ` (+${(hits.length - 3).toString()} more)` : '';
  return {
    code: EXPORT_ERROR_CODES.leakInSource,
    severity: 'error',
    message: `${packageName}: ${hits.length.toString()} leak hit(s) in source — refusing to copy. First: ${first?.description ?? '<unknown>'}. Hits: ${preview}${more}.`,
    target: packageName,
    remediation: 'Run `bun release:arki audit --package <name>` to inspect; remove the leaked identifier(s) and re-run.',
  };
}

/**
 * Build a {@link ParsedManifest} that carries the raw manifest's
 * publish-relevant fields. The materializer's `readManifestRaw` reads
 * these via a side-channel cast — we attach them here so the
 * materializer doesn't need to know about disk I/O.
 */
function synthesizeParsedManifest(
  item: InventoryItem,
  raw: RawManifest,
): ParsedManifest {
  const extras: Partial<RawManifest> = {
    description: raw.description,
    type: raw.type,
    sideEffects: raw.sideEffects,
    exports: raw.exports,
    main: raw.main,
    module: raw.module,
    types: raw.types,
    files: raw.files,
    keywords: raw.keywords,
    repository: raw.repository,
    bugs: raw.bugs,
    homepage: raw.homepage,
    license: raw.license,
    publishConfig: raw.publishConfig,
    peerDependenciesMeta: raw.peerDependenciesMeta,
    bundleDependencies: raw.bundleDependencies,
    engines: raw.engines,
    dependencies: raw.dependencies,
    peerDependencies: raw.peerDependencies,
    optionalDependencies: raw.optionalDependencies,
  };
  const base: ParsedManifest = {
    manifestPath: item.manifestPath,
    name: item.name,
    version: item.version,
    private: item.private,
    dependencies: raw.dependencies,
    peerDependencies: raw.peerDependencies,
    optionalDependencies: raw.optionalDependencies,
  };
  // The materializer reads the publish-relevant extras via a
  // `Partial<ManifestRaw>` cast — see manifest.ts `readManifestRaw`.
  // We mirror that contract here.
  return Object.assign({}, base, extras) as ParsedManifest;
}

/**
 * Re-read a manifest file as raw JSON. Returns a defensively-narrowed
 * {@link RawManifest} — any field missing on disk shows up as `undefined`
 * so downstream code can use the materializer's existing defaulting.
 */
async function readRawManifest(absolutePath: string): Promise<RawManifest> {
  const contents = await readFile(absolutePath, 'utf8');
  const parsed: unknown = JSON.parse(contents);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Manifest at ${absolutePath} is not a JSON object.`);
  }
  const m = parsed as Record<string, unknown>;
  const name = m['name'];
  const version = m['version'];
  if (typeof name !== 'string' || typeof version !== 'string') {
    throw new Error(`Manifest at ${absolutePath} is missing \`name\` or \`version\`.`);
  }
  return {
    name,
    version,
    private: m['private'] === true,
    description: typeof m['description'] === 'string' ? m['description'] : undefined,
    type: m['type'] === 'module' || m['type'] === 'commonjs' ? m['type'] : undefined,
    sideEffects: narrowSideEffects(m['sideEffects']),
    exports: narrowRecord(m['exports']),
    main: typeof m['main'] === 'string' ? m['main'] : undefined,
    module: typeof m['module'] === 'string' ? m['module'] : undefined,
    types: typeof m['types'] === 'string' ? m['types'] : undefined,
    files: narrowStringArray(m['files']),
    keywords: narrowStringArray(m['keywords']),
    repository: narrowRepository(m['repository']),
    bugs: narrowBugs(m['bugs']),
    homepage: typeof m['homepage'] === 'string' ? m['homepage'] : undefined,
    license: typeof m['license'] === 'string' ? m['license'] : undefined,
    publishConfig: narrowRecord(m['publishConfig']),
    peerDependenciesMeta: narrowPeerDependenciesMeta(m['peerDependenciesMeta']),
    bundleDependencies: narrowStringArray(m['bundleDependencies']),
    engines: narrowStringRecord(m['engines']),
    dependencies: narrowStringRecord(m['dependencies']),
    peerDependencies: narrowStringRecord(m['peerDependencies']),
    optionalDependencies: narrowStringRecord(m['optionalDependencies']),
  };
}

function narrowSideEffects(raw: unknown): boolean | readonly string[] | undefined {
  if (typeof raw === 'boolean') return raw;
  if (Array.isArray(raw) && raw.every(v => typeof v === 'string')) {
    return raw as readonly string[];
  }
  return undefined;
}

function narrowRecord(raw: unknown): Readonly<Record<string, unknown>> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return raw as Readonly<Record<string, unknown>>;
}

function narrowStringRecord(raw: unknown): Readonly<Record<string, string>> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v;
  }
  return out;
}

function narrowStringArray(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (!raw.every(v => typeof v === 'string')) return undefined;
  return raw as readonly string[];
}

function narrowRepository(raw: unknown): { readonly type: string; readonly url: string } | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r['type'] !== 'string' || typeof r['url'] !== 'string') return undefined;
  return { type: r['type'], url: r['url'] };
}

function narrowBugs(raw: unknown): { readonly url: string } | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r['url'] !== 'string') return undefined;
  return { url: r['url'] };
}

function narrowPeerDependenciesMeta(
  raw: unknown,
): Readonly<Record<string, { readonly optional?: boolean }>> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: Record<string, { readonly optional?: boolean }> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) continue;
    const entry = v as Record<string, unknown>;
    out[k] = { ...(typeof entry['optional'] === 'boolean' ? { optional: entry['optional'] } : {}) };
  }
  return out;
}

/**
 * Load and parse the root `package.json` so {@link loadCatalogs} can
 * extract the catalog tables. We don't validate the root shape here —
 * `loadCatalogs` does that and throws a structured error if needed.
 */
async function loadRootManifest(rootCwd: string): Promise<unknown> {
  const rootPath = path.join(rootCwd, 'package.json');
  const contents = await readFile(rootPath, 'utf8');
  return JSON.parse(contents) as unknown;
}

/**
 * Write the top-level scaffolding for the generated tree.
 *
 * The generated tree is meant to be `git push`-able to `arki-labs/arki`
 * as-is: every file the public repo needs to install, build, and publish
 * is produced here. The contents are split into three groups:
 *
 *   1. Build/install bootstrap
 *      - `package.json` (private root, `workspaces: ['packages/*']`)
 *      - `.gitignore`
 *
 *   2. Outward-facing project surface
 *      - `README.md`     — landing page for humans on the public repo
 *      - `LICENSE`       — MIT (matches each package's bundled LICENSE)
 *      - `AGENTS.md`     — agent-discoverable docs convention
 *
 *   3. Release pipeline (Changesets + GitHub Actions)
 *      - `.changeset/config.json`
 *      - `.changeset/README.md`
 *      - `.github/workflows/release.yml`
 *
 * All content is static. Determinism is preserved: regeneration produces
 * byte-identical output, so `removeDirectory` + `writeRootScaffolding`
 * is safe to run on every export.
 */
async function writeRootScaffolding(
  outputPath: string,
  skipWorkspacesRoot: boolean,
): Promise<void> {
  // Conditionally include the `workspaces` field. Omitting it makes the
  // tree publish-safe (npm publish parent-walks find a non-workspace
  // root and behave normally); including it makes the tree dev-friendly
  // (cloning `arki-labs/arki` + `bun install` resolves all 14 packages).
  const rootPackage: Record<string, unknown> = {
    name: 'arki-public',
    version: '0.0.0',
    private: true,
    description:
      'Generated public ARKI package tree — do not edit by hand. Regenerate with `bun release:arki export-public`.',
  };
  if (!skipWorkspacesRoot) {
    rootPackage['workspaces'] = ['packages/*'];
  }
  await writeJsonFile(path.join(outputPath, 'package.json'), rootPackage);

  const gitignore = ['node_modules/', 'dist/', '.turbo/', ''].join('\n');
  await writeFile(path.join(outputPath, '.gitignore'), gitignore, 'utf8');

  await writeTextFile(path.join(outputPath, 'LICENSE'), MIT_LICENSE_TEXT);
  await writeTextFile(path.join(outputPath, 'README.md'), PUBLIC_README);
  await writeTextFile(path.join(outputPath, 'AGENTS.md'), PUBLIC_AGENTS_MD);

  await writeJsonFile(path.join(outputPath, '.changeset', 'config.json'), CHANGESET_CONFIG);
  await writeTextFile(path.join(outputPath, '.changeset', 'README.md'), CHANGESET_README);

  await writeTextFile(
    path.join(outputPath, '.github', 'workflows', 'release.yml'),
    RELEASE_WORKFLOW,
  );
}

/**
 * MIT license text. Matches the {@link CURRENT_LICENSE_YEAR} stamped on
 * each package's bundled LICENSE so the public repo and the published
 * tarballs agree. Year is frozen — bumping it is a one-line edit here.
 */
const MIT_LICENSE_TEXT = [
  'MIT License',
  '',
  'Copyright (c) 2026 ARKI Contributors',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in',
  'all copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN',
  'THE SOFTWARE.',
  '',
].join('\n');

/**
 * Outward-facing README. Describes ARKI to a developer landing on
 * `github.com/arki-labs/arki` from npm, search, or a link. The page is
 * structured around DOT (the kernel) because every other package only
 * makes sense in relation to it: opens with the framework tagline, then
 * a substantial "what is DOT?" section with a real `defineApp` example
 * showing typed services + the 5-hook lifecycle, then the composition
 * problem the framework exists to solve, then the package list, then
 * the doctrine. Voice rules from `apps/arki/docs/sitemap/_design-context.md`:
 * no exclamation marks, no "magic" / "blazing" / "revolutionary", no
 * marketing puff. Show, don't promise.
 */
const PUBLIC_README = [
  '# ARKI',
  '',
  'A TypeScript-first application composition framework.',
  '',
  'Tiny kernel. Package-owned adapters. First-class diagnostics.',
  '',
  '```bash',
  'bun add @arki/dot',
  '```',
  '',
  '## What DOT is',
  '',
  '[`@arki/dot`](packages/dot) is the kernel — the framework that ties every',
  'other `@arki/*` package together. A DOT app is composed of **pips**:',
  'small, lifecycle-aware units that publish typed services and compose',
  'deterministically. The kernel itself is tiny; everything else lives in',
  'a package you opt into with `.use()`.',
  '',
  '```ts',
  "import { defineApp } from '@arki/dot';",
  "import { env }       from '@arki/env/dot';",
  "import { db }        from '@arki/db/dot';",
  "import { kv }        from '@arki/kv/dot';",
  '',
  "export const app = await defineApp('billing')",
  '  .use(env({ schema }))',
  '  .use(db({ schema: dbSchema }))',
  '  .use(kv())',
  '  .boot();',
  '',
  '// Each .use() extends the inferred app type. After .boot() the services',
  '// are typed end-to-end — no DI container, no decorators, no manual wiring.',
  '',
  'app.services.env.DATABASE_URL;     // string (inferred from your env schema)',
  'app.services.db.query.users;       // typed query builder',
  "await app.services.kv.get('key');  // typed get/set",
  '```',
  '',
  '### The lifecycle',
  '',
  'Every pip plugs into the same five hooks, run in declaration order',
  '(teardown in reverse):',
  '',
  '```text',
  'configure  ─►  boot  ─►  start  ─►  stop  ─►  dispose',
  '```',
  '',
  '- **`configure`** — read env, validate, register schemas. No I/O.',
  '- **`boot`**      — open connections, run migrations, hydrate caches.',
  '- **`start`**     — begin accepting work (HTTP listen, queue subscribe).',
  '- **`stop`**      — drain in-flight work; refuse new requests.',
  '- **`dispose`**   — release resources; final flush.',
  '',
  'Failure at any hook produces a `DotDiagnostic` with a stable code, a',
  'severity, and a remediation URL. The kernel collects them in the',
  '`DotAppManifest` so a CLI, a probe, or an agent can read the same shape.',
  '',
  '### Typed services, no DI container',
  '',
  'A pip declares the services it **needs** as typed witnesses and',
  '**provides** services by returning them from `boot` — provides are',
  'inferred from the return type, never declared separately:',
  '',
  '```ts',
  "import { pip, service } from '@arki/dot';",
  '',
  'const billing = pip({',
  "  name: 'billing',",
  '  needs: { db: service<Db>() },          // typed injection witness',
  '  async boot({ db }) {',
  '    return { billing: makeBilling(db) }; // the return IS the provides',
  '  },',
  '});',
  '```',
  '',
  'The kernel infers `app.services.<key>` from the chain of `.use()` calls,',
  'and the builder guard makes wrong wiring a compile error at the `.use()`',
  'call site — unsatisfied needs, type mismatches, and key collisions do',
  'not compile. Declaration order is boot order, so dependency cycles are',
  'unrepresentable. Adding a pip extends the types, and removing one is a',
  'compile-time break, not a runtime surprise. No decorators. No',
  'reflection. No global registry.',
  '',
  "Cross-package contracts use tokens (`token<T>()('arki.db')`) with",
  'free-choice local aliases; `rename()` mounts a second instance of an',
  'adapter without key collisions; `lazy()` defers an expensive open until',
  'first use, with kernel-managed cleanup in reverse order.',
  '',
  '### Agent-native by construction',
  '',
  '- Every error has a stable code and a remediation URL.',
  '- Every CLI command emits a structured JSON envelope under `--json`.',
  '- `dot doctor` returns a machine-readable snapshot of the app graph.',
  '- `dot explain` returns the static manifest — what the app *would* boot.',
  '',
  'Read [`packages/dot/README.md`](packages/dot/README.md) for the full',
  'DOT reference: `defineApp`, the pip contract, lifecycle hooks, manifest',
  'and diagnostics shape, and the CLI.',
  '',
  '## The problem ARKI exists to solve',
  '',
  'Every TypeScript backend eventually composes:',
  '',
  '> `env + db + kv + queue + auth + RPC + jobs + diagnostics + tests`',
  '',
  'You can wire this by hand. Most teams do. But the glue is the bug',
  'surface, and the glue rots faster than the libraries it connects.',
  '',
  'ARKI is that glue, factored into composable packages, with a kernel',
  'that owns the lifecycle and a release pipeline that proves every',
  'published package passes the same gates — pack audit, leak scan,',
  'fixture install, typecheck, docs coverage. Failed gate, no publish.',
  '',
  '## Quick start',
  '',
  '```bash',
  'bunx @arki/dot new my-app',
  'cd my-app',
  'bun install',
  'bun run dev',
  '```',
  '',
  '## Packages',
  '',
  'Every package below is published independently to npm under the',
  '`@arki/*` scope. Each one has its own README with examples and',
  'contract notes.',
  '',
  '| Wave | Packages |',
  '| ---- | -------- |',
  '| **Kernel** | [`@arki/dot`](packages/dot) — application composition kernel |',
  '| **Foundation** | [`@arki/assert`](packages/assert), [`@arki/contracts`](packages/contracts), [`@arki/log`](packages/log), [`@arki/env`](packages/env), [`@arki/ts`](packages/ts), [`@arki/resilience`](packages/resilience), [`@arki/date`](packages/date), [`@arki/string`](packages/string), [`@arki/slugify`](packages/slugify), [`@arki/clock`](packages/clock) |',
  '| **Adapters** | [`@arki/db`](packages/db), [`@arki/kv`](packages/kv), [`@arki/event-sourcing`](packages/event-sourcing) |',
  '',
  '## Doctrine',
  '',
  "Five rules we don't break to ship faster:",
  '',
  '1. **No shortcuts.** Every published package passes the release',
  '   scorecard (pack audit, leak scan, fixture install, typecheck,',
  '   docs coverage) before it is published. Failed gate, no publish.',
  '2. **Test the boundary, not the implementation.** Packed tarballs,',
  '   public exports, CLI output, JSON envelopes, generated apps — those',
  '   are what is tested. Private helpers are not tested directly.',
  '3. **Framework quality bar: Laravel / Rails-level discipline.**',
  '   Coherent conventions. Excellent generators. Documented errors.',
  '   Tiny polished kernel over broad rough framework.',
  '4. **Peer respect, not ridicule.** AdonisJS, ElysiaJS, Hono, NestJS',
  '   are excellent at the jobs they were built for. DOT does a',
  "   different job. We learn from them.",
  '5. **Agents are first-class readers.** Every error has a stable code.',
  '   Every CLI has a `--json` envelope. Every page has an `llms.txt`',
  '   entry. The site is tested for agent comprehension, not only human',
  '   comprehension.',
  '',
  '## Status',
  '',
  "ARKI is on the experimental track (`0.0.x` for foundation packages,",
  "`0.1.x` for the kernel and adapters). The kernel is stable in shape;",
  "adapters are stable per their per-package README; the public API may",
  "evolve before `1.0`. The release scorecard at the upstream workspace",
  "gates every publish.",
  '',
  '## License',
  '',
  'MIT. See [`LICENSE`](LICENSE).',
  '',
  '## Contributing',
  '',
  'This repository is the **generated public mirror** of the ARKI',
  'workspace. Sources are not edited here directly — open issues and',
  'discussion threads instead, and changes land upstream and re-export.',
  '',
].join('\n');

/**
 * `AGENTS.md` for the public repo. The convention (mirrored from the
 * private workspace) tells coding agents where to look for canonical
 * package contracts and the publish pipeline.
 */
const PUBLIC_AGENTS_MD = [
  '# AGENTS.md',
  '',
  '> Agent-discoverable contract for `arki-labs/arki`. Read this first if you',
  '> are an autonomous coding agent landing in this repository.',
  '',
  '## What this repo is',
  '',
  'The public ARKI release tree. Every `packages/<name>` directory is an',
  'independently-versioned npm package under the `@arki/*` scope. The root',
  'is a private workspace whose only job is to host those packages and the',
  'release pipeline that publishes them.',
  '',
  '## Where to look',
  '',
  '- `packages/dot/docs/principles.md` — **read first.** The five rules every',
  '  API, error, and PR is measured against. Slightly playful, very precise.',
  '- `packages/dot/README.md` — DOT framework reference (what a pip is, the',
  '  `defineApp` + `pip()` API, typed needs/provides, lifecycle hooks, CLI).',
  '- `packages/<name>/README.md` — per-package contract and examples.',
  '- `.changeset/` — how versions and changelogs are produced.',
  '- `.github/workflows/release.yml` — how packages get published.',
  '',
  '## How to propose changes',
  '',
  'Source code is mirrored from an upstream workspace, so direct PRs against',
  '`packages/**` will be overwritten on the next export. Open an issue with',
  'a minimal reproducer or design proposal instead — maintainers land the',
  'change upstream and re-export.',
  '',
  '## Stable contracts',
  '',
  "Every `@arki/*` package follows semver. DOT's pip contract (`pip()`,",
  '`Pip`, `service`, `token`, `rename`, `lazy`), `DotAppManifest`, and',
  '`DotDiagnosticsSnapshot` are versioned as part of `@arki/dot` — read its',
  'CHANGELOG before upgrading.',
  '',
].join('\n');

/**
 * `.changeset/config.json` for the public repo. Mirrors the workspace
 * config but: (a) targets `main` (GitHub default) instead of `master`,
 * (b) keeps `commit: false` so the changesets/action step owns commits,
 * (c) keeps `ignore: []` because every public-candidate package is
 * non-private and Changesets respects each package's `private` flag.
 */
const CHANGESET_CONFIG = {
  $schema: 'https://unpkg.com/@changesets/config@3.0.0/schema.json',
  changelog: '@changesets/cli/changelog',
  commit: false,
  fixed: [] as readonly string[],
  linked: [] as readonly string[],
  access: 'public',
  baseBranch: 'main',
  updateInternalDependencies: 'patch',
  ignore: [] as readonly string[],
};

/**
 * `.changeset/README.md` — convention file Changesets writes by default.
 * We override it with a customized note explaining that the contents are
 * generated and that changesets land upstream in the private workspace.
 */
const CHANGESET_README = [
  '# Changesets',
  '',
  'This directory holds [Changesets](https://github.com/changesets/changesets)',
  'configuration for the ARKI public release pipeline.',
  '',
  '## Author flow (maintainers)',
  '',
  'Changesets are authored in the upstream private workspace. When the',
  'export-public job runs, the entire `.changeset/` directory (except this',
  'README and `config.json`) is mirrored here so the `changesets/action`',
  'step can see the pending bumps.',
  '',
  '## Consumer flow',
  '',
  '1. Maintainer pushes to `main` carrying one or more changeset entries.',
  '2. `changesets/action` opens a `Version Packages` PR that consumes the',
  '   entries and bumps each affected package + dependents.',
  '3. Merging the PR triggers `changeset publish`, which:',
  '   - runs the gates one more time,',
  '   - publishes the bumped packages to npm under `@arki/*`,',
  '   - creates a GitHub Release per published package.',
  '',
  '## Canary releases',
  '',
  'For canary publishing, run `workflow_dispatch` on `release.yml` with',
  '`canary` set to `true`. The workflow runs:',
  '',
  '```bash',
  'bunx changeset version --snapshot canary',
  'bunx changeset publish --tag canary --no-git-tag',
  '```',
  '',
  'Canary tags never become "latest" on npm — install them explicitly via',
  '`bunx @arki/dot@canary` etc.',
  '',
].join('\n');

/**
 * The publish workflow. Triggers:
 *
 *  - `push` to `main`            — opens/refreshes the "Version Packages" PR
 *                                  when changesets are present; publishes on
 *                                  PR-merge that carries no changesets.
 *  - `workflow_dispatch`         — manual trigger; `canary: true` switches
 *                                  to snapshot publish on the `canary` tag.
 *
 * Required secrets:
 *  - `NPM_TOKEN`        — npm automation token with publish rights on `@arki/*`
 *  - `GITHUB_TOKEN`     — automatically provided by Actions
 */
const RELEASE_WORKFLOW = [
  'name: Release',
  '',
  'on:',
  '  push:',
  '    branches: [main]',
  '  workflow_dispatch:',
  '    inputs:',
  '      canary:',
  '        description: "Publish a canary snapshot release"',
  '        required: false',
  '        default: "false"',
  '',
  'concurrency:',
  '  group: release-${{ github.ref }}',
  '  cancel-in-progress: false',
  '',
  'permissions:',
  '  contents: write',
  '  pull-requests: write',
  '  id-token: write',
  '',
  'jobs:',
  '  release:',
  '    name: Release',
  '    runs-on: ubuntu-latest',
  '    timeout-minutes: 25',
  '    steps:',
  '      - name: Checkout',
  '        uses: actions/checkout@v4',
  '        with:',
  '          fetch-depth: 0',
  '',
  '      - name: Setup Bun',
  '        uses: oven-sh/setup-bun@v2',
  '        with:',
  '          bun-version: latest',
  '',
  '      - name: Setup Node 22',
  '        uses: actions/setup-node@v4',
  '        with:',
  '          node-version: "22"',
  '          registry-url: "https://registry.npmjs.org"',
  '',
  '      - name: Install dependencies',
  '        run: bun install --frozen-lockfile',
  '',
  '      - name: Build all packages',
  '        run: bun run -F "@arki/*" build',
  '',
  '      - name: Publish canary snapshot',
  '        if: github.event_name == \'workflow_dispatch\' && github.event.inputs.canary == \'true\'',
  '        env:',
  '          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
  '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
  '        run: |',
  '          bunx changeset version --snapshot canary',
  '          bunx changeset publish --tag canary --no-git-tag',
  '',
  '      - name: Create release PR or publish (stable)',
  '        if: github.event_name == \'push\' || (github.event_name == \'workflow_dispatch\' && github.event.inputs.canary != \'true\')',
  '        uses: changesets/action@v1',
  '        with:',
  '          publish: bunx changeset publish',
  '          version: bunx changeset version',
  '          title: "chore: version packages"',
  '          commit: "chore: version packages"',
  '        env:',
  '          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
  '          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}',
  '          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}',
  '',
].join('\n');

/**
 * Serialize a publishable manifest with stable field ordering, two-space
 * indent, and a trailing newline. Field ordering matches the type
 * declaration in {@link PublishableManifest} so consecutive runs produce
 * byte-identical output and human reviewers see semantic groupings.
 */
function serializePublishableManifest(manifest: PublishableManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  out['name'] = manifest.name;
  out['version'] = manifest.version;
  out['description'] = manifest.description;
  out['license'] = manifest.license;
  out['repository'] = manifest.repository;
  out['homepage'] = manifest.homepage;
  out['bugs'] = manifest.bugs;
  out['keywords'] = manifest.keywords;
  if (manifest.type !== undefined) out['type'] = manifest.type;
  if (manifest.sideEffects !== undefined) out['sideEffects'] = manifest.sideEffects;
  if (manifest.exports !== undefined) out['exports'] = manifest.exports;
  if (manifest.main !== undefined) out['main'] = manifest.main;
  if (manifest.module !== undefined) out['module'] = manifest.module;
  if (manifest.types !== undefined) out['types'] = manifest.types;
  if (manifest.files !== undefined) out['files'] = manifest.files;
  if (manifest.dependencies !== undefined) out['dependencies'] = manifest.dependencies;
  if (manifest.peerDependencies !== undefined) out['peerDependencies'] = manifest.peerDependencies;
  if (manifest.optionalDependencies !== undefined) {
    out['optionalDependencies'] = manifest.optionalDependencies;
  }
  if (manifest.peerDependenciesMeta !== undefined) {
    out['peerDependenciesMeta'] = manifest.peerDependenciesMeta;
  }
  if (manifest.bundleDependencies !== undefined) {
    out['bundleDependencies'] = manifest.bundleDependencies;
  }
  out['publishConfig'] = manifest.publishConfig;
  if (manifest.engines !== undefined) out['engines'] = manifest.engines;
  return out;
}

/**
 * Pretty-print JSON with a trailing newline. The trailing newline keeps
 * POSIX tools (and our prettier config) happy and makes git diffs cleaner.
 */
async function writeJsonFile(destPath: string, value: unknown): Promise<void> {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, serialized, 'utf8');
}

/**
 * Write a UTF-8 text file, creating parent directories as needed. Mirrors
 * {@link writeJsonFile}'s `mkdir -p` semantics so scaffolding files in
 * nested directories (`.changeset/`, `.github/workflows/`) don't fail on
 * missing parents.
 */
async function writeTextFile(destPath: string, contents: string): Promise<void> {
  await mkdir(path.dirname(destPath), { recursive: true });
  await writeFile(destPath, contents, 'utf8');
}

/**
 * Count unique destination files in a copy plan. We add a +1 implicit
 * count for the post-copy materialized `package.json` — but since the
 * plan already includes the source `package.json` (it's in the
 * `DEFAULT_FILE_INCLUDES` list), the count stays accurate.
 */
function countDistinctFiles(plan: readonly CopyPlanEntry[]): number {
  const seen = new Set<string>();
  for (const entry of plan) seen.add(entry.dest);
  return seen.size;
}
