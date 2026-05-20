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
 */
export type PackageWave = 'public-candidate' | 'blocked' | 'internal' | 'unclassified';

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
