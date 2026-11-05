/**
 * The failures the `dot` commands return. Each code is stable: agents branch
 * on `.error.code`. A returned failure exits 3; the framework's own
 * (`cli.unknown_command`, `cli.invalid_input`) exit 2.
 *
 * Each failure's `data` is a zod schema; its exported `...Data` type is the
 * schema's output, so a shape is written once.
 */
import { z } from 'zod';

import type { Failure } from '@arki/failure';
import { defineFailure } from '@arki/failure';

import type { DotDiagnosticsSnapshot } from '../diagnostics.js';
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

const appNotFoundDataSchema = z.object({ cwd: z.string(), searched: z.array(z.string()).readonly() }).readonly();
export type AppNotFoundData = z.output<typeof appNotFoundDataSchema>;

/**
 * No app file at the default paths and no `--app`.
 * @fix Create `dot.config.ts` that exports the app, or pass `--app <path>`.
 * @verify dot explain --json | jq -e .ok
 */
export const AppNotFound = /* @__PURE__ */ defineFailure('dot.app_not_found', {
  data: appNotFoundDataSchema,
  message: 'No DOT app file found in {cwd}',
  remediation:
    'Create `dot.config.ts` exporting your app (`export default defineApp("pizzeria").infra(unit)`), or pass `--app <path>`.',
});

const appInvalidExportDataSchema = z
  .object({
    filePath: z.string(),
    /** The export that was picked and is not an app; null when none was picked. */
    exportName: z.string().nullable(),
    exports: z.array(z.string()).readonly(),
    /** The exports that look like DOT apps, when there are several. */
    matches: z.array(z.string()).readonly(),
  })
  .readonly();
export type AppInvalidExportData = z.output<typeof appInvalidExportDataSchema>;

/**
 * The app file loaded, but no export is a DOT app, or several are and none is `default` or `app`.
 * @fix Export the app as `default` or as `app`.
 * @verify dot explain --json | jq -e .ok
 */
export const AppInvalidExport = /* @__PURE__ */ defineFailure('dot.app_invalid_export', {
  data: appInvalidExportDataSchema,
  message: data => {
    const listed = (names: readonly string[]): string => (names.length === 0 ? 'none' : names.join(', '));
    if (data.exportName !== null) {
      return `The \`${data.exportName}\` export from ${data.filePath} is not a DotApp or DotAppBuilder.`;
    }
    return data.matches.length > 1
      ? `${data.filePath} exports several DOT apps (${listed(data.matches)}) and none is \`default\` or \`app\`.`
      : `${data.filePath} exports no DOT app. Exports found: ${listed(data.exports)}.`;
  },
  remediation: 'Export the app as `default` or as `app`: `export const app = defineApp("pizzeria").infra(unit);`',
});

const appImportFailedDataSchema = z
  .object({
    filePath: z.string(),
    /** The factory export that threw; null when the import itself threw. */
    exportName: z.string().nullable(),
    causeMessage: z.string(),
    /** The code of the thrown error, when it carries one (a declaration rejecting a mistake). */
    causeCode: z.string().nullable(),
    /** The thrown error's own fix, when it carries one. */
    causeRemediation: z.string().nullable(),
  })
  .readonly();
export type AppImportFailedData = z.output<typeof appImportFailedDataSchema>;

/**
 * Importing the app file threw, or its exported factory did.
 * @fix Apply `.error.data.causeRemediation` when it is set; otherwise run `bun <app file>` to reproduce.
 * @verify dot explain --json | jq -e .ok
 */
export const AppImportFailed = /* @__PURE__ */ defineFailure('dot.app_import_failed', {
  data: appImportFailedDataSchema,
  message: data =>
    data.exportName === null
      ? `Failed to import app file at ${data.filePath}: ${data.causeMessage}`
      : `The \`${data.exportName}\` export function in ${data.filePath} threw: ${data.causeMessage}`,
  remediation:
    'Apply `.error.data.causeRemediation` when it is set; otherwise run the file directly (`bun <path>`) to reproduce.',
});

const appLifecycleFailedDataSchema = z.object({ phase: z.enum(['configure', 'boot']), underlyingCode: z.string(), causeMessage: z.string() }).readonly();
export type AppLifecycleFailedData = z.output<typeof appLifecycleFailedDataSchema>;

/**
 * `configure` threw while the CLI prepared the app.
 * @fix Read `.error.data.underlyingCode` and look it up in the kernel error table; `ARKI_DOT_E020` means a provider is mounted after its consumer.
 * @verify dot explain --json | jq -e .ok
 */
export const AppLifecycleFailed = /* @__PURE__ */ defineFailure('dot.app_lifecycle_failed', {
  data: appLifecycleFailedDataSchema,
  message: 'App {phase} failed: {causeMessage}',
  remediation:
    'Read `error.data.underlyingCode` and apply the remediation of that code (`ARKI_DOT_E020` means a provider is mounted after its consumer); `dot doctor` shows per-unit diagnostics.',
});

/**
 * `doctor --observability` found no OpenTelemetry SDK. Reported as a warning issue in the snapshot, not returned.
 * @fix Register an OpenTelemetry SDK once at app entry, before any app boots.
 * @verify dot doctor --observability --json | jq '.data.issues'
 */
export const ObservabilityNoSdk = /* @__PURE__ */ defineFailure('dot.observability_no_sdk', {
  message: 'No OpenTelemetry SDK is registered. Lifecycle traces and metrics will not be exported.',
  remediation:
    'Register an OTel SDK (e.g. @opentelemetry/sdk-node with AsyncLocalStorageContextManager) once at app entry, before any DotApp boots.',
});

const projectionNotFoundDataSchema = z.object({ format: z.string(), registeredFormats: z.array(z.string()).readonly() }).readonly();
export type ProjectionNotFoundData = z.output<typeof projectionNotFoundDataSchema>;

/**
 * No unit registers the `--as` format.
 * @fix Use a format from `.error.data.registeredFormats`, or mount the adapter that provides it.
 * @verify dot explain --as <format> --json | jq -e .ok
 */
export const ProjectionNotFound = /* @__PURE__ */ defineFailure('dot.projection_not_found', {
  data: projectionNotFoundDataSchema,
  message: 'No projection is registered for format "{format}"',
  remediation:
    'Use a format from `.error.data.registeredFormats`, or mount the adapter that provides it; otherwise remove --as.',
});

const projectionImportFailedDataSchema = z
  .object({
    specifier: z.string(),
    registeringPlugin: z.string(),
    /** Where it failed: resolving the specifier, importing the module, or finding `project`. */
    stage: z.enum(['resolve', 'import', 'export']),
    causeMessage: z.string().nullable(),
  })
  .readonly();
export type ProjectionImportFailedData = z.output<typeof projectionImportFailedDataSchema>;

/**
 * The projection module could not be resolved or imported, or exports no `project(manifest)`.
 * @fix Install the module and export a named `project(manifest)` function from it.
 * @verify dot explain --as <format> --json | jq -e .ok
 */
export const ProjectionImportFailed = /* @__PURE__ */ defineFailure('dot.projection_import_failed', {
  data: projectionImportFailedDataSchema,
  message: data => {
    if (data.stage === 'resolve') return `Failed to resolve projection module "${data.specifier}".`;
    if (data.stage === 'import') return `Failed to import projection module "${data.specifier}".`;
    return `Projection module "${data.specifier}" does not export project(manifest).`;
  },
  remediation:
    'Install the module and export a named `project(manifest)` function from it; `--module <specifier>` tries a replacement.',
});

const projectionExecutionFailedDataSchema = z.object({ format: z.string(), specifier: z.string(), registeringPlugin: z.string(), causeMessage: z.string() }).readonly();
export type ProjectionExecutionFailedData = z.output<typeof projectionExecutionFailedDataSchema>;

/**
 * `project(manifest)` threw or returned output that does not survive a JSON round trip.
 * @fix Make `project(manifest)` pure and return JSON-round-trip-safe output.
 * @verify dot explain --as <format> --json | jq -e .ok
 */
export const ProjectionExecutionFailed = /* @__PURE__ */ defineFailure('dot.projection_execution_failed', {
  data: projectionExecutionFailedDataSchema,
  message: 'Projection "{format}" failed while rendering: {causeMessage}',
  remediation: 'Make `project(manifest)` pure and return JSON-round-trip-safe output.',
});

const projectionConflictDataSchema = z
  .object({
    format: z.string(),
    projections: z.array(z.object({ plugin: z.string(), module: z.string() }).readonly()).readonly(),
  })
  .readonly();
export type ProjectionConflictData = z.output<typeof projectionConflictDataSchema>;

/**
 * Two units register different modules for one projection format.
 * @fix Remove one registration, or make both units register the same module.
 * @verify dot explain --as <format> --json | jq -e .ok
 */
export const ProjectionConflict = /* @__PURE__ */ defineFailure('dot.projection_conflict', {
  data: projectionConflictDataSchema,
  message: 'Multiple projection modules are registered for format "{format}"',
  remediation: 'Remove one registration, or make both units register the same module specifier.',
});

/** The diagnostics snapshot as `dot doctor` prints it; a type test locks it to `DotDiagnosticsSnapshot`. */
const issueSchema = z.object({
  code: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  plugin: z.string().optional(),
  message: z.string(),
  remediation: z.string(),
  docsUrl: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
const lifecycleStateSchema = z.enum(['defined', 'configured', 'booted', 'started', 'stopped', 'disposed', 'failed']);
const doctorReportSchema = z.object({
  snapshotVersion: z.literal(2),
  generatedAt: z.string(),
  app: z.object({ name: z.string(), state: lifecycleStateSchema }),
  plugins: z.array(
    z.object({
      plugin: z.string(),
      status: z.enum(['ok', 'degraded', 'failed', 'skipped']),
      issues: z.array(issueSchema),
    }),
  ),
  actions: z.array(
    z.object({
      id: z.string(),
      plugin: z.string(),
      binding: z.string(),
      summary: z.string().optional(),
      status: z.enum(['ok', 'degraded', 'failed']),
      issues: z.array(issueSchema),
    }),
  ),
  services: z.array(
    z.object({
      service: z.string(),
      plugin: z.string(),
      status: z.enum(['ok', 'degraded', 'failed', 'missing']),
      issues: z.array(issueSchema),
    }),
  ),
  lifecycle: z.array(
    z.object({
      plugin: z.string(),
      hook: z.enum(['configure', 'boot', 'start', 'stop', 'dispose']),
      state: lifecycleStateSchema,
      order: z.number(),
      durationMs: z.number().optional(),
      issues: z.array(issueSchema),
    }),
  ),
  issues: z.array(issueSchema),
  status: z.enum(['success', 'warning', 'failure']),
});

/**
 * `doctor` found error-severity issues. The data is the whole report: `.error.data.plugins[]`.
 * @fix Apply the `remediation` of each issue in `.error.data.plugins[].issues` and `.error.data.issues`.
 * @verify dot doctor --json | jq -e .ok
 */
export const DoctorFailed = /* @__PURE__ */ defineFailure('dot.doctor_failed', {
  data: doctorReportSchema,
  message: data => `Doctor found errors in ${data.app.name} (state=${data.app.state})`,
  remediation: 'Read the issues in `.error.data.plugins[].issues` and `.error.data.issues`; each carries its own fix.',
});

const targetNotEmptyDataSchema = z.object({ target: z.string(), conflicting: z.array(z.string()).readonly() }).readonly();
export type TargetNotEmptyData = z.output<typeof targetNotEmptyDataSchema>;

/**
 * `dot new` would overwrite files in a non-empty target directory.
 * @fix Choose an empty directory, or re-run with `--force` to overwrite.
 * @verify dot new <name> --dry-run --json | jq -e .ok
 */
export const TargetNotEmpty = /* @__PURE__ */ defineFailure('dot.target_not_empty', {
  data: targetNotEmptyDataSchema,
  message: 'Target directory "{target}" is not empty',
  remediation: 'Choose an empty directory, or re-run with --force to overwrite.',
});

const templateMissingDataSchema = z.object({ templateRoot: z.string() }).readonly();
export type TemplateMissingData = z.output<typeof templateMissingDataSchema>;

/**
 * The package's bundled template directory is empty or missing.
 * @fix Reinstall `@arki/dot`: it must ship its `templates/` directory.
 * @verify dot new <name> --dry-run --json | jq -e .ok
 */
export const TemplateMissing = /* @__PURE__ */ defineFailure('dot.template_missing', {
  data: templateMissingDataSchema,
  message: 'No template files found under {templateRoot}',
  remediation: 'Reinstall @arki/dot: it must ship its `templates/` directory.',
});

const writeFailedDataSchema = z
  .object({
    target: z.string(),
    /** The files that were written before and after the failures. */
    written: z
      .array(
        z
          .object({
            path: z.string(),
            action: z.enum(['create', 'overwrite', 'skip']),
            contentHash: z.string(),
            contentBytes: z.number(),
            reason: z.string(),
          })
          .readonly(),
      )
      .readonly(),
    failed: z.array(z.object({ path: z.string(), message: z.string() }).readonly()).readonly(),
  })
  .readonly();
export type WriteFailedData = z.output<typeof writeFailedDataSchema>;

/**
 * `dot new` could not write some files. `written` lists the ones that landed.
 * @fix Check the permissions of the target directory, then re-run with `--force`.
 * @verify dot new <name> --dry-run --json | jq -e .ok
 */
export const WriteFailed = /* @__PURE__ */ defineFailure('dot.write_failed', {
  data: writeFailedDataSchema,
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

const devDbUnreachableDataSchema = z
  .object({
    /** The database URL with its password redacted, or `<not set>` / `<invalid>`. */
    target: z.string(),
    reason: z.string(),
  })
  .readonly();
export type DevDbUnreachableData = z.output<typeof devDbUnreachableDataSchema>;

/**
 * `dot dev` found no Postgres to talk to: no URL, a bad URL, or a closed port it could not start.
 * @fix Start the database, fix `DB_URL` in `.env`, or run `dot dev --db pglite`.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevDbUnreachable = /* @__PURE__ */ defineFailure('dot.dev_db_unreachable', {
  data: devDbUnreachableDataSchema,
  message: 'Database {target} is not reachable: {reason}',
  remediation:
    'Start the database (`docker compose up -d <service>`), fix DB_URL in .env, or run `dot dev --db pglite` for an embedded one.',
});

const devRunnerFailedDataSchema = z.object({ command: z.string(), causeMessage: z.string() }).readonly();
export type DevRunnerFailedData = z.output<typeof devRunnerFailedDataSchema>;

/**
 * The app runner (`vite dev`, `--run`, or `dot _serve`) could not be started.
 * @fix Install the runner, or pass the command that serves the app with `dot dev --run "<cmd>"`.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevRunnerFailed = /* @__PURE__ */ defineFailure('dot.dev_runner_failed', {
  data: devRunnerFailedDataSchema,
  message: 'Could not start the app runner `{command}`: {causeMessage}',
  remediation:
    'Install the runner (`bun add -D vite`), or pass the command that serves the app: `dot dev --run "<cmd>"`.',
});

const devPortInUseDataSchema = z.object({ port: z.number() }).readonly();
export type DevPortInUseData = z.output<typeof devPortInUseDataSchema>;

/**
 * Something already listens on the app port, so the runner would not get it.
 * @fix Stop the process on that port, or pick another one with `dot dev --port <n>`.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevPortInUse = /* @__PURE__ */ defineFailure('dot.dev_port_in_use', {
  data: devPortInUseDataSchema,
  message: 'Port {port} is already in use',
  remediation: 'Stop the process that listens on that port, or pick another one with `dot dev --port <n>`.',
});

const devAlreadyRunningDataSchema = z.object({ pid: z.number(), statePath: z.string() }).readonly();
export type DevAlreadyRunningData = z.output<typeof devAlreadyRunningDataSchema>;

/**
 * Another `dot dev` is alive in this project: its pid is in the state file.
 * @fix Stop the other `dot dev`; if its pid is not a `dot dev`, delete the file in `.error.data.statePath`.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevAlreadyRunning = /* @__PURE__ */ defineFailure('dot.dev_already_running', {
  data: devAlreadyRunningDataSchema,
  message: 'dot dev is already running in this project (pid {pid})',
  remediation:
    'Stop the other `dot dev` (press q in its terminal). If that pid is not a `dot dev`, delete the file in `.error.data.statePath`.',
});

const devStateFailedDataSchema = z.object({ statePath: z.string(), reason: z.string() }).readonly();
export type DevStateFailedData = z.output<typeof devStateFailedDataSchema>;

/**
 * `dot dev` could not create its state file: the project folder is read-only or full.
 * @fix Make the project folder writable and free some disk space, then run `dot dev` again.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevStateFailed = /* @__PURE__ */ defineFailure('dot.dev_state_failed', {
  data: devStateFailedDataSchema,
  message: 'Could not create {statePath}: {reason}',
  remediation: 'Make the project folder writable and free some disk space, then run `dot dev` again.',
});

const devRemoteDbRefusedDataSchema = z
  .object({
    /** The database URL with its password redacted. */
    target: z.string(),
    host: z.string(),
    /** Where the URL came from: `DB_URL in .env.local`, `DATABASE_URL in process env`. */
    source: z.string(),
  })
  .readonly();
export type DevRemoteDbRefusedData = z.output<typeof devRemoteDbRefusedDataSchema>;

/**
 * The database is neither on this machine nor a compose service: `dot dev` would migrate it on boot.
 * @fix Point every database URL at this machine or a compose service, or pass `--allow-remote-db` on purpose.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevRemoteDbRefused = /* @__PURE__ */ defineFailure('dot.dev_remote_db_refused', {
  data: devRemoteDbRefusedDataSchema,
  message: 'Refusing the remote database {target} ({source}): dot dev applies migrations on boot',
  remediation:
    'Point every DB_URL and DATABASE_URL (process env and .env files) at localhost or a docker compose service, or pass `--allow-remote-db` if you mean to migrate that database.',
});

const devAppStartedDataSchema = z.object({ filePath: z.string(), exportName: z.string() }).readonly();
export type DevAppStartedData = z.output<typeof devAppStartedDataSchema>;

/**
 * The app export is already configured, booted or started: `dot dev` cannot own its lifecycle.
 * @fix Export the unstarted builder: no `configure()`, `boot()` or `start()` call on the `dev` export.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevAppStarted = /* @__PURE__ */ defineFailure('dot.dev_app_started', {
  data: devAppStartedDataSchema,
  message:
    'The `{exportName}` export in {filePath} is already configured or started; dot dev needs an unstarted builder',
  remediation:
    'Export the builder itself, without calling configure(), boot() or start(): `export const dev = defineApp("pizzeria").infra(unit);`',
});

const devPreflightFailedDataSchema = z
  .object({
    /** What went wrong with the preflight process: it crashed, hung, or did not report. */
    reason: z.string(),
    /** Its exit code; null when it was killed or is still running. */
    exitCode: z.number().nullable(),
    /** Its last output lines. */
    output: z.array(z.string()).readonly(),
  })
  .readonly();
export type DevPreflightFailedData = z.output<typeof devPreflightFailedDataSchema>;

/**
 * The preflight process did not report a result: a crash, a hang past the timeout, or output that is not its report. Never a pass.
 * @fix Read `.error.data.output`, then run `dot doctor --app <file>` to see the same boot in the foreground.
 * @verify dot dev --once --json | jq -e .ok
 */
export const DevPreflightFailed = /* @__PURE__ */ defineFailure('dot.dev_preflight_failed', {
  data: devPreflightFailedDataSchema,
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
export const PreflightFailed = /* @__PURE__ */ defineFailure('dot.preflight_failed', {
  data: preflightMessageSchema,
  message: data => data.failure?.message ?? 'The preflight reported a failure.',
  remediation:
    'Read error.data.failure and error.data.report; fix the reported lifecycle failure before starting the app.',
});
