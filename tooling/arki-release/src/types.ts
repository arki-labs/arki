/**
 * Shared types for the `@arki/arki-release` tooling.
 *
 * These types define the contract between CLI subcommands, the shared JSON
 * envelope, and the implementation modules introduced in later tasks.
 */

/**
 * The complete set of CLI subcommands supported by `arki-release`.
 *
 * Each subcommand has a dedicated implementation task in the release plan:
 *   - inventory     (Task 2): discover + classify packages
 *   - audit         (Task 4): leak-scan + npm pack audit
 *   - export-public (Task 5): materialize `.release/arki-public/` tree
 *   - pack          (Task 3): resolve workspace:* / catalog: → concrete versions
 *   - fixture       (Task 6): drive external install fixtures
 *   - scorecard     (Task 7): emit release scorecard (publication gate)
 *   - history       (post-Task-12): reconcile npm / GitHub tags / source / CHANGELOG
 */
export type ReleaseCommand = 'inventory' | 'audit' | 'export-public' | 'pack' | 'fixture' | 'scorecard' | 'history';

/**
 * Lifecycle status of a release command run.
 *
 * - `success` — the command completed and all checks passed
 * - `warning` — the command completed but flagged non-blocking issues
 * - `failure` — the command completed but blocking issues were detected
 * - `pending` — the command is not yet implemented (stub state for Tasks 2-7)
 */
export type ReleaseStatus = 'success' | 'failure' | 'pending' | 'warning';

/**
 * Severity of a structured error emitted by a release command.
 */
export type ReleaseErrorSeverity = 'info' | 'warning' | 'error';

/**
 * A structured, machine-readable error/warning entry in the JSON envelope.
 *
 * Errors carry stable codes (e.g. `RELEASE_E001`) so coding agents and CI
 * gates can match against specific failure modes without scraping prose.
 */
export interface ReleaseError {
  /** Stable error code, e.g. `RELEASE_E001`. */
  code: string;
  /** Severity of the issue. */
  severity: ReleaseErrorSeverity;
  /** Human-readable message describing the problem. */
  message: string;
  /** Optional remediation guidance for the operator. */
  remediation?: string;
  /** Optional target (package name, file path, etc.) the issue refers to. */
  target?: string;
}

/**
 * The shared JSON envelope every release command emits when `--json` is set.
 *
 * Generics keep the per-command `summary` and `items` shapes precise without
 * losing the common envelope contract.
 */
export interface ReleaseCommandEnvelope<TItem = unknown, TSummary = unknown> {
  /** Overall lifecycle status. */
  status: ReleaseStatus;
  /** The subcommand that produced this envelope, e.g. `'inventory'`. */
  command: ReleaseCommand | 'help';
  /** ISO-8601 timestamp when the envelope was generated. */
  generatedAt: string;
  /** Command-specific summary (counts, totals, headline metrics). */
  summary: TSummary;
  /** Command-specific item list (packages, files, fixtures, etc.). */
  items: TItem[];
  /** Structured error list (empty when `status === 'success'`). */
  errors: ReleaseError[];
}

/**
 * Classification of a workspace package for the release pipeline.
 *
 * Filled in by the inventory command (Task 2). Defined here so later
 * commands (audit, export-public, scorecard) can consume the type.
 *
 * - `public-candidate` — wave-allowlisted, `private: false`, no private deps
 * - `private-only` — `private: true` AND not allowlisted in any wave (the
 *   intended internal-forever case)
 * - `unassigned` — `private: false` but not allowlisted in any wave; an
 *   ambiguous state that emits a warning (INV_E004) so a maintainer can
 *   either add it to a wave or flip `private: true`
 * - `blocked-by-private-flag` — wave-allowlisted but still `private: true`
 * - `blocked-by-private-dependency` — wave-allowlisted but transitively
 *   depends on a `private: true` ARKI workspace package
 * - `blocked-by-leak` — reserved for Task 4 (leak scanner)
 * - `blocked-by-build-shape` — reserved for Task 5 (build-shape audit)
 *
 * Task 2 emits the first five states; the leak/build-shape labels exist
 * here so later commands can extend without breaking the type seam.
 */
export type PackageClassification =
  | 'public-candidate'
  | 'private-only'
  | 'unassigned'
  | 'blocked-by-private-flag'
  | 'blocked-by-private-dependency'
  | 'blocked-by-leak'
  | 'blocked-by-build-shape';

/**
 * A single blocker entry attached to an {@link InventoryItem}. Shared
 * shape used both inside the inventory command and on the item type.
 */
export interface InventoryBlocker {
  readonly code: string;
  readonly reason: string;
  readonly target?: string;
}

/**
 * Coarse-grained legacy label retained for backwards compatibility with
 * downstream code from Task 1. Prefer {@link PackageClassification}.
 *
 * @deprecated Use {@link PackageClassification}.
 */
export type PackageWave = 'public-candidate' | 'blocked' | 'internal' | 'unclassified';

/**
 * Stable identifiers for each release wave. Matches the design spec
 * (Wave 1 = foundation, Wave 2 = dot-kernel, etc.).
 */
export type ReleaseWaveId =
  | 'foundation'
  | 'dot-kernel'
  | 'infrastructure-adapters'
  | 'frontend'
  | 'specialized';

/**
 * A single release wave — a labelled allowlist of `@arki/*` package names
 * that the release pipeline is expected to publish together.
 */
export interface ReleaseWave {
  /** Stable identifier, e.g. `'foundation'`. */
  readonly id: ReleaseWaveId;
  /** Human-readable label, e.g. `'Wave 1 — Foundation'`. */
  readonly label: string;
  /** Ordered list of `@arki/*` package names belonging to this wave. */
  readonly packages: readonly string[];
}

/**
 * The repository / bugs / homepage / license metadata that every public
 * `@arki/*` package gets stamped with at publish time. Used by
 * `export-public` (Task 5) to rewrite the public-tree manifests.
 *
 * Intentionally narrow — Task 2 only reads these; later tasks consume.
 */
export interface PublicMetadataDefaults {
  readonly license: string;
  readonly repository: { readonly type: string; readonly url: string };
  readonly bugs: { readonly url: string };
  readonly homepage: string;
  readonly publishConfig: { readonly access: 'public' | 'restricted' };
  readonly keywords: readonly string[];
}

/**
 * Severity of a {@link LeakPattern} match.
 *
 * - `error` — a confirmed leak that MUST block publication (e.g.
 *   `furculita.net`, private app name).
 * - `warning` — an ambiguous match that needs human triage (e.g. `sudoku`
 *   may legitimately appear in a games package).
 */
export type LeakSeverity = 'error' | 'warning';

/**
 * A single leak-detection pattern. Patterns are evaluated against every
 * scanned text line; matches produce {@link LeakHit} entries. The
 * `allowList` is per-pattern belt-and-braces — a top-level neutral allow
 * list runs first, so most patterns won't need their own entries.
 */
export interface LeakPattern {
  /** Stable identifier, e.g. `'personal-domain-furculita'`. */
  readonly id: string;
  /** Human-readable description, shown in envelope errors. */
  readonly description: string;
  /** The regex used to detect the leak. Case-insensitive by convention. */
  readonly pattern: RegExp;
  /** Match severity — `error` blocks publication, `warning` does not. */
  readonly severity: LeakSeverity;
  /**
   * Optional per-pattern allow list. A pattern match whose `matchedText`
   * matches any of these regexes is dropped. Mostly unused — defaults
   * include a hard-coded neutral allow list (`example.com`, `acme`, …).
   */
  readonly allowList?: readonly RegExp[];
}

/**
 * A single leak detection — produced by the scanner when a pattern
 * matches in a scanned file.
 */
export interface LeakHit {
  /** The {@link LeakPattern} that fired. */
  readonly patternId: string;
  /** Mirrored from the pattern for downstream filtering convenience. */
  readonly severity: LeakSeverity;
  /** Pattern description (human-readable). */
  readonly description: string;
  /** File the hit was found in (relative when possible). */
  readonly sourcePath: string;
  /** 1-indexed line number of the match. */
  readonly line: number;
  /** 1-indexed column number of the start of the match. */
  readonly column: number;
  /** The exact matched substring. */
  readonly matchedText: string;
  /** ~80 chars of trimmed surrounding context (one line). */
  readonly snippet: string;
}

/**
 * A single npm-pack audit rule. Rules are evaluated against the JSON
 * output of `npm pack --dry-run --json` — one entry per package.
 */
export interface PackAuditRule {
  /** Stable identifier, e.g. `'no-tests'`. */
  readonly id: string;
  /** Human-readable description, shown in envelope errors. */
  readonly description: string;
  /** Match severity. `error` blocks publication; `warning` does not. */
  readonly severity: LeakSeverity;
  /**
   * Pure check. Returns `null` when the rule passes; a human-readable
   * reason string when it fails. The implementation must not perform I/O.
   */
  readonly check: (entry: NpmPackEntry, context: PackAuditContext) => string | null;
}

/**
 * A single file entry from `npm pack --dry-run --json` output.
 *
 * `mode` is the unix file mode as an integer; npm emits it for every
 * file. We don't validate it but expose it so future rules can.
 */
export interface NpmPackFileEntry {
  readonly path: string;
  readonly size: number;
  readonly mode: number;
}

/**
 * A single entry in the `npm pack --dry-run --json` output array.
 *
 * Fields not consumed by our audit (e.g. `shasum`, `integrity`) are kept
 * optional so we don't reject future npm versions that omit them.
 */
export interface NpmPackEntry {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly files: readonly NpmPackFileEntry[];
  readonly entryCount: number;
  readonly bundled: readonly string[];
  readonly size: number;
  readonly unpackedSize: number;
  readonly shasum?: string;
  readonly integrity?: string;
}

/**
 * Context passed to every {@link PackAuditRule}. Carries the manifest +
 * a flag saying whether the package is allowed to ship raw `.ts`.
 *
 * `isSourceDistributed` defaults to `false` initially — Task 8 may opt
 * specific packages into `true` once their build shape supports it.
 */
export interface PackAuditContext {
  readonly packageDir: string;
  readonly manifest: { readonly name: string; readonly version: string };
  readonly isSourceDistributed: boolean;
}

/**
 * Result of auditing a single package's pack output.
 *
 * - `pass`   — no rule hits, ready to publish.
 * - `warn`   — only warning-severity hits, can publish with caveats.
 * - `fail`   — at least one error-severity hit, publication is blocked.
 */
export interface PackAuditResult {
  readonly package: { readonly name: string; readonly version: string };
  readonly status: 'pass' | 'fail' | 'warn';
  readonly ruleHits: ReadonlyArray<{
    readonly ruleId: string;
    readonly severity: LeakSeverity;
    readonly description: string;
    readonly reason: string;
  }>;
  readonly totals: {
    readonly fileCount: number;
    readonly unpackedSize: number;
    readonly packedSize: number;
  };
}

/**
 * Top-level shape of `arki.release.config.ts`.
 *
 * Reserved fields (e.g. leak patterns for Task 4) are added as optional
 * properties so the config file can grow without breaking Task 2's
 * loader.
 */
export interface ReleaseConfig {
  /** Path (relative to the repo root) where the public tree is materialized. */
  readonly publicTreePath: string;
  /** Default metadata stamped onto every published manifest. */
  readonly publicMetadataDefaults: PublicMetadataDefaults;
  /** Ordered wave list — Wave 1 first, last wave last. */
  readonly waves: readonly ReleaseWave[];
  /**
   * Optional override of the default leak-pattern list. When omitted the
   * scanner uses {@link DEFAULT_LEAK_PATTERNS}. Useful for tests and for
   * one-off audits that need to add or relax patterns.
   */
  readonly leakPatterns?: readonly LeakPattern[];
}

/**
 * Parsed CLI arguments — produced by the cli.ts argv parser and consumed
 * by subcommand handlers.
 */
export interface ParsedCliArgs {
  /** The subcommand requested, or `null` for help/no-args. */
  command: ReleaseCommand | null;
  /** Whether `--json` was passed (envelope is the source of truth). */
  json: boolean;
  /** Whether `--help` or no subcommand was requested. */
  help: boolean;
  /** Remaining positional/option arguments for future subcommand options. */
  rest: string[];
}

/**
 * Bun catalog tables extracted from the root `package.json`.
 *
 * - `default`: the `"catalog"` object — referenced from manifests as
 *   `"catalog:"`.
 * - `named`: the `"catalogs"` object — referenced as `"catalog:<name>"`,
 *   keyed by catalog name then by package name.
 *
 * Frozen at load time. The downstream materializer treats both maps as
 * read-only — never mutate.
 */
export interface CatalogTables {
  readonly default: Readonly<Record<string, string>>;
  readonly named: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/**
 * Inputs to the manifest materializer.
 *
 * Pure — no I/O at all. Tests build this in-memory; the production caller
 * (Task 5's export-public command) constructs it from `loadCatalogs(root)`
 * + the inventory item map.
 */
export interface MaterializationContext {
  /** Catalog tables resolved from the root `package.json`. */
  readonly catalogs: CatalogTables;
  /** Public ARKI workspace versions, keyed by `@arki/*` package name. */
  readonly workspaceVersions: ReadonlyMap<string, string>;
  /** ARKI workspace packages marked `"private": true`. */
  readonly privateArkiPackages: ReadonlySet<string>;
  /** Repository/license/homepage/bugs/keywords defaults from the release config. */
  readonly metadataDefaults: PublicMetadataDefaults;
}

/**
 * A publishable `package.json` shape — what would be written to disk by
 * Task 5 once Task 3 has resolved every workspace/catalog reference.
 *
 * Field order in the output JSON is preserved by the materializer so diffs
 * against the source manifest are reviewable.
 */
export interface PublishableManifest {
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly license: string;
  readonly repository: { readonly type: string; readonly url: string };
  readonly homepage: string;
  readonly bugs: { readonly url: string };
  readonly keywords: readonly string[];
  readonly type?: 'module' | 'commonjs';
  readonly sideEffects?: boolean | readonly string[];
  readonly exports?: Readonly<Record<string, unknown>>;
  readonly main?: string;
  readonly module?: string;
  readonly types?: string;
  readonly files?: readonly string[];
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  readonly optionalDependencies?: Readonly<Record<string, string>>;
  readonly peerDependenciesMeta?: Readonly<Record<string, { readonly optional?: boolean }>>;
  readonly bundleDependencies?: readonly string[];
  readonly publishConfig: Readonly<Record<string, unknown>>;
  readonly engines?: Readonly<Record<string, string>>;
}

/**
 * Result returned by the manifest materializer.
 *
 * The function is pure — errors are returned, not thrown. The caller
 * decides on exit code / abort behaviour. Fatal errors (severity
 * `'error'`) signal that the manifest must not be published as-is.
 */
export interface MaterializationResult {
  readonly manifest: PublishableManifest;
  readonly errors: readonly ReleaseError[];
}

/**
 * Options accepted by the public-tree exporter.
 *
 * `outputPath` defaults to `config.publicTreePath` resolved against
 * `rootCwd`. The exporter enforces a path-safety guard: the resolved
 * output path MUST live inside `rootCwd` — paths that escape (`..`,
 * absolute paths outside the repo) are rejected with a structured error
 * so we never wipe an arbitrary directory.
 *
 * `leakScan` is on by default. Disable only for diagnosis — the exporter
 * records a loud warning in the envelope when it's bypassed.
 *
 * `includeBlockedByLeak` opts packages classified `blocked-by-leak`
 * (Task 4) into the export attempt. The pre-output leak gate (when
 * enabled) will still refuse them — the flag exists for operators who
 * want a `--no-leak-scan` diagnostic dump of what would ship once the
 * leaks are gone.
 */
export interface ExportOptions {
  readonly rootCwd: string;
  readonly outputPath?: string;
  readonly config: ReleaseConfig;
  readonly leakScan?: boolean;
  readonly includeBlockedByLeak?: boolean;
  /**
   * When `true`, omit the `workspaces: ['packages/*']` field from the
   * materialized root `package.json`. Default `false` (write workspaces
   * field — needed for the `arki-labs/arki` clone-and-`bun install`
   * use case).
   *
   * Enable when the materialized tree will be used for `npm publish`:
   * npm parent-walks from any `packages/<pkg>/` child directory, finds
   * the workspaces root, and switches to workspace mode — which mangles
   * standalone publishes with `'@arki/<pkg>@*' is not in this registry`.
   * Omitting the field makes the publish path always-clean.
   */
  readonly skipWorkspacesRoot?: boolean;
}

/**
 * Lifecycle status for a single export attempt.
 */
export type ExportItemStatus = 'exported' | 'skipped' | 'failed';

/**
 * A single package's export outcome.
 *
 * `errors` carries any `ReleaseError` records produced by the
 * materializer or the pre-output leak gate — even on `exported` we may
 * record warnings (e.g. missing-description) the caller wants to surface.
 */
export interface ExportItem {
  readonly name: string;
  readonly version: string;
  readonly sourcePath: string;
  readonly destPath: string;
  readonly fileCount: number;
  readonly status: ExportItemStatus;
  readonly reason?: string;
  readonly errors: readonly ReleaseError[];
}

/**
 * Aggregate summary for the export envelope.
 */
export interface ExportSummary {
  readonly message: string;
  readonly totalCandidates: number;
  readonly exported: number;
  readonly skipped: number;
  readonly failed: number;
  readonly outputPath: string;
}

/**
 * Identifier for one of the package managers the fixture matrix supports.
 *
 * Each `(package, packageManager)` pair produces a single
 * {@link FixtureRun} so the matrix can document both per-PM compatibility
 * and per-package regressions.
 */
export type PackageManagerId = 'npm' | 'pnpm' | 'bun';

/**
 * Status of a single stage within a {@link FixtureRun}.
 *
 * - `success`  — stage executed and met its assertions.
 * - `failure`  — stage executed but produced a publication-blocking issue.
 * - `skipped`  — stage was intentionally not run, e.g. because an upstream
 *   stage failed, the operator passed `--skip-install`, or the run is
 *   forward-dependent on a future task (e.g. the DOT fixture).
 */
export type FixtureStageStatus = 'success' | 'failure' | 'skipped';

/**
 * Top-level status of a single fixture run (one package × one PM).
 *
 * - `success` — every executed stage succeeded.
 * - `failure` — at least one stage failed.
 * - `skipped` — the whole run was skipped (e.g. forward-dependency stub).
 */
export type FixtureRunStatus = 'success' | 'failure' | 'skipped';

/**
 * Stages exercised inside a single fixture run, in execution order.
 *
 * - `pack`                 — pack the package into a tarball with npm.
 * - `workspace-leak-check` — verify the tarball/manifest carries no
 *   unresolved `workspace:*` or `catalog:` references.
 * - `install`              — install the tarball into the fixture dir
 *   with the requested package manager (npm / pnpm / bun).
 * - `import-esm`           — run `node import-check.mjs` to verify the
 *   published ESM entry resolves and exposes named exports.
 * - `import-types`         — run `tsc --noEmit tsc-check.ts` to verify
 *   the package's `.d.ts` declarations are consumable.
 */
export type FixtureStageName =
  | 'pack'
  | 'workspace-leak-check'
  | 'install'
  | 'import-esm'
  | 'import-types';

/**
 * One stage of a single fixture run. Stages record their lifecycle status,
 * the time they took, and optionally truncated stdout/stderr so failures
 * are diagnosable without re-running.
 *
 * `reason` is a short, human-readable label — used for both `skipped` and
 * `failure` so the envelope can display a one-liner.
 */
export interface FixtureStage {
  readonly name: FixtureStageName;
  readonly status: FixtureStageStatus;
  readonly durationMs: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly reason?: string;
}

/**
 * A single (package, packageManager) outcome from the fixture matrix.
 *
 * `tarballPath` and `fixtureDir` are non-empty even when stages are
 * skipped — they document what would have been used.
 *
 * `errors` mirrors the envelope `errors[]` shape: stable `FIX_E0xx` codes
 * with severities so CI gates can match on specific failures.
 */
export interface FixtureRun {
  readonly packageName: string;
  readonly packageManager: PackageManagerId;
  readonly tarballPath: string;
  readonly fixtureDir: string;
  readonly status: FixtureRunStatus;
  readonly stages: readonly FixtureStage[];
  readonly errors: readonly ReleaseError[];
  readonly skipReason?: string;
}

/**
 * Aggregate summary for the fixture envelope.
 */
export interface FixtureMatrixSummary {
  readonly message: string;
  readonly totalRuns: number;
  readonly successCount: number;
  readonly failureCount: number;
  readonly skippedCount: number;
  readonly publicTreePath: string;
}

/**
 * Full result of running the fixture matrix. The envelope's `items[]`
 * carries the per-run details; `summary` carries the totals.
 */
export interface FixtureMatrix {
  readonly runs: readonly FixtureRun[];
  readonly summary: FixtureMatrixSummary;
}

/**
 * One of the eight scorecard dimensions. Each dimension is evaluated
 * independently and reported with its own `pass | warn | fail | deferred`
 * status so operators can see exactly WHY a package is blocked.
 *
 * The dimension list mirrors the public-release spec:
 *
 *   - `metadata`           — license, description, repository, homepage,
 *                            bugs, keywords (from the materialized manifest).
 *   - `privacy`            — leak scanner did not flag this package.
 *   - `dependencies`       — materializer did not flag unresolved
 *                            catalog refs / private ARKI deps.
 *   - `build-output`       — `dist/` contains compiled JS AND .d.ts
 *                            (or, for source-distributed packages, the
 *                            equivalent .ts + .d.ts pair). Future Task 8
 *                            opts each package into the right build shape.
 *   - `packlist`           — `npm pack --dry-run` audit passes (no tests,
 *                            no env files, no node_modules, etc.).
 *   - `docs`               — README.md and LICENSE present in the source
 *                            dir.
 *   - `fixtures`           — fixture matrix's pack stage succeeded for
 *                            this package on at least one PM (full install
 *                            matrix in CI mode).
 *   - `dot-gates`          — DOT-specific runtime gates: `dot doctor
 *                            --json`, `dot explain --json`, and DOT-boots-
 *                            with-three-adapters. DEFERRED until Tasks
 *                            9 / 10 land.
 *   - `agent-native-gates` — Agent-native CLI gates: every command emits
 *                            envelope JSON when `--json` is passed; `dot
 *                            new --dry-run --json` scaffolds a fresh app.
 *                            DEFERRED until Tasks 9 / 11.5 land.
 */
export type ScorecardDimension =
  | 'metadata'
  | 'privacy'
  | 'dependencies'
  | 'build-output'
  | 'packlist'
  | 'docs'
  | 'fixtures'
  | 'dot-gates'
  | 'agent-native-gates';

/**
 * Stable severity ordering for the overall-status derivation.
 * `fail` is worst (gate-blocking), `pass` is best.
 */
export type ScorecardStatus = 'pass' | 'fail' | 'warn' | 'deferred';

/**
 * Result of the one-shot DOT probe that runs alongside the scorecard. The
 * probe boots a synthetic 3-adapter DOT app (env + kv + db), reads the
 * static `DotAppManifest` + runtime `DotDiagnosticsSnapshot`, and exercises
 * the CLI's pure envelope builders (`buildExplainEnvelope`,
 * `buildDoctorEnvelope`) plus `runNew --dry-run --json`. The structured
 * output drives both the `dot-gates` and `agent-native-gates` dimensions.
 *
 * Counts are kept as numbers (not booleans) so the gate evaluator can
 * surface "manifest has 4 of 5 arrays" instead of a binary pass/fail.
 *
 * Tests inject a synthetic `DotProbeResult` to drive deterministic gate
 * outcomes without spawning the real probe.
 */
export type DotProbeResult = DotProbeOk | DotProbeFail;

export interface DotProbeOk {
  readonly status: 'pass';
  /** Number of pips booted in the probe app. Gate requires >= 3. */
  readonly pipCount: number;
  /** Count of the five contract arrays present on the manifest. Gate requires 5. */
  readonly manifestArrays: number;
  /** Count of the five contract arrays present on diagnostics. Gate requires 5. */
  readonly diagnosticsArrays: number;
  /** True iff `buildExplainEnvelope` emits `{ status, command: 'explain', generatedAt, data: <manifest>, errors }`. */
  readonly explainEnvelopeOk: boolean;
  /** True iff `buildDoctorEnvelope` emits `{ status, command: 'doctor', generatedAt, data: <snapshot>, errors }`. */
  readonly doctorEnvelopeOk: boolean;
  /** True iff `runNew(--dry-run --json)` emits a success envelope with operations. */
  readonly newEnvelopeOk: boolean;
  /** Number of file operations the dry-run reported. */
  readonly newOperationCount: number;
  /**
   * Required scaffold files actually present in the dry-run plan. The
   * canonical required set is documented in {@link DOT_PROBE_REQUIRED_FILES}.
   */
  readonly newRequiredFilesPresent: readonly string[];
  /** Lifecycle state of the probe app after boot (should be 'booted'). */
  readonly appState: string;
}

export interface DotProbeFail {
  readonly status: 'fail';
  readonly reason: string;
  /** Optional captured stderr from the probe subprocess. */
  readonly stderr?: string;
}

/**
 * One dimension's outcome for one package. `details` is the one-line
 * human-readable reason; `evidence` carries the structured errors that
 * drove the verdict (e.g. RELEASE_E006 for missing description).
 */
export interface ScorecardDimensionResult {
  readonly status: ScorecardStatus;
  readonly details: string;
  readonly evidence: readonly ReleaseError[];
}

/**
 * A single package's scorecard. `overall` is the worst status across the
 * dimensions; `blockers` is the human-readable list of failing dimensions
 * (one entry per `fail` / `deferred` / `warn` dimension that contributed
 * to the worst-of overall).
 */
export interface ScorecardPackageResult {
  readonly name: string;
  readonly version: string;
  readonly classification: PackageClassification;
  readonly wave: ReleaseWaveId | null;
  readonly dimensions: Readonly<Record<ScorecardDimension, ScorecardDimensionResult>>;
  readonly overall: ScorecardStatus;
  readonly blockers: readonly string[];
}

/**
 * Aggregate scorecard summary for the envelope.
 *
 * `stableReleaseGate` is `'open'` only when every public-candidate
 * package has `overall: 'pass'` (i.e. no `fail`, no `warn`, no
 * `deferred`) OR the operator passed `--allow-deferred` and the only
 * non-pass dimensions are the deferred DOT/agent-native gates.
 */
export interface ScorecardSummary {
  readonly message: string;
  readonly totalPackages: number;
  readonly pass: number;
  readonly fail: number;
  readonly warn: number;
  readonly deferred: number;
  readonly stableReleaseGate: 'open' | 'blocked';
  readonly stableReleaseBlockers: readonly string[];
  readonly allowDeferred: boolean;
}
