/**
 * `demo-check` (T4.2): proves a registered demo still installs, typechecks,
 * tests and builds against a frozen candidate.
 *
 * The demo owns the how: its `arki:candidate <dir>` script copies itself to a
 * temp folder, points the candidate's `@arki/*` packages at their tarballs and
 * prints one JSON report. This module runs that script, parses the report and
 * records `candidate.json.checks["demo:<name>"]`, which demo-impact reads.
 *
 * A demo folder that is not on disk (nested repos are absent in CI clones) is
 * recorded as `deferred`, never as a pass.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import debugFactory from 'debug';
import { z } from 'zod';

import type { CandidateCheckEntry } from './candidate';
import type { ExecRunner } from './runners';
import type { ReleaseCommandEnvelope, ReleaseConfig, ReleaseError } from './types';
import { appendCandidateCheck, readCandidate } from './candidate';
import { createEnvelope } from './json-output';
import { execRunner } from './runners';

const debug = debugFactory('arki:release:demo-check');

export const DEMO_CHECK_ERROR_CODES = {
  /** `--demo` names no demo in `arki.release.config.ts`. */
  unknownDemo: 'DEMOCHK_E001',
  /** A step of the demo's candidate run failed. */
  stepFailed: 'DEMOCHK_E002',
  /** `arki:candidate` printed no report this module can read. */
  noReport: 'DEMOCHK_E003',
  /** The candidate is unreadable or its tarballs changed. */
  candidateUnusable: 'DEMOCHK_E004',
  /** The demo folder is not on disk; the check is deferred. */
  demoMissing: 'DEMOCHK_W001',
} as const;

/** What `bun run arki:candidate <dir>` prints on its last stdout line. */
export const demoCheckReportSchema = z.object({
  steps: z.array(z.object({ id: z.string(), ok: z.boolean(), detail: z.string() })),
});

export type DemoCheckStep = z.infer<typeof demoCheckReportSchema>['steps'][number];

export interface DemoCheckSummary {
  readonly demo: string;
  readonly candidateDir: string;
  readonly outcome: 'passed' | 'failed' | 'skipped';
  readonly message: string;
}

export type DemoCheckEnvelope = ReleaseCommandEnvelope<DemoCheckStep, DemoCheckSummary>;

export interface RunDemoCheckOptions {
  /** Workspace root. */
  readonly cwd: string;
  readonly config: Pick<ReleaseConfig, 'demos'>;
  /** Demo name from `config.demos`. */
  readonly demo: string;
  readonly candidateDir: string;
  /** Runs `bun run arki:candidate`; tests pass a fake. */
  readonly runner?: ExecRunner;
  readonly now?: () => Date;
}

/** The candidate check id demo-impact reads. */
export function demoCheckId(demo: string): string {
  return `demo:${demo}`;
}

/** Last non-empty stdout line: the script's report. Install and test output never reach stdout. */
function parseReport(stdout: string): DemoCheckStep[] | null {
  const line = stdout.trim().split('\n').at(-1) ?? '';
  let json: unknown;
  try {
    json = JSON.parse(line) as unknown;
  } catch {
    return null;
  }
  const parsed = demoCheckReportSchema.safeParse(json);
  return parsed.success ? parsed.data.steps : null;
}

/** Runs the demo's candidate mode and records the result in `candidate.json`. */
export async function runDemoCheck(options: RunDemoCheckOptions): Promise<DemoCheckEnvelope> {
  const { cwd, demo } = options;
  const candidateDir = path.resolve(cwd, options.candidateDir);
  const runner = options.runner ?? execRunner;
  const now = options.now ?? (() => new Date());
  const checkId = demoCheckId(demo);
  const done = (
    status: DemoCheckEnvelope['status'],
    summary: Omit<DemoCheckSummary, 'demo' | 'candidateDir'>,
    items: DemoCheckStep[],
    errors: ReleaseError[],
  ) => createEnvelope({ command: 'demo-check', status, summary: { demo, candidateDir, ...summary }, items, errors });

  const entry = options.config.demos?.find(d => d.name === demo);
  if (entry === undefined) {
    const known = (options.config.demos ?? []).map(d => d.name).join(', ') || 'none';
    const message = `Demo \`${demo}\` is not registered in arki.release.config.ts (registered: ${known}).`;
    return done(
      'failure',
      { outcome: 'failed', message },
      [],
      [
        {
          code: DEMO_CHECK_ERROR_CODES.unknownDemo,
          severity: 'error',
          message,
          target: demo,
          remediation: 'Pass a registered demo name to --demo.',
        },
      ],
    );
  }

  const read = await readCandidate(candidateDir);
  if (!read.ok) {
    return done(
      'failure',
      { outcome: 'failed', message: `Candidate ${candidateDir} is unusable.` },
      [],
      [...read.errors.map(e => ({ ...e, code: DEMO_CHECK_ERROR_CODES.candidateUnusable }))],
    );
  }

  const demoDir = path.resolve(cwd, entry.path);
  if (!existsSync(path.join(demoDir, 'package.json'))) {
    const message = `Demo \`${demo}\` is not on disk at ${entry.path}; its candidate check is deferred.`;
    const envelope = done(
      'warning',
      { outcome: 'skipped', message },
      [],
      [
        {
          code: DEMO_CHECK_ERROR_CODES.demoMissing,
          severity: 'warning',
          message,
          target: demo,
          remediation: `Clone ${entry.repo} to ${entry.path}, then run \`bun release:arki demo-check --demo ${demo} --candidate ${candidateDir}\`.`,
        },
      ],
    );
    return record(candidateDir, checkId, { status: 'deferred', envelope: { reason: message } }, envelope, now);
  }

  debug('running arki:candidate in %s against %s', demoDir, candidateDir);
  const out = await runner('bun', ['run', 'arki:candidate', candidateDir], { cwd: demoDir });
  const steps = parseReport(out.stdout);
  const rerun = `Run \`cd ${entry.path} && bun run arki:candidate ${candidateDir}\` to see the full output.`;
  if (steps === null) {
    const message = `\`bun run arki:candidate\` in ${entry.path} printed no report (exit ${String(out.code)}): ${out.stderr.trim().slice(-300)}`;
    const envelope = done(
      'failure',
      { outcome: 'failed', message },
      [],
      [
        {
          code: DEMO_CHECK_ERROR_CODES.noReport,
          severity: 'error',
          message,
          target: demo,
          remediation: `Check that ${entry.path}/package.json has an \`arki:candidate\` script. ${rerun}`,
        },
      ],
    );
    return record(candidateDir, checkId, { status: 'failure', envelope }, envelope, now);
  }

  const failed = steps.filter(step => !step.ok);
  const passed = steps.length > 0 && failed.length === 0 && out.code === 0;
  const message = passed
    ? `Demo \`${demo}\` passes ${steps.map(s => s.id).join(', ')} against the candidate.`
    : `Demo \`${demo}\` failed against the candidate: ${failed.map(s => s.id).join(', ') || `exit ${String(out.code)}`}.`;
  const errors: ReleaseError[] = failed.map(step => ({
    code: DEMO_CHECK_ERROR_CODES.stepFailed,
    severity: 'error',
    message: `${demo}: ${step.id} failed. ${step.detail.slice(-500)}`,
    target: demo,
    remediation: rerun,
  }));
  const envelope = done(
    passed ? 'success' : 'failure',
    { outcome: passed ? 'passed' : 'failed', message },
    steps,
    errors,
  );
  return record(candidateDir, checkId, { status: passed ? 'success' : 'failure', envelope }, envelope, now);
}

/** Writes the check; a candidate that changed under the run turns the envelope into a failure. */
async function record(
  candidateDir: string,
  checkId: string,
  entry: CandidateCheckEntry,
  envelope: DemoCheckEnvelope,
  now: () => Date,
): Promise<DemoCheckEnvelope> {
  const written = await appendCandidateCheck(candidateDir, checkId, entry, now);
  if (written.ok) return envelope;
  return {
    ...envelope,
    status: 'failure',
    errors: [
      ...envelope.errors,
      ...written.errors.map(e => ({ ...e, code: DEMO_CHECK_ERROR_CODES.candidateUnusable })),
    ],
  };
}
