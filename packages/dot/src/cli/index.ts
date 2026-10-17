#!/usr/bin/env node

/**
 * `dot` CLI entry point, built on `@arki/cli`.
 *
 *   - `dot explain`    print the static app graph (manifest); never boots
 *   - `dot doctor`     boot the app and print runtime diagnostics
 *   - `dot new <name>` scaffold a DOT app
 *   - `dot dev`        run the app in development: db, preflight, runner, watch
 *   - `dot _serve`     (hidden) start the app until stopped: the runner of `dot dev`
 *   - `dot _preflight` (hidden) one preflight boot in a fresh process, reported as JSON to `dot dev`
 *
 * Output is text on a terminal and the `arki.cli/1` JSON envelope when piped
 * or with `--json`. Exit codes: 0 ok, 1 bug, 2 usage (unknown command,
 * invalid input), 3 a returned failure (`dot.*`). Each command module loads
 * only when that command runs.
 */
import { defineCli, run } from '@arki/cli';

import { DOT_CLI_DOCS_URL } from './failures.js';
import { readDotVersion } from './versions.js';

/** The `dot` program. `program.main(argv, io)` runs one command line without touching the process. */
export const program = defineCli({
  name: 'dot',
  version: readDotVersion(),
  describe: 'Inspect and scaffold DOT apps',
  docsUrl: DOT_CLI_DOCS_URL,
  commands: {
    explain: () => import('./commands/explain.js'),
    doctor: () => import('./commands/doctor.js'),
    new: () => import('./commands/new.js'),
    dev: () => import('./commands/dev.js'),
    _serve: () => import('./commands/serve.js'),
    _preflight: () => import('./commands/preflight.js'),
  },
});

export { runDev } from './dev.js';
export type { DevResult, RunDevOptions } from './dev.js';
export { devEventSchema } from './dev-events.js';
export type { DevEvent } from './dev-events.js';
export { DEV_STATE_PATH, devStateSchema } from './dev-state.js';
export type { DevState } from './dev-state.js';
export { runDoctor } from './doctor.js';
export type { DoctorOptions } from './doctor.js';
export { runExplain } from './explain.js';
export type { ExplainData, ExplainOptions } from './explain.js';
export {
  AppImportFailed,
  AppInvalidExport,
  AppLifecycleFailed,
  AppNotFound,
  DevAlreadyRunning,
  DevAppStarted,
  DevDbUnreachable,
  DevPortInUse,
  DevPreflightFailed,
  DevRemoteDbRefused,
  DevRunnerFailed,
  DoctorFailed,
  ObservabilityNoSdk,
  ProjectionConflict,
  ProjectionExecutionFailed,
  ProjectionImportFailed,
  ProjectionNotFound,
  TargetNotEmpty,
  TemplateMissing,
  WriteFailed,
} from './failures.js';
export type { DoctorReport, DoctorStatus } from './failures.js';
export type { DotNewOperation, DotNewResult } from './json.js';
export { runNew } from './new.js';
export type { RunNewOptions } from './new.js';
export type { GraphData } from './render-graph.js';
export type { ProjectionData } from './render-projection.js';

// Direct-execution guard: only run the CLI when this module is the entry
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

if (isMainModule) await run(program);
