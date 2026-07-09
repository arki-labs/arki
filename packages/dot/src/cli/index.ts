#!/usr/bin/env node

/**
 * `dot` CLI entry point.
 *
 * Two commands are wired today (more land in v1.1):
 *   - `dot explain` — print the static app graph (manifest)
 *   - `dot doctor`  — boot the app and print runtime diagnostics
 *
 * Common options:
 *   --json       Emit JSON envelope instead of human-readable text
 *   --app <p>    Path to the app file (overrides auto-discovery)
 *   --cwd <p>    Working directory (default: process.cwd())
 *   --help       Show help
 *   --version    Print version
 *
 * Exit codes: `0` on success/warning envelopes (doctor warnings still mean the
 * app booted), `1` on `failure` envelopes and on every structured CLI error.
 */

import { parseArgs as nodeParseArgs } from 'node:util';

import { createDebugLogger } from '@arki/log/debug';

import type { DotApp, DotAppBuilder, DotAppConfigured } from '../define-app.js';
import type { DiagnosticIssue } from '../diagnostics.js';
import type { DiscoveredApp, DiscoveryResult } from './discover.js';
import type { DotCliEnvelope, DotCliEnvelopeStatus } from './render-explain.js';
import { DotLifecycleError } from '../lifecycle.js';
import { discoverApp, guards } from './discover.js';
import { DotCliError, DotCliErrorCode, dotCliDocsUrl } from './error-codes.js';
import { runNew } from './new.js';
import { probeObservability } from './observability-probe.js';
import { renderDoctor } from './render-doctor.js';
import { renderExplain } from './render-explain.js';
import { renderGraph } from './render-graph.js';
import { renderProjection } from './render-projection.js';

const debugCli = createDebugLogger('arki:dot:cli');

const VERSION = '0.1.0';

const HELP_TEXT = `dot — CLI for inspecting and scaffolding DOT apps

Usage:
  dot <command> [options]

Commands:
  explain                Print the static app graph (manifest)
  doctor                 Boot the app and print runtime diagnostics
  new <app-name>         Scaffold a minimal DOT app

Common options:
  --json                 Emit a JSON envelope to stdout (default: text)
  --help                 Show this help and exit
  --version              Print version and exit

\`explain\` / \`doctor\` options:
  --app <path>           Path to the app entry file (default: discovers
                         ./dot.config.ts, ./src/app.ts, or ./app.ts)
  --cwd <dir>            Working directory (default: current)
  --graph                Emit the plugin graph as Mermaid flowchart source
                         instead of the standard output. explain shows
                         declaration (= boot) order; doctor shows the
                         wiring observed during boot. Composes with --json.
  --as <format>          (explain only) Render a registered projection format.
                         Examples: openapi, asyncapi, help-text. Composes
                         with --json.
  --module <specifier>   (explain --as only) Override the registered
                         projection module for one invocation.
  --openapi              Deprecated alias for --as openapi.

\`doctor\` options:
  --observability        Also probe whether an OpenTelemetry SDK is
                         registered. Surfaces a warning issue when not,
                         pointing at the docs to wire one in.

\`new\` options:
  --target <dir>         Directory to create the app in (default: <app-name>)
  --pm <npm|pnpm|bun>    Package manager hint for the README (default: bun)
  --dry-run              Print planned file operations without writing
  --force                Overwrite existing files in the target directory
`;

export type CliCommand = 'explain' | 'doctor' | 'new' | 'help' | 'version';

export type CliArgs = {
  command: CliCommand;
  json: boolean;
  appPath?: string;
  cwd?: string;
  /** Positional after the command (used by `new` for the app name). */
  positional?: string;
  /** `--target` (only honored by `new`). */
  target?: string;
  /** `--pm` (only honored by `new`). */
  pm?: 'npm' | 'pnpm' | 'bun';
  /** `--dry-run` (only honored by `new`). */
  dryRun?: boolean;
  /** `--force` (only honored by `new`). */
  force?: boolean;
  /** `--observability` (only honored by `doctor`). */
  observability?: boolean;
  /** `--graph` (honored by `explain` and `doctor`). */
  graph?: boolean;
  /** `--as` projection format (honored by `explain` only). */
  as?: string;
  /** `--module` projection override (honored by `explain --as` only). */
  module?: string;
  /** Deprecated `--openapi` alias for `--as openapi`. */
  openapi?: boolean;
};

/**
 * Parse argv into a typed shape. Exported so tests can exercise it without
 * spawning the binary.
 */
export function parseArgs(argv: readonly string[]): CliArgs {
  // Extract the (optional) leading positional command; node:util parseArgs
  // wants every positional to come *after* flags by default, but we want
  // `dot explain --json` to parse correctly.
  const rest = [...argv];
  let command: CliArgs['command'] | null = null;

  // Pull off the first positional that doesn't look like a flag.
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]!;
    if (!tok.startsWith('-')) {
      const cmd = tok;
      if (cmd === 'explain' || cmd === 'doctor' || cmd === 'new' || cmd === 'help' || cmd === 'version') {
        command = cmd;
        rest.splice(i, 1);
        break;
      }
      throw new DotCliError({
        code: DotCliErrorCode.UnknownCommand,
        message: `Unknown command: ${cmd}`,
        remediation: 'Use one of: explain, doctor, new. Run `dot --help` for usage.',
        metadata: { received: cmd },
      });
    }
  }

  // `new` takes a positional <app-name> after the command. Pull the next
  // non-flag token out so node:util parseArgs doesn't see it.
  let positional: string | undefined;
  if (command === 'new') {
    for (let i = 0; i < rest.length; i++) {
      const tok = rest[i]!;
      if (!tok.startsWith('-')) {
        positional = tok;
        rest.splice(i, 1);
        break;
      }
    }
  }

  let parsed: ReturnType<typeof nodeParseArgs>;
  try {
    parsed = nodeParseArgs({
      args: rest,
      strict: true,
      allowPositionals: false,
      options: {
        json: { type: 'boolean', default: false },
        app: { type: 'string' },
        cwd: { type: 'string' },
        help: { type: 'boolean', default: false },
        version: { type: 'boolean', default: false },
        target: { type: 'string' },
        pm: { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
        force: { type: 'boolean', default: false },
        observability: { type: 'boolean', default: false },
        graph: { type: 'boolean', default: false },
        as: { type: 'string' },
        module: { type: 'string' },
        openapi: { type: 'boolean', default: false },
      },
    });
  } catch (err) {
    throw new DotCliError({
      code: DotCliErrorCode.InvalidArgs,
      message: `Invalid CLI arguments: ${err instanceof Error ? err.message : String(err)}`,
      remediation: 'Run `dot --help` to see supported options.',
      cause: err,
    });
  }

  const values = parsed.values as {
    json?: boolean;
    app?: string;
    cwd?: string;
    help?: boolean;
    version?: boolean;
    target?: string;
    pm?: string;
    'dry-run'?: boolean;
    force?: boolean;
    observability?: boolean;
    graph?: boolean;
    as?: string;
    module?: string;
    openapi?: boolean;
  };

  if (values.help) command = 'help';
  if (values.version) command = 'version';

  if (!command) command = 'help';

  const projectionFormat = values.as ?? (values.openapi === true ? 'openapi' : undefined);

  if (projectionFormat !== undefined && values.graph === true) {
    throw new DotCliError({
      code: DotCliErrorCode.InvalidArgs,
      message: '--as/--openapi and --graph are mutually exclusive.',
      remediation: 'Pick one output format per invocation.',
    });
  }
  if (projectionFormat !== undefined && command === 'doctor') {
    throw new DotCliError({
      code: DotCliErrorCode.InvalidArgs,
      message: '--as is not supported by doctor.',
      remediation: 'Use `dot explain --as <format>` — projections render from the static manifest, no boot needed.',
    });
  }
  if (values.module !== undefined && projectionFormat === undefined) {
    throw new DotCliError({
      code: DotCliErrorCode.InvalidArgs,
      message: '--module requires --as <format>.',
      remediation: 'Pass a projection format with --as, or remove --module.',
    });
  }

  let pm: CliArgs['pm'];
  if (values.pm !== undefined) {
    if (values.pm !== 'npm' && values.pm !== 'pnpm' && values.pm !== 'bun') {
      throw new DotCliError({
        code: DotCliErrorCode.InvalidArgs,
        message: `Invalid --pm value: ${values.pm}`,
        remediation: 'Use one of: npm, pnpm, bun.',
        metadata: { received: values.pm },
      });
    }
    pm = values.pm;
  }

  return {
    command,
    json: values.json ?? false,
    appPath: values.app,
    cwd: values.cwd,
    positional,
    target: values.target,
    pm,
    dryRun: values['dry-run'] ?? false,
    force: values.force ?? false,
    observability: values.observability ?? false,
    graph: values.graph ?? false,
    as: projectionFormat,
    module: values.module,
    openapi: values.openapi ?? false,
  };
}

/** Discovery wrapper — returns `null` for help/version commands. */
async function loadApp(args: CliArgs): Promise<DiscoveryResult> {
  return discoverApp({ appPath: args.appPath, cwd: args.cwd });
}

/**
 * Run `explain` on a discovered app.
 * Pure dependency on a `DiscoveredApp` so tests can pass synthetic values.
 */
export async function runExplain(
  discovered: DiscoveredApp,
  opts: {
    json: boolean;
    graph?: boolean;
    as?: string;
    module?: string;
    appFilePath?: string;
    openapi?: boolean;
    out?: (line: string) => void;
    now?: () => Date;
  },
): Promise<DotCliEnvelope<unknown>> {
  let configured: DotApp<Record<string, unknown>> | DotAppConfigured<Record<string, unknown>>;
  try {
    if (guards.isDotAppBuilder(discovered)) {
      // explain never boots — just configure.
      configured = (discovered as DotAppBuilder<Record<string, unknown>>).configure();
    } else {
      configured = discovered as
        | DotApp<Record<string, unknown>>
        | DotAppConfigured<Record<string, unknown>>;
    }
  } catch (err) {
    throw wrapLifecycleError(err, 'configure');
  }

  if (opts.as !== undefined) {
    return renderProjection(
      {
        manifest: configured.manifest,
        command: 'explain',
        format: opts.as,
        appFilePath: opts.appFilePath ?? process.cwd(),
        ...(opts.module === undefined ? {} : { module: opts.module }),
      },
      { json: opts.json, out: opts.out, now: opts.now },
    );
  }
  if (opts.graph === true) {
    return renderGraph(
      { manifest: configured.manifest, command: 'explain' },
      { json: opts.json, out: opts.out, now: opts.now },
    );
  }
  return renderExplain({ manifest: configured.manifest }, { json: opts.json, out: opts.out, now: opts.now });
}

type DoctorRunOptions = {
  json: boolean;
  out?: (line: string) => void;
  now?: () => Date;
  /**
   * When `true`, probes for a registered OpenTelemetry SDK and injects
   * a warning-severity issue into the diagnostics envelope when none is
   * present. Default `false`.
   */
  observability?: boolean;
  /** When `true`, emit the plugin graph (Mermaid) instead of diagnostics. */
  graph?: boolean;
};

/**
 * Run `doctor` on a discovered app. The CLI owns boot+dispose only when it
 * receives a builder. If the caller passed an already-booted app, we leave
 * lifecycle to them.
 *
 * If `boot()` throws, doctor's job is still to surface diagnostics — so we
 * pre-configure the builder, then re-read the configured seam's diagnostics
 * even after a boot throw. This is the whole point of `doctor`: failure
 * should be observable, not opaque.
 */
export async function runDoctor(
  discovered: DiscoveredApp,
  opts: DoctorRunOptions,
): Promise<DotCliEnvelope<unknown>> {
  // Already-booted app: just read diagnostics, don't touch lifecycle.
  if (!guards.isDotAppBuilder(discovered) && !guards.isDotAppConfigured(discovered)) {
    const app = discovered as DotApp<Record<string, unknown>>;
    if (opts.graph === true) {
      return renderGraph(
        { manifest: app.manifest, command: 'doctor' },
        { json: opts.json, out: opts.out, now: opts.now },
      );
    }
    const diagnostics = applyObservabilityProbe(app.diagnostics, opts.observability ?? false);
    return renderDoctor({ diagnostics }, { json: opts.json, out: opts.out, now: opts.now });
  }

  // Builder or configured seam: drive lifecycle ourselves. Boot failures fall
  // back to the configured seam's diagnostics so per-plugin issues stay
  // visible.
  let configured: DotAppConfigured<Record<string, unknown>>;
  try {
    configured = guards.isDotAppBuilder(discovered)
      ? (discovered as DotAppBuilder<Record<string, unknown>>).configure()
      : (discovered as DotAppConfigured<Record<string, unknown>>);
  } catch (err) {
    throw wrapLifecycleError(err, 'configure');
  }

  let bootedApp: DotApp<Record<string, unknown>> | null = null;
  let bootThrew = false;
  try {
    bootedApp = await configured.boot();
  } catch (err) {
    // Boot failed — surface diagnostics from the configured seam below.
    // We deliberately swallow the throw so the user sees the per-plugin
    // issues instead of an opaque wrapper error.
    bootThrew = true;
    debugCli('boot threw, falling back to configured diagnostics: %O', err);
  }

  try {
    if (opts.graph === true) {
      // Post-boot manifest carries the observed wiring edges; after a boot
      // failure it carries the edges recorded up to the failing plugin.
      const manifest = bootedApp ? bootedApp.manifest : configured.manifest;
      const graphEnvelope = renderGraph(
        { manifest, command: 'doctor' },
        { json: opts.json, out: opts.out, now: opts.now },
      );
      return bootThrew ? { ...graphEnvelope, status: 'failure' } : graphEnvelope;
    }
    const rawDiagnostics = bootedApp ? bootedApp.diagnostics : configured.diagnostics;
    const diagnostics = applyObservabilityProbe(rawDiagnostics, opts.observability ?? false);
    const envelope = renderDoctor({ diagnostics }, { json: opts.json, out: opts.out, now: opts.now });
    // Sanity: if boot threw, the envelope SHOULD be failure already (kernel
    // populates issues on boot failure). If somehow it isn't, downgrade
    // status to surface the failure.
    if (bootThrew && envelope.status === 'success') {
      return { ...envelope, status: 'failure' };
    }
    return envelope;
  } finally {
    if (bootedApp) {
      try {
        await bootedApp.dispose();
      } catch (err) {
        debugCli('dispose threw: %O', err);
      }
    }
  }
}

/**
 * Run the observability probe and fold its issue (if any) into the
 * top-level `issues` array. Returns a new snapshot — never mutates the
 * input.
 */
function applyObservabilityProbe<T extends { issues: readonly { code: string }[] }>(
  diagnostics: T,
  enabled: boolean,
): T {
  if (!enabled) return diagnostics;
  const probeIssue = probeObservability();
  if (!probeIssue) return diagnostics;
  return { ...diagnostics, issues: [...diagnostics.issues, probeIssue] };
}

function wrapLifecycleError(err: unknown, phase: 'configure' | 'boot'): DotCliError {
  if (err instanceof DotCliError) return err;

  const isLifecycleError = err instanceof DotLifecycleError;
  const message = err instanceof Error ? err.message : String(err);
  const code = isLifecycleError ? err.code : 'UNKNOWN';

  return new DotCliError({
    code: DotCliErrorCode.AppLifecycleFailed,
    message: `App ${phase} failed: ${message}`,
    remediation:
      phase === 'configure'
        ? 'Check the plugins registered in your app for a synchronous `configure` hook that throws or returns a Promise. Run `dot doctor` for per-plugin diagnostics.'
        : 'Run `dot doctor` to see per-plugin diagnostics. The boot hook for one of your plugins failed.',
    metadata: { phase, underlyingCode: code },
    cause: err,
  });
}

/**
 * Convert a `DotCliError` into a synthetic envelope so JSON consumers see a
 * uniform shape regardless of failure mode.
 */
function errorEnvelope(err: DotCliError, command: string, now: () => Date): DotCliEnvelope<null> {
  const issue: DiagnosticIssue = {
    code: err.code,
    severity: 'error',
    message: err.message,
    remediation: err.remediation,
    docsUrl: err.docsUrl,
    metadata: err.metadata,
  };
  return {
    status: 'failure',
    command,
    generatedAt: now().toISOString(),
    data: null,
    errors: [issue],
  };
}

type MainOptions = {
  argv: readonly string[];
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  now?: () => Date;
};

/**
 * Run the CLI. Returns the exit code so tests can assert without calling
 * `process.exit`. Real entry point at the bottom of the file calls `exit()`.
 */
export async function main(options: MainOptions): Promise<number> {
  const stdout = options.stdout ?? ((line: string) => process.stdout.write(line));
  const stderr = options.stderr ?? ((line: string) => process.stderr.write(line));
  const nowFactory = options.now ?? (() => new Date());

  let args: CliArgs;
  try {
    args = parseArgs(options.argv);
  } catch (err) {
    if (err instanceof DotCliError) {
      const envelope = errorEnvelope(err, 'unknown', nowFactory);
      stderr(`${JSON.stringify(envelope, null, 2)}\n`);
      return 1;
    }
    throw err;
  }

  if (args.command === 'help') {
    stdout(HELP_TEXT);
    return 0;
  }
  if (args.command === 'version') {
    stdout(`${VERSION}\n`);
    return 0;
  }

  if (args.command === 'new') {
    if (!args.positional) {
      const err = new DotCliError({
        code: DotCliErrorCode.InvalidArgs,
        message: 'Missing required <app-name> positional for `dot new`.',
        remediation: 'Run `dot new <app-name>`. Example: `dot new my-app`.',
      });
      const envelope = errorEnvelope(err, 'new', nowFactory);
      if (args.json) stdout(`${JSON.stringify(envelope, null, 2)}\n`);
      else stderr(formatErrorText(err));
      return 1;
    }
    try {
      const envelope = await runNew({
        name: args.positional,
        cwd: args.cwd,
        target: args.target,
        pm: args.pm,
        dryRun: args.dryRun,
        json: args.json,
        force: args.force,
        out: stdout,
        err: stderr,
        now: nowFactory,
      });
      return envelope.status === 'failure' ? 1 : 0;
    } catch (err) {
      if (err instanceof DotCliError) {
        const envelope = errorEnvelope(err, 'new', nowFactory);
        if (args.json) stdout(`${JSON.stringify(envelope, null, 2)}\n`);
        else stderr(formatErrorText(err));
        return 1;
      }
      throw err;
    }
  }

  try {
    const discovered = await loadApp(args);
    const opts = { json: args.json, graph: args.graph, out: stdout, now: nowFactory };
    let envelope: DotCliEnvelope<unknown>;

    if (args.command === 'explain') {
      if (args.openapi === true) {
        stderr('dot: --openapi is deprecated; use --as openapi.\n');
      }
      envelope = await runExplain(discovered.app, {
        ...opts,
        as: args.as,
        module: args.module,
        appFilePath: discovered.filePath,
        openapi: args.openapi,
      });
    } else {
      envelope = await runDoctor(discovered.app, { ...opts, observability: args.observability });
    }

    return envelopeExitCode(envelope.status);
  } catch (err) {
    if (err instanceof DotCliError) {
      const envelope = errorEnvelope(err, args.command, nowFactory);
      if (args.json) {
        stdout(`${JSON.stringify(envelope, null, 2)}\n`);
      } else {
        stderr(formatErrorText(err));
      }
      return 1;
    }

    // Last-resort path: an exception escaped without being wrapped. Surface
    // it as a structured envelope rather than dumping a stack trace.
    const fallback = new DotCliError({
      code: DotCliErrorCode.AppLifecycleFailed,
      message: err instanceof Error ? err.message : String(err),
      remediation: 'See debug logs (DEBUG=arki:dot:cli) for context. Re-run with --json for machine-readable output.',
      cause: err,
    });
    const envelope = errorEnvelope(fallback, args.command, nowFactory);
    if (args.json) {
      stdout(`${JSON.stringify(envelope, null, 2)}\n`);
    } else {
      stderr(formatErrorText(fallback));
    }
    return 1;
  }
}

function envelopeExitCode(status: DotCliEnvelopeStatus): number {
  return status === 'failure' ? 1 : 0;
}

function formatErrorText(err: DotCliError): string {
  return [
    `dot: ${err.code} ${err.message}`,
    `  remediation: ${err.remediation}`,
    `  docs: ${err.docsUrl}`,
    '',
  ].join('\n');
}

/**
 * Re-exports for test consumers and adapter packages.
 */
export { DotCliError, DotCliErrorCode, dotCliDocsUrl };
export type { DotCliEnvelope, DotCliEnvelopeStatus } from './render-explain.js';
export { runNew } from './new.js';
export type { DotNewEnvelope, DotNewOperation } from './json.js';

// Direct-execution guard: only spin up the CLI when this module is the entry
// point, not when it's imported (e.g. by tests).
const isMainModule = await (async () => {
  try {
    // Bun sets `import.meta.main` when running as the entry script.
    if (typeof (import.meta as { main?: boolean }).main === 'boolean') {
      return (import.meta as { main: boolean }).main;
    }
  } catch {
    /* ignore */
  }
  // Node fallback: compare argv[1]'s resolved file URL with import.meta.url.
  // argv[1] is the bin symlink (node_modules/.bin/dot) while Node resolves
  // import.meta.url to the real file — realpath argv[1] so they can match.
  try {
    const entry = process.argv[1];
    if (typeof entry !== 'string') return false;
    const { pathToFileURL } = await import('node:url');
    const { realpath } = await import('node:fs/promises');
    return pathToFileURL(await realpath(entry)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  void main({ argv: process.argv.slice(2) }).then(code => {
    process.exit(code);
  });
}
