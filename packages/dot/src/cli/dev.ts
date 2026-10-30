/**
 * `dot dev`: the supervisor. It never serves the app and holds no database
 * connection while the runner runs. One session:
 *
 *   1. claim `.local/dot/dev.json` (another live `dot dev` → refused)
 *   2. the db step (`dev-db.ts`): which database, is it local, is it up
 *   3. the preflight: `dot _preflight` in a fresh process with the runner's
 *      env (`preflight-child.ts`). It imports the app (`dev` export first),
 *      boots it like `dot doctor` (env validation, committed migrations),
 *      disposes it and reports one JSON line: the counts (`app`), the applied
 *      migrations and the doctor verdict. The supervisor never imports the
 *      app, so every restart checks the code and env as they are now.
 *   5. the runner (`dev-runner.ts`), a warm-up `GET /` for Vite and `--run`
 *   6. watch files and keys until `q` or the CLI's abort signal
 *
 * A crash of the runner is reported once and waits for a change or `r`:
 * there is no restart loop.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import type { Mode, Ui } from '@arki/cli';
import type { Failure } from '@arki/failure';
import { AsyncSchema, InvalidEnvelope, isFailure, revive, UnexpectedDefect, ValidatorDefect } from '@arki/failure';
import { getLogger } from '@arki/log';
import { parse } from '@arki/schema';

import type { DbChoice, Exec, Lookup } from './dev-db.js';
import type { DevEvent } from './dev-events.js';
import type { Probe } from './dev-net.js';
import type { RunnerHandle, RunnerKind, RunnerSpec } from './dev-runner.js';
import type { ProjectWatcher, RestartRequest, RestartScheduler } from './dev-watch.js';
import type { DoctorReport } from './failures.js';
import { prepareDb } from './dev-db.js';
import type { RunningConsole } from './dev-console.js';
import { cliExplainRunner, startConsole } from './dev-console.js';
import { openLoopbackHost, pollUntil, probeTcp } from './dev-net.js';
import { chooseRunner, createOutputBuffer, startRunner } from './dev-runner.js';
import { claimDevState, publishConsoleUrl, readDevState, releaseDevState } from './dev-state.js';
import { classifyChange, createRestartScheduler, watchProject } from './dev-watch.js';
import {
  AppImportFailed,
  AppInvalidExport,
  AppLifecycleFailed,
  AppNotFound,
  DevAppStarted,
  DevPortInUse,
  DevPreflightFailed,
  DoctorFailed,
  PreflightFailed,
} from './failures.js';
import { preflightMessageSchema } from './preflight-child.js';
import { renderDoctorText } from './render-doctor.js';

const debugDev = getLogger('arki:dot:cli:dev');

export type RunDevOptions = {
  /** App file (default: discovery's search list). */
  readonly app?: string | undefined;
  readonly cwd?: string | undefined;
  readonly db: DbChoice;
  /** Accept a database that is neither local nor a compose service. Boot migrates it. */
  readonly allowRemoteDb: boolean;
  readonly port: number;
  readonly consolePort: number;
  /** Hand `CONSOLE_PORT` to the runner and announce the console URL once it appears in `dev.json`. */
  readonly console: boolean;
  /** Open the console URL in the browser when it appears. */
  readonly open: boolean;
  /** Stop after the preflight: no runner. */
  readonly once: boolean;
  /** A shell command line that serves the app, instead of Vite or `dot _serve`. */
  readonly run?: string | undefined;
  readonly ui: Ui;
  readonly mode: Mode;
  /** Aborting it ends the session: the runner is stopped, `dev.json` removed. */
  readonly signal: AbortSignal;
  /** Sees every event as it happens; the result lists them all at the end. */
  readonly onEvent?: ((event: DevEvent) => void) | undefined;
  /** The process env, merged over `.env`. Default `process.env`. */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly exec?: Exec | undefined;
  readonly probe?: Probe | undefined;
  readonly lookup?: Lookup | undefined;
  /** How to start the `dot` CLI for `_serve`: the program, then its entry script. Default: this runtime and this CLI. */
  readonly cliEntry?: readonly [string, ...string[]] | undefined;
  /** Where keys are read from in a text-mode terminal. Default `process.stdin`. */
  readonly stdin?: KeyInput | undefined;
  readonly openUrl?: ((url: string) => void) | undefined;
  /** How long the runner gets between SIGTERM and SIGKILL. Default 10 s. */
  readonly stopGraceMs?: number | undefined;
  /** How long one preflight process may run before it is killed and the preflight fails. Default 120 s. */
  readonly preflightTimeoutMs?: number | undefined;
};

/** What `dot dev` succeeds with: every event, so `--output ndjson` prints one per line. */
export type DevResult = { readonly items: DevEvent[] };

/** The CLI entry next to this module: `index.ts` from source, `index.js` from `dist`; under Bun with `--no-env-file`. */
export function defaultCliEntry(
  isBun: boolean = process.versions['bun'] !== undefined,
): readonly [string, ...string[]] {
  const self = fileURLToPath(import.meta.url);
  const entry = path.join(path.dirname(self), `index${path.extname(self)}`);
  // Bun loads the project's `.env` files on its own; the child must get exactly the env `dot dev` prepared.
  return isBun ? [process.execPath, '--no-env-file', entry] : [process.execPath, entry];
}

/** A path relative to the project when it lies inside it, else absolute. */
function displayPath(cwd: string, file: string): string {
  const relative = path.relative(cwd, file);
  return relative === '' || relative.startsWith('..') || path.isAbsolute(relative) ? file : relative;
}

/** Open `url` in the browser. A missing opener is logged, never a failure. */
export function openInBrowser(url: string): void {
  const [command, args]: readonly [string, readonly string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(command, [...args], { stdio: 'ignore', detached: true });
    child.on('error', error => {
      debugDev.debug('could not open the browser with {command}', { command, error });
    });
    child.unref();
  } catch (error) {
    debugDev.debug('could not open the browser with {command}', {
      command,
      error: error instanceof Error ? error : String(error),
    });
  }
}

type PreflightEvent = Extract<DevEvent, { readonly kind: 'preflight' }>;

/** Every issue code of a report, once each, in order. */
function issueCodes(report: DoctorReport): string[] {
  const lists = [
    report.issues,
    ...report.plugins.map(entry => entry.issues),
    ...report.actions.map(entry => entry.issues),
    ...report.services.map(entry => entry.issues),
    ...report.lifecycle.map(entry => entry.issues),
  ];
  return [...new Set(lists.flatMap(issues => issues.map(issue => issue.code)))];
}

type MigrationsEvent = Extract<DevEvent, { readonly kind: 'migrations' }>;
type AppEvent = Extract<DevEvent, { readonly kind: 'app' }>;

type Preflight = {
  /** The checked app (absolute file) and its counts; null when discovery or configure failed. */
  readonly app: (Omit<AppEvent, 'kind'> & { readonly file: string }) | null;
  /** What the preflight boot applied, when the app runs `dbMigrations`. */
  readonly migrations: MigrationsEvent | null;
  readonly event: PreflightEvent;
  readonly report: DoctorReport | null;
  readonly failure: Failure | null;
};

/** The failures `dot _preflight` can report, for `revive`. */
const PREFLIGHT_FAILURES = [
  AppNotFound,
  AppInvalidExport,
  AppImportFailed,
  AppLifecycleFailed,
  DevAppStarted,
  DoctorFailed,
] as const;

const envelopeSchema = z.union([
  z.looseObject({ ok: z.literal(true), data: preflightMessageSchema }),
  z.looseObject({
    ok: z.literal(false),
    error: z.looseObject({ code: z.literal(PreflightFailed.code), data: preflightMessageSchema }),
  }),
]);

/** The report line: the last output line that is a valid `_preflight` envelope. */
function findReport(lines: readonly string[]): z.infer<typeof preflightMessageSchema> | null {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? '';
    if (!line.startsWith('{')) continue;
    try {
      const parsed = envelopeSchema.safeParse(JSON.parse(line));
      if (parsed.success) return parsed.data.ok ? parsed.data.data : parsed.data.error.data;
    } catch {
      // Not JSON: app output.
    }
  }
  return null;
}

function preflightFailed(reason: string, exitCode: number | null, lines: readonly string[]): Preflight {
  const failure = DevPreflightFailed({ reason, exitCode, output: lines.slice(-20) });
  return {
    app: null,
    migrations: null,
    event: { kind: 'preflight', status: 'failure', codes: [failure.code] },
    report: null,
    failure,
  };
}

/** Turn the child's report into the supervisor's view. A report that does not check out is a failed preflight. */
function fromMessage(message: z.infer<typeof preflightMessageSchema>, lines: readonly string[]): Preflight {
  const report = message.report === null ? null : parse(DoctorFailed.dataSchema, message.report);
  if (isFailure(report)) return preflightFailed(report.message, null, lines);
  let failure: Failure | null = null;
  if (message.failure !== null) {
    const revived = revive(message.failure, PREFLIGHT_FAILURES);
    if (
      revived === undefined ||
      InvalidEnvelope.is(revived) ||
      AsyncSchema.is(revived) ||
      ValidatorDefect.is(revived) ||
      UnexpectedDefect.is(revived)
    ) {
      failure = PreflightFailed(message);
    } else {
      failure = revived;
    }
  }
  const migrations: MigrationsEvent | null =
    message.migrations === null ? null : { kind: 'migrations', pending: message.migrations };
  if (failure !== null) {
    const codes = report === null ? [message.failure?.code ?? failure.code] : issueCodes(report);
    return { app: message.app, migrations, event: { kind: 'preflight', status: 'failure', codes }, report, failure };
  }
  const status = report === null || report.status === 'success' ? 'ok' : report.status;
  return {
    app: message.app,
    migrations,
    event: { kind: 'preflight', status, codes: report === null ? [] : issueCodes(report) },
    report,
    failure: null,
  };
}

/**
 * One preflight in a fresh process: `dot _preflight` with the runner's env.
 * A crash, a hang past `timeoutMs` or output without a valid report is a
 * failed preflight (`dot.dev_preflight_failed`), never a pass. An abort of
 * `signal` (the session's stop) kills it.
 */
async function preflightProcess(options: {
  readonly cwd: string;
  readonly app: string | undefined;
  readonly cliEntry: readonly [string, ...string[]];
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly onLine: (line: string) => void;
}): Promise<Preflight> {
  const [file, ...entryArgs] = options.cliEntry;
  const args = [
    ...entryArgs,
    '_preflight',
    '--cwd',
    options.cwd,
    ...(options.app === undefined ? [] : ['--app', options.app]),
    '--output',
    'json',
  ];
  const lines: string[] = [];
  const handle = await startRunner(
    { command: 'dot _preflight', file, args, shell: false },
    {
      cwd: options.cwd,
      env: options.env,
      onLine: line => {
        lines.push(line);
      },
    },
  );
  if (isFailure(handle)) return preflightFailed(handle.message, null, lines);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, options.timeoutMs);
  });
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<'aborted'>(resolve => {
    onAbort = () => {
      resolve('aborted');
    };
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const outcome = await Promise.race([handle.exited, timedOut, aborted]);
    if (outcome === 'timeout' || outcome === 'aborted') {
      await handle.stop(0);
      return preflightFailed(
        outcome === 'timeout' ? `no report within ${String(options.timeoutMs)} ms` : 'dot dev stopped',
        null,
        lines,
      );
    }
    const message = findReport(lines);
    // Everything but the report line is the app's own output.
    for (const line of lines) if (!line.trim().startsWith('{"ok"')) options.onLine(line);
    if (message === null) {
      return preflightFailed(
        outcome.code === 0 ? 'it printed no valid report' : 'it exited without a report',
        outcome.code,
        lines,
      );
    }
    // Exit 3 accompanies a failed report; other nonzero exits still indicate a child crash.
    if (outcome.code !== 0 && !(outcome.code === 3 && message.failure !== null)) {
      return preflightFailed(`it exited with code ${String(outcome.code)} after its report`, outcome.code, lines);
    }
    try {
      return fromMessage(message, lines);
    } catch {
      return preflightFailed('its report did not check out', outcome.code, lines);
    }
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) options.signal.removeEventListener('abort', onAbort);
    // Also reaps anything the child left in its process group, and drops the exit hook.
    await handle.stop(0);
  }
}

function describeEvent(event: DevEvent): string {
  switch (event.kind) {
    case 'app': {
      return `app (${event.file}, export ${event.exportName})  graph: ${String(event.plugins)} units, ${String(event.features)} features`;
    }
    case 'db': {
      return event.driver === 'pglite'
        ? 'db: pglite (embedded)'
        : `db: pg ${event.target}${event.owned ? ' (compose service started by dot dev)' : ''}`;
    }
    case 'migrations': {
      return event.pending.length === 0
        ? 'migrations: up to date'
        : `migrations: ${String(event.pending.length)} pending (${event.pending.join(', ')}), applied by the preflight`;
    }
    case 'preflight': {
      if (event.status === 'ok') return 'preflight: doctor OK';
      if (event.status === 'warning') return `preflight: doctor OK with warnings (${event.codes.join(', ')})`;
      return `preflight: doctor failed (${event.codes.join(', ')})`;
    }
    case 'runner': {
      return `runner: ${event.command} (pid ${String(event.pid)})`;
    }
    case 'console': {
      return `console: ${event.url}`;
    }
    case 'restart': {
      return `restart: ${event.path ?? (event.reason === 'key' ? 'key r' : event.reason)}`;
    }
    case 'exit': {
      return `stopped (code ${String(event.code)})`;
    }
  }
}

/** What keys are read from: the parts of `process.stdin` `dot dev` uses. */
export type KeyInput = {
  readonly isTTY?: boolean | undefined;
  setRawMode?(mode: boolean): unknown;
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
};

/** Raw-mode key reading on a text-mode terminal. Returns the cleanup, or null when keys are off. */
function readKeys(stdin: KeyInput, onKey: (key: string) => void): (() => void) | null {
  if (stdin.isTTY !== true || typeof stdin.setRawMode !== 'function') return null;
  const onData = (chunk: Buffer | string): void => {
    for (const key of chunk.toString()) onKey(key);
  };
  stdin.setRawMode(true);
  try {
    stdin.on('data', onData);
    stdin.resume();
  } catch (error) {
    stdin.setRawMode(false);
    throw error;
  }
  return () => {
    stdin.off('data', onData);
    stdin.setRawMode?.(false);
    stdin.pause();
  };
}

/**
 * Run one `dot dev` session. Returns every event, or the failure that
 * stopped it before the runner ran (discovery, `dev.json`, db, preflight,
 * runner). Failures after the start are printed and the session waits for
 * a change.
 */
export async function runDev(options: RunDevOptions): Promise<DevResult | Failure> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const { ui } = options;
  const events: DevEvent[] = [];
  const emit = (event: DevEvent): void => {
    events.push(event);
    options.onEvent?.(event);
    ui.info(`dot dev ▸ ${describeEvent(event)}`);
  };

  const claimed = await claimDevState(cwd);
  if (isFailure(claimed)) return claimed;
  try {
    return await supervise({
      ...options,
      cwd,
      stateFile: claimed.file,
      events,
      emit,
    });
  } finally {
    await releaseDevState(claimed.file);
  }
}

type SessionOptions = RunDevOptions & {
  readonly cwd: string;
  readonly stateFile: string;
  readonly events: DevEvent[];
  readonly emit: (event: DevEvent) => void;
};

async function supervise(session: SessionOptions): Promise<DevResult | Failure> {
  // Ends the session: the CLI's abort, or `q`.
  const sessionAbort = new AbortController();
  const onAbort = (): void => {
    sessionAbort.abort();
  };
  if (session.signal.aborted) sessionAbort.abort();
  else session.signal.addEventListener('abort', onAbort, { once: true });
  try {
    return await superviseUntilQuit(session, sessionAbort);
  } finally {
    session.signal.removeEventListener('abort', onAbort);
  }
}

async function superviseUntilQuit(
  session: SessionOptions,
  sessionAbort: AbortController,
): Promise<DevResult | Failure> {
  const { cwd, ui, emit } = session;
  const signal = sessionAbort.signal;
  const probe = session.probe ?? probeTcp;
  const graceMs = session.stopGraceMs ?? 10_000;
  let lastReport: DoctorReport | null = null;
  const cliEntry = session.cliEntry ?? defaultCliEntry();
  /** The app file the first preflight found: later preflights and the runner use it. An object: set inside `prepare`. */
  const found: { appFile: string | null } = { appFile: null };

  /** The env the preflight and the runner get: the prepared env plus the `dot dev` keys. */
  const childEnv = (base: Readonly<Record<string, string>>): Record<string, string> => ({
    ...base,
    DOT_DEV: '1',
    PORT: String(session.port),
    DOT_DEV_STATE: session.stateFile,
    ...(session.console ? { CONSOLE_PORT: String(session.consolePort) } : {}),
  });

  /** The db step and the preflight. A failed preflight prints the doctor text. */
  const prepare = async (): Promise<{ readonly env: Readonly<Record<string, string>> } | Failure> => {
    const db = await prepareDb({
      cwd,
      db: session.db,
      allowRemoteDb: session.allowRemoteDb,
      env: session.env ?? process.env,
      exec: session.exec,
      probe,
      lookup: session.lookup,
      signal,
      info: line => {
        ui.info(line);
      },
    });
    if (isFailure(db)) return db;
    const checked = await preflightProcess({
      cwd,
      app: found.appFile ?? session.app,
      cliEntry,
      env: childEnv(db.env),
      timeoutMs: session.preflightTimeoutMs ?? 120_000,
      signal,
      onLine: line => {
        ui.info(`[preflight] ${line}`);
      },
    });
    // The counts come from the child, so the first `app` event follows the preflight; the order of events is kept.
    if (found.appFile === null && checked.app !== null) {
      found.appFile = checked.app.file;
      emit({ kind: 'app', ...checked.app, file: displayPath(cwd, checked.app.file) });
    }
    emit(db.event);
    lastReport = checked.report;
    if (checked.migrations !== null) emit(checked.migrations);
    emit(checked.event);
    if (checked.failure !== null) {
      if (checked.report === null) ui.info(`dot dev ▸ ${checked.failure.code} ${checked.failure.message}`);
      else renderDoctorText(checked.report, ui);
      return checked.failure;
    }
    return { env: db.env };
  };

  const first = await prepare();
  if (isFailure(first) || session.once || signal.aborted) return isFailure(first) ? first : { items: session.events };
  if (found.appFile === null) return DevPreflightFailed({ reason: 'it named no app file', exitCode: null, output: [] });
  const projectAppFile = found.appFile;

  const spec = await chooseRunner({
    cwd,
    run: session.run,
    port: session.port,
    appFile: projectAppFile,
    cliEntry,
  });
  if (isFailure(spec)) return spec;

  const output = createOutputBuffer();
  let env = first.env;
  // Read and written by the restart closures, so kept in one object: no stale narrowing.
  const state: { runner: RunnerHandle | null; crashCode: number | null } = { runner: null, crashCode: null };
  const quitting = (): boolean => signal.aborted;
  const stopRunner = async (): Promise<void> => {
    const current = state.runner;
    state.runner = null;
    await current?.stop(graceMs);
  };

  const warmUp = async (kind: RunnerKind): Promise<void> => {
    if (kind === 'serve') return;
    const listening = await pollUntil(async () => (await openLoopbackHost(session.port, probe)) !== null, {
      intervalMs: 250,
      timeoutMs: 60_000,
      signal,
    });
    const host = listening && !quitting() ? await openLoopbackHost(session.port, probe) : null;
    if (host === null) return;
    const origin = host === '::1' ? `http://[::1]:${String(session.port)}` : `http://${host}:${String(session.port)}`;
    try {
      const response = await fetch(`${origin}/`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
      });
      await response.body?.cancel();
      ui.info(`dot dev ▸ warm-up: GET / ${String(response.status)}`);
    } catch (error) {
      debugDev.debug('warm-up GET / failed', { error: error instanceof Error ? error : String(error) });
    }
  };

  const launch = async (runnerSpec: RunnerSpec): Promise<RunnerHandle | Failure> => {
    if ((await openLoopbackHost(session.port, probe)) !== null) return DevPortInUse({ port: session.port });
    const handle = await startRunner(runnerSpec, {
      cwd,
      env: childEnv(env),
      onLine: line => {
        output.push(line);
        ui.info(`[app] ${line}`);
      },
    });
    if (isFailure(handle)) return handle;
    state.crashCode = null;
    emit({ kind: 'runner', command: runnerSpec.command, pid: handle.pid });
    void handle.exited.then(exit => {
      if (handle.stopping || quitting()) return;
      state.crashCode = exit.code ?? 1;
      ui.info(
        exit.code === 0
          ? 'dot dev ▸ app exited (code 0); waiting for a change or r'
          : `dot dev ▸ app crashed (code ${exit.code === null ? String(exit.signal) : String(exit.code)}); waiting for a change or r`,
      );
    });
    void warmUp(runnerSpec.kind);
    return handle;
  };

  const started = await launch(spec);
  if (isFailure(started)) return started;
  state.runner = started;

  // From here on a runner may live: everything below is undone in the `finally`, even when it throws.
  let watcher: ProjectWatcher | undefined;
  let consolePoll: ReturnType<typeof setInterval> | undefined;
  let runningConsole: RunningConsole | undefined;
  let stopKeys: (() => void) | null = null;
  let scheduler: RestartScheduler | undefined;
  const removeSignalHandlers = handleProcessSignals(sessionAbort, () => state.runner);
  try {
    const restart = async (request: RestartRequest): Promise<void> => {
      if (quitting()) return;
      emit({ kind: 'restart', reason: request.reason, ...(request.path === undefined ? {} : { path: request.path }) });
      await stopRunner();
      if (request.kind === 'full') {
        const prepared = await prepare();
        if (isFailure(prepared)) {
          ui.warn(`${prepared.code} ${prepared.message}; waiting for a change`);
          return;
        }
        env = prepared.env;
      }
      if (quitting()) return;
      const next = await launch(spec);
      if (isFailure(next)) {
        ui.warn(`${next.code} ${next.message}; waiting for a change or r`);
        return;
      }
      state.runner = next;
    };
    const restarts = createRestartScheduler(restart, error => {
      ui.warn(`restart failed: ${error instanceof Error ? error.message : String(error)}; waiting for a change or r`);
    });
    scheduler = restarts;

    const appRelative = path.relative(cwd, projectAppFile).split(path.sep).join('/');
    watcher = watchProject({
      cwd,
      appFile: appRelative,
      onChanges: paths => {
        const kinds = paths.map(changed => ({
          path: changed,
          kind: classifyChange(changed, { appFile: appRelative, runner: spec.kind }),
        }));
        const strongest = kinds.find(entry => entry.kind === 'full') ?? kinds.find(entry => entry.kind === 'runner');
        if (strongest === undefined || strongest.kind === 'ignore') return;
        restarts.request({ kind: strongest.kind, reason: 'file', path: strongest.path });
      },
    });

    let consoleUrl: string | null = null;
    let opened = false;
    let polling = false;
    if (session.console) {
      const started = await startConsole({
        port: session.consolePort,
        explain: cliExplainRunner({ cliEntry, cwd, appFile: projectAppFile, env: () => childEnv(env) }),
      });
      if ('message' in started) ui.warn(`dot dev ▸ ${started.message}`);
      else {
        runningConsole = started;
        await publishConsoleUrl(session.stateFile, started.url);
      }
      consolePoll = setInterval(() => {
        if (polling) return;
        polling = true;
        void readDevState(session.stateFile)
          .then(devState => {
            const url = devState?.console?.url;
            if (url === undefined || url === consoleUrl) return;
            consoleUrl = url;
            emit({ kind: 'console', url });
            if (session.open && !opened) {
              opened = true;
              (session.openUrl ?? openInBrowser)(url);
            }
          })
          .finally(() => {
            polling = false;
          });
      }, 250);
    }

    const quit = new Promise<void>(resolve => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
    if (session.mode === 'text') {
      stopKeys = readKeys(session.stdin ?? process.stdin, key => {
        switch (key) {
          case 'q':
          case '\u0003': {
            // Ctrl-C: raw mode turns it into a key instead of SIGINT.
            sessionAbort.abort();
            break;
          }
          case 'r': {
            restarts.request({ kind: 'runner', reason: 'key' });
            break;
          }
          case 'c': {
            if (consoleUrl === null) ui.info('dot dev ▸ console: not running');
            else (session.openUrl ?? openInBrowser)(consoleUrl);
            break;
          }
          case 'd': {
            // The last preflight report: booting again would fight the runner for the PGlite directory.
            if (lastReport === null) ui.info('dot dev ▸ no doctor report yet');
            else renderDoctorText(lastReport, ui);
            break;
          }
        }
      });
    }
    ui.info(
      `dot dev ▸ watching src/, drizzle/, .env${stopKeys === null ? '' : ' — q quit · r restart · c console · d doctor'}`,
    );
    await quit;
  } finally {
    // Stops everything new restarts could come from before waiting for the running one.
    sessionAbort.abort();
    clearInterval(consolePoll);
    await runningConsole?.close();
    watcher?.close();
    stopKeys?.();
    await scheduler?.idle();
    await stopRunner();
    removeSignalHandlers();
    debugDev.debug('session over; {dropped} output lines were dropped', { dropped: output.dropped });
  }
  emit({ kind: 'exit', code: state.crashCode ?? 0 });
  return { items: session.events };
}

const FORWARDED_SIGNALS = ['SIGHUP', 'SIGINT', 'SIGTERM'] as const;

/**
 * Signals while a runner may live. `@arki/cli` turns the first SIGINT and
 * SIGTERM into the abort, once; nothing handles SIGHUP (a closed terminal)
 * or a second Ctrl-C, whose default would kill this process and orphan the
 * runner's group. The first signal stops the session normally; any later one
 * SIGKILLs the runner's group at once and exits with 128 + its number.
 * Returns the function that removes the handlers.
 */
function handleProcessSignals(sessionAbort: AbortController, runner: () => RunnerHandle | null): () => void {
  let received = false;
  const onSignal = (name: NodeJS.Signals): void => {
    if (!received) {
      received = true;
      sessionAbort.abort();
      return;
    }
    runner()?.kill();
    process.exit(128 + os.constants.signals[name]);
  };
  for (const name of FORWARDED_SIGNALS) process.on(name, onSignal);
  return () => {
    for (const name of FORWARDED_SIGNALS) process.off(name, onSignal);
  };
}
