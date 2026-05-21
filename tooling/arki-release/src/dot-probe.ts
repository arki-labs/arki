/**
 * DOT probe — runs once per scorecard invocation to validate that the
 * `@arki/dot` kernel + CLI surface meet their public contracts.
 *
 * The probe is the third-party verification gate the release plan refers to
 * when it says:
 *
 *   > Stable release is allowed only when [...] DOT `explain --json`
 *   > validates against `DotAppManifest` [and] DOT `doctor --json`
 *   > validates against `DotDiagnosticsSnapshot`.
 *
 * Production: spawns {@link runDotProbe} as a subprocess (so the scorecard's
 * own module graph stays decoupled from `@arki/dot` and its adapters).
 *
 * Tests: pass a synthetic {@link DotProbeResult} via `runScorecard`'s
 * `dotProbe` option to drive deterministic gate outcomes without spawning
 * anything.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import debugFactory from 'debug';

import { defaultProcessRunner, type ProcessRunner } from './fixture';
import type { DotProbeFail, DotProbeOk, DotProbeResult } from './types';

const debug = debugFactory('arki:release:dot-probe');

/** Stable error codes emitted when the probe cannot run. */
export const DOT_PROBE_ERROR_CODES = {
  /** Subprocess exited non-zero. */
  probeFailed: 'DOT_PROBE_E001',
  /** Subprocess emitted invalid JSON. */
  probeBadOutput: 'DOT_PROBE_E002',
} as const;

/** Default location of the probe runner script, relative to this file. */
const DEFAULT_RUNNER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'dot-probe-runner.ts',
);

export interface RunDotProbeOptions {
  /** Workspace root. Used as cwd for the subprocess. */
  readonly rootCwd: string;
  /** Override the runner script path; defaults to colocated `dot-probe-runner.ts`. */
  readonly runnerPath?: string;
  /** Injectable process abstraction; defaults to the production runner. */
  readonly runner?: ProcessRunner;
}

/**
 * Spawn the colocated `dot-probe-runner.ts` via `bun` and parse the
 * structured probe result from stdout.
 *
 * The runner emits a single line of JSON on success and a single line of
 * JSON on failure too — the scorecard does not need to differentiate
 * subprocess exit codes from logical probe failures.
 */
export async function runDotProbe(opts: RunDotProbeOptions): Promise<DotProbeResult> {
  const runner = opts.runner ?? defaultProcessRunner;
  const runnerPath = opts.runnerPath ?? DEFAULT_RUNNER_PATH;
  debug('spawning dot probe: bun %s (cwd=%s)', runnerPath, opts.rootCwd);

  const result = await runner.run('bun', [runnerPath], { cwd: opts.rootCwd });
  // The runner writes JSON to stdout in both success and failure modes. If
  // we can't even parse stdout, the probe is broken at a layer we can't
  // diagnose from here — fall back to a structured failure with the
  // captured stderr so the scorecard's gate can surface it.
  const stdout = result.stdout.trim();
  if (stdout.length === 0) {
    return {
      status: 'fail',
      reason: `DOT probe produced no stdout (exit=${String(result.exitCode)}).`,
      stderr: result.stderr,
    };
  }

  // Pick the LAST JSON line — Bun's startup warnings (and any debug() output)
  // also land on stdout when DEBUG is set, but the runner's final line is
  // always the structured result.
  const lines = stdout.split('\n').filter(line => line.trim().length > 0);
  const lastLine = lines[lines.length - 1];
  if (lastLine === undefined) {
    return {
      status: 'fail',
      reason: `DOT probe stdout had no parseable lines (exit=${String(result.exitCode)}).`,
      stderr: result.stderr,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch (cause) {
    debug('probe stdout was not valid JSON: %s', cause);
    return {
      status: 'fail',
      reason: `DOT probe stdout was not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      stderr: result.stderr,
    };
  }

  if (!isDotProbeResult(parsed)) {
    return {
      status: 'fail',
      reason: 'DOT probe emitted JSON that did not match the DotProbeResult shape.',
      stderr: result.stderr,
    };
  }

  return parsed;
}

/**
 * Type guard that narrows an unknown JSON object to {@link DotProbeResult}.
 * Intentionally permissive — every field is checked but the guard does NOT
 * try to validate every nested shape (the runner is trusted, parsing
 * failures imply a kernel API drift, not a malicious payload).
 */
function isDotProbeResult(value: unknown): value is DotProbeResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.status === 'fail') {
    return typeof v.reason === 'string';
  }
  if (v.status !== 'pass') return false;
  const ok = value as Partial<DotProbeOk>;
  return (
    typeof ok.pipCount === 'number' &&
    typeof ok.manifestArrays === 'number' &&
    typeof ok.diagnosticsArrays === 'number' &&
    typeof ok.explainEnvelopeOk === 'boolean' &&
    typeof ok.doctorEnvelopeOk === 'boolean' &&
    typeof ok.newEnvelopeOk === 'boolean' &&
    typeof ok.newOperationCount === 'number' &&
    Array.isArray(ok.newRequiredFilesPresent) &&
    typeof ok.appState === 'string'
  );
}

/** Re-exported so the scorecard can build synthetic probe results in unit tests. */
export type { DotProbeResult, DotProbeOk, DotProbeFail };
