#!/usr/bin/env bun

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

import { createDebugLogger } from '@arki/logger/debug';

import type { DotApp, DotAppBuilder, DotAppConfigured } from '../define-app';
import type { DiagnosticIssue } from '../diagnostics';
import type { DiscoveredApp } from './discover';
import type { DotCliEnvelope, DotCliEnvelopeStatus } from './render-explain';
import { DotLifecycleError } from '../lifecycle';
import { discoverApp, guards } from './discover';
import { DotCliError, DotCliErrorCode, dotCliDocsUrl } from './error-codes';
import { renderDoctor } from './render-doctor';
import { renderExplain } from './render-explain';

const debugCli = createDebugLogger('arki:dot:cli');

const VERSION = '0.1.0';

const HELP_TEXT = `dot — CLI for inspecting DOT apps

Usage:
  dot <command> [options]

Commands:
  explain    Print the static app graph (manifest)
  doctor     Boot the app and print runtime diagnostics

Options:
  --json         Emit a JSON envelope to stdout (default: human-readable text)
  --app <path>   Path to the app entry file (default: discovers ./dot.config.ts,
                 ./src/app.ts, or ./app.ts)
  --cwd <dir>    Working directory (default: current)
  --help         Show this help and exit
  --version      Print version and exit
`;

export type CliArgs = {
  command: 'explain' | 'doctor' | 'help' | 'version';
  json: boolean;
  appPath?: string;
  cwd?: string;
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
      if (cmd === 'explain' || cmd === 'doctor' || cmd === 'help' || cmd === 'version') {
        command = cmd;
        rest.splice(i, 1);
        break;
      }
      throw new DotCliError({
        code: DotCliErrorCode.UnknownCommand,
        message: `Unknown command: ${cmd}`,
        remediation: `Use one of: explain, doctor. Run \`dot --help\` for usage.`,
        metadata: { received: cmd },
      });
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
  };

  if (values.help) command = 'help';
  if (values.version) command = 'version';

  if (!command) command = 'help';

  return {
    command,
    json: values.json ?? false,
    appPath: values.app,
    cwd: values.cwd,
  };
}

/** Discovery wrapper — returns `null` for help/version commands. */
async function loadApp(args: CliArgs): Promise<DiscoveredApp> {
  const { app } = await discoverApp({ appPath: args.appPath, cwd: args.cwd });
  return app;
}

/**
 * Run `explain` on a discovered app.
 * Pure dependency on a `DiscoveredApp` so tests can pass synthetic values.
 */
export async function runExplain(
  discovered: DiscoveredApp,
  opts: { json: boolean; out?: (line: string) => void; now?: () => Date },
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

  return renderExplain({ manifest: configured.manifest }, { json: opts.json, out: opts.out, now: opts.now });
}

type DoctorRunOptions = {
  json: boolean;
  out?: (line: string) => void;
  now?: () => Date;
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
    return renderDoctor({ diagnostics: app.diagnostics }, { json: opts.json, out: opts.out, now: opts.now });
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
    const diagnostics = bootedApp ? bootedApp.diagnostics : configured.diagnostics;
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

  try {
    const discovered = await loadApp(args);
    const opts = { json: args.json, out: stdout, now: nowFactory };
    let envelope: DotCliEnvelope<unknown>;

    if (args.command === 'explain') {
      envelope = await runExplain(discovered, opts);
    } else {
      envelope = await runDoctor(discovered, opts);
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
export type { DotCliEnvelope, DotCliEnvelopeStatus } from './render-explain';

// Direct-execution guard: only spin up the CLI when this module is the entry
// point, not when it's imported (e.g. by tests).
const isMainModule = (() => {
  try {
    // Bun sets `import.meta.main` when running as the entry script. Node
    // does not, so we fall back to comparing argv[1] with this file URL.
    if (typeof (import.meta as { main?: boolean }).main === 'boolean') {
      return (import.meta as { main: boolean }).main;
    }
  } catch {
    /* ignore */
  }
  return false;
})();

if (isMainModule) {
  void main({ argv: process.argv.slice(2) }).then(code => {
    process.exit(code);
  });
}
