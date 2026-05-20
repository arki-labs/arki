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
 */
export type ReleaseCommand = 'inventory' | 'audit' | 'export-public' | 'pack' | 'fixture' | 'scorecard';

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
