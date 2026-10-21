/**
 * The failures the `dot` commands return. Each code is stable: agents branch
 * on `.error.code`. A returned failure exits 3; the framework's own
 * (`cli.unknown_command`, `cli.invalid_input`) exit 2.
 *
 * Data schemas are Standard Schemas built from type guards, so the public
 * types name no validator library (the `@arki/cli` pattern).
 */
import type { Failure } from '@arki/failure';
import type { StandardSchemaV1 } from '@arki/schema';
import { is, recordSchema } from '@arki/schema';
import { defineFailure } from '@arki/failure';

import type { DotDiagnosticsSnapshot } from '../diagnostics.js';
import type { DotNewOperation } from './json.js';
import { DotLifecycleError } from '../lifecycle.js';
import { preflightMessageSchema } from './preflight-message.js';

/** Base URL of the CLI error docs: an envelope's `error.docsUrl` is `<base>#<code with . and _ as ->`. */
export const DOT_CLI_DOCS_URL = 'https://docs.arki.dev/dot/cli';

/** `doctor`'s verdict: the worst severity among all the snapshot's issues. */
export type DoctorStatus = 'success' | 'warning' | 'failure';

/** What `dot doctor` returns: the diagnostics snapshot and its verdict. */
export type DoctorReport = DotDiagnosticsSnapshot & { readonly status: DoctorStatus };

/** The docs link of a code, the way `@arki/cli` builds `error.docsUrl`. */
export function dotCliDocsUrl(code: string): string {
  return `${DOT_CLI_DOCS_URL}#${code.replaceAll(/[._]/g, '-')}`;
}

type Fields = Readonly<Record<string, unknown>>;

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(entry => typeof entry === 'string');
}

/** True when each named field is a string (or null, for the keys in `nullable`). */
function strings(value: Fields, keys: readonly string[], nullable: readonly string[] = []): boolean {
  return (
    keys.every(key => typeof value[key] === 'string') &&
    nullable.every(key => value[key] === null || typeof value[key] === 'string')
  );
}

/** A Standard Schema from a type guard: typed failure data without a validator dependency. */
function guarded<T>(code: string, guard: (value: unknown) => value is T): StandardSchemaV1<T> {
  return {
    '~standard': {
      version: 1,
      vendor: '@arki/dot',
      validate: value => (guard(value) ? { value } : { issues: [{ message: `not ${code} data` }] }),
    },
  };
}

export type AppNotFoundData = { readonly cwd: string; readonly searched: readonly string[] };

/**
 * No app file at the default paths and no `--app`.
 * @fix Create `dot.config.ts` that exports the app, or pass `--app <path>`.
 * @verify dot explain --json | jq -e .ok
 */
export const AppNotFound = defineFailure('dot.app_not_found', {
  data: guarded(
    'dot.app_not_found',
    (value): value is AppNotFoundData => is(value, recordSchema) && strings(value, ['cwd']) && isStringArray(value['searched']),
  ),
  message: 'No DOT app file found in {cwd}',
  remediation:
    'Create `dot.config.ts` exporting your app (`export default defineApp("my-app").infra(unit)`), or pass `--app <path>`.',
});

export type AppInvalidExportData = {
  readonly filePath: string;
  /** The export that was picked and is not an app; null when none was picked. */
  readonly exportName: string | null;
  readonly exports: readonly string[];
  /** The exports that look like DOT apps, when there are several. */
  readonly matches: readonly string[];
};

/**
 * The app file loaded, but no export is a DOT app, or several are and none is `default` or `app`.
 * @fix Export the app as `default` or as `app`.
 * @verify dot explain --json | jq -e .ok
 */
export const AppInvalidExport = defineFailure('dot.app_invalid_export', {
  data: guarded(
    'dot.app_invalid_export',
    (value): value is AppInvalidExportData =>
      is(value, recordSchema) &&
      strings(value, ['filePath'], ['exportName']) &&
      isStringArray(value['exports']) &&
      isStringArray(value['matches']),
  ),
  message: data => {
    const listed = (names: readonly string[]): string => (names.length === 0 ? 'none' : names.join(', '));
    if (data.exportName !== null) {
      return `The \`${data.exportName}\` export from ${data.filePath} is not a DotApp or DotAppBuilder.`;
    }
    return data.matches.length > 1
      ? `${data.filePath} exports several DOT apps (${listed(data.matches)}) and none is \`default\` or \`app\`.`
      : `${data.filePath} exports no DOT app. Exports found: ${listed(data.exports)}.`;
  },
  remediation: 'Export the app as `default` or as `app`: `export const app = defineApp("my-app").infra(unit);`',
});

export type AppImportFailedData = {
  readonly filePath: string;
  /** The factory export that threw; null when the import itself threw. */
  readonly exportName: string | null;
  readonly causeMessage: string;
  /** The code of the thrown error, when it carries one (a declaration rejecting a mistake). */
  readonly causeCode: string | null;
  /** The thrown error's own fix, when it carries one. */
  readonly causeRemediation: string | null;
};

/**
 * Importing the app file threw, or its exported factory did.
 * @fix Apply `.error.data.causeRemediation` when it is set; otherwise run `bun <app file>` to reproduce.
 * @verify dot explain --json | jq -e .ok
 */
export const AppImportFailed = defineFailure('dot.app_import_failed', {
  data: guarded(
    'dot.app_import_failed',
    (value): value is AppImportFailedData =>
      is(value, recordSchema) && strings(value, ['filePath', 'causeMessage'], ['exportName', 'causeCode', 'causeRemediation']),
  ),
  message: data =>
    data.exportName === null
      ? `Failed to import app file at ${data.filePath}: ${data.causeMessage}`
      : `The \`${data.exportName}\` export function in ${data.filePath} threw: ${data.causeMessage}`,
  remediation:
    'Apply `.error.data.causeRemediation` when it is set; otherwise run the file directly (`bun <path>`) to reproduce.',
});

export type AppLifecycleFailedData = {
  readonly phase: 'configure' | 'boot';
  readonly underlyingCode: string;
  readonly causeMessage: string;
};

/**
 * `configure` threw while the CLI prepared the app.
 * @fix Read `.error.data.underlyingCode` and look it up in the kernel error table; `ARKI_DOT_E020` means a provider is mounted after its consumer.
 * @verify dot explain --json | jq -e .ok
 */
export const AppLifecycleFailed = defineFailure('dot.app_lifecycle_failed', {
  data: guarded(
    'dot.app_lifecycle_failed',
    (value): value is AppLifecycleFailedData =>
      is(value, recordSchema) &&
      (value['phase'] === 'configure' || value['phase'] === 'boot') &&
      strings(value, ['underlyingCode', 'causeMessage']),
  ),
  message: 'App {phase} failed: {causeMessage}',
  remediation:
    'Read `error.data.underlyingCode` and apply the remediation of that code (`ARKI_DOT_E020` means a provider is mounted after its consumer); `dot doctor` shows per-unit diagnostics.',
});

/**
 * `doctor --observability` found no OpenTelemetry SDK. Reported as a warning issue in the snapshot, not returned.
 * @fix Register an OpenTelemetry SDK once at app entry, before any app boots.
 * @verify dot doctor --observability --json | jq '.data.issues'
 */
export const ObservabilityNoSdk = defineFailure('dot.observability_no_sdk', {
  message: 'No OpenTelemetry SDK is registered. Lifecycle traces and metrics will not be exported.',
  remediation:
    'Register an OTel SDK (e.g. @opentelemetry/sdk-node with AsyncLocalStorageContextManager) once at app entry, before any DotApp boots.',
});

export type ProjectionNotFoundData = { readonly format: string; readonly registeredFormats: readonly string[] };

/**
 * No unit registers the `--as` format.
 * @fix Use a format from `.error.data.registeredFormats`, or mount the adapter that provides it.
 * @verify dot explain --as <format> --json | jq -e .ok
 */
export const ProjectionNotFound = defineFailure('dot.projection_not_found', {
  data: guarded(
    'dot.projection_not_found',
    (value): value is ProjectionNotFoundData =>
      is(value, recordSchema) && strings(value, ['format']) && isStringArray(value['registeredFormats']),
  ),
  message: 'No projection is registered for format "{format}"',
  remediation:
    'Use a format from `.error.data.registeredFormats`, or mount the adapter that provides it; otherwise remove --as.',
});

export type ProjectionImportFailedData = {
  readonly specifier: string;
  readonly registeringPlugin: string;
  /** Where it failed: resolving the specifier, importing the module, or finding `project`. */
  readonly stage: 'resolve' | 'import' | 'export';
  readonly causeMessage: string | null;
};

/**
 * The projection module could not be resolved or imported, or exports no `project(manifest)`.
 * @fix Install the module and export a named `project(manifest)` function from it.
 * @verify dot explain --as <format> --json | jq -e .ok
 */
export const ProjectionImportFailed = defineFailure('dot.projection_import_failed', {
  data: guarded(
    'dot.projection_import_failed',
    (value): value is ProjectionImportFailedData =>
      is(value, recordSchema) &&
      strings(value, ['specifier', 'registeringPlugin'], ['causeMessage']) &&
      (value['stage'] === 'resolve' || value['stage'] === 'import' || value['stage'] === 'export'),
  ),
  message: data => {
    if (data.stage === 'resolve') return `Failed to resolve projection module "${data.specifier}".`;
    if (data.stage === 'import') return `Failed to import projection module "${data.specifier}".`;
    return `Projection module "${data.specifier}" does not export project(manifest).`;
  },
  remediation:
    'Install the module and export a named `project(manifest)` function from it; `--module <specifier>` tries a replacement.',
});

export type ProjectionExecutionFailedData = {
  readonly format: string;
  readonly specifier: string;
  readonly registeringPlugin: string;
  readonly causeMessage: string;
};

/**
 * `project(manifest)` threw or returned output that does not survive a JSON round trip.
 * @fix Make `project(manifest)` pure and return JSON-round-trip-safe output.
 * @verify dot explain --as <format> --json | jq -e .ok
 */
export const ProjectionExecutionFailed = defineFailure('dot.projection_execution_failed', {
  data: guarded(
    'dot.projection_execution_failed',
    (value): value is ProjectionExecutionFailedData =>
      is(value, recordSchema) && strings(value, ['format', 'specifier', 'registeringPlugin', 'causeMessage']),
  ),
  message: 'Projection "{format}" failed while rendering: {causeMessage}',
  remediation: 'Make `project(manifest)` pure and return JSON-round-trip-safe output.',
});

export type ProjectionConflictData = {
  readonly format: string;
  readonly projections: readonly { readonly plugin: string; readonly module: string }[];
};

/**
 * Two units register different modules for one projection format.
 * @fix Remove one registration, or make both units register the same module.
 * @verify dot explain --as <format> --json | jq -e .ok
 */
export const ProjectionConflict = defineFailure('dot.projection_conflict', {
  data: guarded(
    'dot.projection_conflict',
    (value): value is ProjectionConflictData =>
      is(value, recordSchema) &&
      strings(value, ['format']) &&
      Array.isArray(value['projections']) &&
      value['projections'].every(entry => is(entry, recordSchema) && strings(entry, ['plugin', 'module'])),
  ),
  message: 'Multiple projection modules are registered for format "{format}"',
  remediation: 'Remove one registration, or make both units register the same module specifier.',
});

/**
 * `doctor` found error-severity issues. The data is the whole report: `.error.data.plugins[]`.
 * @fix Apply the `remediation` of each issue in `.error.data.plugins[].issues` and `.error.data.issues`.
 * @verify dot doctor --json | jq -e .ok
 */
export const DoctorFailed = defineFailure('dot.doctor_failed', {
  data: guarded(
    'dot.doctor_failed',
    (value): value is DoctorReport =>
      is(value, recordSchema) &&
      typeof value['status'] === 'string' &&
      is(value['app'], recordSchema) &&
      Array.isArray(value['plugins']) &&
      Array.isArray(value['issues']),
  ),
  message: data => `Doctor found errors in ${data.app.name} (state=${data.app.state})`,
  remediation: 'Read the issues in `.error.data.plugins[].issues` and `.error.data.issues`; each carries its own fix.',
});

export type TargetNotEmptyData = { readonly target: string; readonly conflicting: readonly string[] };

/**
 * `dot new` would overwrite files in a non-empty target directory.
 * @fix Choose an empty directory, or re-run with `--force` to overwrite.
 * @verify dot new <name> --dry-run --json | jq -e .ok
 */
export const TargetNotEmpty = defineFailure('dot.target_not_empty', {
  data: guarded(
    'dot.target_not_empty',
    (value): value is TargetNotEmptyData =>
      is(value, recordSchema) && strings(value, ['target']) && isStringArray(value['conflicting']),
  ),
  message: 'Target directory "{target}" is not empty',
  remediation: 'Choose an empty directory, or re-run with --force to overwrite.',
});

export type TemplateMissingData = { readonly templateRoot: string };

/**
 * The package's bundled template directory is empty or missing.
 * @fix Reinstall `@arki/dot`: it must ship its `templates/` directory.
 * @verify dot new <name> --dry-run --json | jq -e .ok
 */
export const TemplateMissing = defineFailure('dot.template_missing', {
  data: guarded(
    'dot.template_missing',
    (value): value is TemplateMissingData => is(value, recordSchema) && strings(value, ['templateRoot']),
  ),
  message: 'No template files found under {templateRoot}',
  remediation: 'Reinstall @arki/dot: it must ship its `templates/` directory.',
});

export type WriteFailedData = {
  readonly target: string;
  /** The files that were written before and after the failures. */
  readonly written: readonly DotNewOperation[];
  readonly failed: readonly { readonly path: string; readonly message: string }[];
};

/**
 * `dot new` could not write some files. `written` lists the ones that landed.
 * @fix Check the permissions of the target directory, then re-run with `--force`.
 * @verify dot new <name> --dry-run --json | jq -e .ok
 */
export const WriteFailed = defineFailure('dot.write_failed', {
  data: guarded(
    'dot.write_failed',
    (value): value is WriteFailedData =>
      is(value, recordSchema) &&
      strings(value, ['target']) &&
      Array.isArray(value['written']) &&
      Array.isArray(value['failed']) &&
      value['failed'].every(entry => is(entry, recordSchema) && strings(entry, ['path', 'message'])),
  ),
  message: data => `Failed to write ${String(data.failed.length)} file(s) under ${data.target}`,
  remediation: 'Check the filesystem permissions of the target directory, then re-run with --force.',
});

/** `dot.app_lifecycle_failed` from what `configure` or `boot` threw. */
export function lifecycleFailed(error: unknown, phase: 'configure' | 'boot'): Failure {
  return AppLifecycleFailed(
    {
      phase,
      underlyingCode: error instanceof DotLifecycleError ? error.code : 'UNKNOWN',
      causeMessage: error instanceof Error ? error.message : String(error),
    },
    { cause: error },
  );
}

/* `dot dev` ----------------------------------------------------------- */

export type DevDbUnreachableData = {
  /** The database URL with its password redacted, or `<not set>` / `<invalid>`. */
  readonly target: string;
  readonly reason: string;
};

/**
 * `dot dev` found no Postgres to talk to: no URL, a bad URL, or a closed port it could not start.
 * @fix Start the database, fix `DB_URL` in `.env`, or run `dot dev --db pglite`.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevDbUnreachable = defineFailure('dot.dev_db_unreachable', {
  data: guarded(
    'dot.dev_db_unreachable',
    (value): value is DevDbUnreachableData => is(value, recordSchema) && strings(value, ['target', 'reason']),
  ),
  message: 'Database {target} is not reachable: {reason}',
  remediation:
    'Start the database (`docker compose up -d <service>`), fix DB_URL in .env, or run `dot dev --db pglite` for an embedded one.',
});

export type DevRunnerFailedData = { readonly command: string; readonly causeMessage: string };

/**
 * The app runner (`vite dev`, `--run`, or `dot _serve`) could not be started.
 * @fix Install the runner, or pass the command that serves the app with `dot dev --run "<cmd>"`.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevRunnerFailed = defineFailure('dot.dev_runner_failed', {
  data: guarded(
    'dot.dev_runner_failed',
    (value): value is DevRunnerFailedData => is(value, recordSchema) && strings(value, ['command', 'causeMessage']),
  ),
  message: 'Could not start the app runner `{command}`: {causeMessage}',
  remediation:
    'Install the runner (`bun add -D vite`), or pass the command that serves the app: `dot dev --run "<cmd>"`.',
});

export type DevPortInUseData = { readonly port: number };

/**
 * Something already listens on the app port, so the runner would not get it.
 * @fix Stop the process on that port, or pick another one with `dot dev --port <n>`.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevPortInUse = defineFailure('dot.dev_port_in_use', {
  data: guarded(
    'dot.dev_port_in_use',
    (value): value is DevPortInUseData => is(value, recordSchema) && typeof value['port'] === 'number',
  ),
  message: 'Port {port} is already in use',
  remediation: 'Stop the process that listens on that port, or pick another one with `dot dev --port <n>`.',
});

export type DevAlreadyRunningData = { readonly pid: number; readonly statePath: string };

/**
 * Another `dot dev` is alive in this project: its pid is in the state file.
 * @fix Stop the other `dot dev`; if its pid is not a `dot dev`, delete the file in `.error.data.statePath`.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevAlreadyRunning = defineFailure('dot.dev_already_running', {
  data: guarded(
    'dot.dev_already_running',
    (value): value is DevAlreadyRunningData =>
      is(value, recordSchema) && typeof value['pid'] === 'number' && strings(value, ['statePath']),
  ),
  message: 'dot dev is already running in this project (pid {pid})',
  remediation:
    'Stop the other `dot dev` (press q in its terminal). If that pid is not a `dot dev`, delete the file in `.error.data.statePath`.',
});

export type DevRemoteDbRefusedData = {
  /** The database URL with its password redacted. */
  readonly target: string;
  readonly host: string;
  /** Where the URL came from: `DB_URL in .env.local`, `DATABASE_URL in process env`. */
  readonly source: string;
};

/**
 * The database is neither on this machine nor a compose service: `dot dev` would migrate it on boot.
 * @fix Point every database URL at this machine or a compose service, or pass `--allow-remote-db` on purpose.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevRemoteDbRefused = defineFailure('dot.dev_remote_db_refused', {
  data: guarded(
    'dot.dev_remote_db_refused',
    (value): value is DevRemoteDbRefusedData => is(value, recordSchema) && strings(value, ['target', 'host', 'source']),
  ),
  message: 'Refusing the remote database {target} ({source}): dot dev applies migrations on boot',
  remediation:
    'Point every DB_URL and DATABASE_URL (process env and .env files) at localhost or a docker compose service, or pass `--allow-remote-db` if you mean to migrate that database.',
});

export type DevAppStartedData = { readonly filePath: string; readonly exportName: string };

/**
 * The app export is already configured, booted or started: `dot dev` cannot own its lifecycle.
 * @fix Export the unstarted builder: no `configure()`, `boot()` or `start()` call on the `dev` export.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevAppStarted = defineFailure('dot.dev_app_started', {
  data: guarded(
    'dot.dev_app_started',
    (value): value is DevAppStartedData => is(value, recordSchema) && strings(value, ['filePath', 'exportName']),
  ),
  message:
    'The `{exportName}` export in {filePath} is already configured or started; dot dev needs an unstarted builder',
  remediation:
    'Export the builder itself, without calling configure(), boot() or start(): `export const dev = defineApp("my-app").infra(unit);`',
});

export type DevPreflightFailedData = {
  /** What went wrong with the preflight process: it crashed, hung, or did not report. */
  readonly reason: string;
  /** Its exit code; null when it was killed or is still running. */
  readonly exitCode: number | null;
  /** Its last output lines. */
  readonly output: readonly string[];
};

/**
 * The preflight process did not report a result: a crash, a hang past the timeout, or output that is not its report. Never a pass.
 * @fix Read `.error.data.output`, then run `dot doctor --app <file>` to see the same boot in the foreground.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevPreflightFailed = defineFailure('dot.dev_preflight_failed', {
  data: guarded(
    'dot.dev_preflight_failed',
    (value): value is DevPreflightFailedData =>
      is(value, recordSchema) &&
      strings(value, ['reason']) &&
      (value['exitCode'] === null || typeof value['exitCode'] === 'number') &&
      isStringArray(value['output']),
  ),
  message: 'The preflight did not report a result: {reason}',
  remediation:
    'Read `.error.data.output`; run `dot doctor --app <file>` in the project to see the same boot in the foreground.',
});

/**
 * A managed preflight reported a lifecycle failure, retaining the complete report.
 * @fix Read `.error.data.failure.code` and apply its message; inspect `.error.data.report` for diagnostics.
 * @verify dot _preflight --json | jq '.error.data.failure.code'
 * @example
 * ```ts
 * import { PreflightFailed } from '@arki/dot/cli';
 * const failure = PreflightFailed({
 *   app: null, migrations: null, report: null,
 *   failure: { code: 'app.refused', message: 'Setup refused.', data: null },
 * });
 * ```
 */
export const PreflightFailed = defineFailure('dot.preflight_failed', {
  data: preflightMessageSchema,
  message: data => data.failure?.message ?? 'The preflight reported a failure.',
  remediation:
    'Read error.data.failure and error.data.report; fix the reported lifecycle failure before starting the app.',
});
