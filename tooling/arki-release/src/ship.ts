/**
 * `ship`: one command that takes a wave to a founder packet.
 *
 *   ship --wave <id> [--dry-run]
 *     order -> refuse foreign changesets -> `changeset version` -> build,
 *     then stop with SHIP_E001 and the exact commit line. The tool never
 *     commits: agents and the founder commit by pathspec.
 *   ship --wave <id> --resume
 *     candidate -> smoke -> doc examples -> demo checks -> scorecard
 *     --candidate, then the packet: `npm publish` lines for the frozen
 *     tarballs, expected versions, `npm view` verify lines, the finish line.
 *   ship --finish --candidate <dir>   (founder only)
 *     verifies each version on npm by `dist.integrity`, records `shipped`,
 *     writes the ledger entry, runs the mirror sync, prints demo pin bumps.
 *
 * `ship` never runs `npm publish`, `git push` or `git commit` (founder
 * decisions A-26/A-27). Every external effect goes through an injected
 * runner or step, so tests can prove it.
 */

import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import debugFactory from 'debug';
import { z } from 'zod';

import {
  appendCandidateCheck,
  docsCheckId,
  readCandidate,
  runCandidate,
  type Candidate,
  type CandidateCheckEntry,
  type DocsCheck,
} from './candidate';
import { demosUsing, loadDemos } from './demos';
import { docExamplesReportSchema } from './docs-fresh';
import { checkBumps, loadChangesets } from './impact';
import { discoverManifests } from './inventory';
import { createEnvelope } from './json-output';
import { LEDGER_PATH, renderLedgerEntry, writeLedgerEntry } from './ledger';
import { runOrder } from './order';
import { defaultGitRunner, defaultNpmRunner, execRunner, type ExecRunner, type GitRunner, type NpmRunner } from './runners';
import { runScorecard } from './scorecard';
import { runSmoke } from './smoke';
import type { ReleaseCommandEnvelope, ReleaseConfig, ReleaseError, ReleaseStatus } from './types';

const debug = debugFactory('arki:release:ship');

export const SHIP_ERROR_CODES = {
  /** Versions bumped and built; the orchestrator must commit, then `--resume`. */
  commitNeeded: 'SHIP_E001',
  /** A changeset bumps a package outside the wave's publish set. */
  foreignChangeset: 'SHIP_E002',
  /** `changeset version`, the build or `test:docs` failed to run. */
  stepFailed: 'SHIP_E003',
  /** `--finish` refused: it is founder-only (CLAUDECODE set or stdin not a TTY). */
  founderOnly: 'SHIP_E004',
  /** npm has the version with a different `dist.integrity` than the candidate tarball. */
  integrityMismatch: 'SHIP_E005',
  /** The version is not on npm yet: the founder has not published it. */
  notPublished: 'SHIP_E006',
  /** A candidate check failed; no packet was written. */
  checksFailed: 'SHIP_E007',
  /** Bad flags, unknown wave, or nothing to release. */
  usage: 'SHIP_E008',
  /** The mirror sync failed or is not wired yet. */
  syncFailed: 'SHIP_E009',
  /** `npm view` failed for another reason (network, auth). */
  npmViewFailed: 'SHIP_E010',
} as const;

export const PACKET_FILE = 'packet.md';
const DEMO_DEFERRED_REASON = 'demo candidate mode lands in T4.2';

export const SHIP_STEP_STATUSES = ['done', 'planned', 'skipped', 'deferred', 'failed'] as const;
export type ShipStepStatus = (typeof SHIP_STEP_STATUSES)[number];

export interface ShipStep {
  readonly id: string;
  readonly status: ShipStepStatus;
  readonly detail: string;
}

export type ShipPhase = 'start' | 'resume' | 'finish';

export interface ShipSummary {
  readonly message: string;
  readonly phase: ShipPhase;
  readonly wave: string | null;
  readonly candidateDir: string | null;
  readonly packet: string | null;
  /** The exact command to run next, if any. */
  readonly next: string | null;
}

export type ShipEnvelope = ReleaseCommandEnvelope<ShipStep, ShipSummary>;

/** The mirror sync, injected so `ship` builds without T1.7 and tests never touch GitHub. */
export type SyncApply = (candidateDir: string) => Promise<ReleaseCommandEnvelope<unknown>>;

/** Every effect `ship` can have. Tests replace them all. */
export interface ShipDeps {
  /** `bun .../changeset version`, `turbo run build`, `bun run test:docs`. */
  readonly exec: ExecRunner;
  readonly npm: NpmRunner;
  readonly git: GitRunner;
  readonly order: typeof runOrder;
  readonly candidate: typeof runCandidate;
  readonly smoke: typeof runSmoke;
  readonly scorecard: typeof runScorecard;
  /** Absent until T1.7 wires `sync --apply`; `--finish` then reports the sync as deferred. */
  readonly syncApply?: SyncApply;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Whether stdin is a terminal (a person, not a pipe or an agent). */
  readonly isTTY: boolean;
  readonly now: () => Date;
}

export type ShipMode =
  | { readonly kind: 'start'; readonly wave: string; readonly dryRun: boolean }
  | { readonly kind: 'resume'; readonly wave: string; readonly dryRun: boolean }
  | { readonly kind: 'finish'; readonly candidateDir: string };

export interface ShipOptions {
  /** Workspace root. */
  readonly cwd: string;
  readonly config: ReleaseConfig;
  readonly mode: ShipMode;
  readonly allowDemoLag?: string;
  readonly allowDeferred?: boolean;
  readonly deps?: Partial<ShipDeps>;
}

const defaultDeps: ShipDeps = {
  exec: execRunner,
  npm: defaultNpmRunner,
  git: defaultGitRunner,
  order: runOrder,
  candidate: runCandidate,
  smoke: runSmoke,
  scorecard: runScorecard,
  env: process.env,
  isTTY: process.stdin.isTTY === true,
  now: () => new Date(),
};

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** The `dist.integrity` npm reports for a tarball with this hex sha512. */
export function integrityOf(sha512Hex: string): string {
  return `sha512-${Buffer.from(sha512Hex, 'hex').toString('base64')}`;
}

/** The commit line the orchestrator runs between `ship` and `ship --resume`. */
export function commitLine(paths: readonly string[]): string {
  const quoted = paths.map(p => (/^[\w@./-]+$/.test(p) ? p : `'${p}'`));
  return `git -c commit.gpgsign=false commit -- ${quoted.join(' ')}`;
}

export function finishCommand(candidateDir: string): string {
  return `bun release:arki ship --finish --candidate ${candidateDir}`;
}

/** The founder packet. Publish lines use the frozen tarballs, so the bytes published are the bytes checked. */
export function renderPacket(input: { readonly cwd: string; readonly candidateDir: string; readonly candidate: Candidate }): string {
  const { candidate, candidateDir } = input;
  const packages = [...candidate.packages].sort((a, b) => a.publishOrder - b.publishOrder);
  return [
    `# Release packet: ${candidate.wave} @ ${candidate.sourceCommit.slice(0, 7)}`,
    '',
    `Candidate: \`${candidateDir}\``,
    `Source commit: \`${candidate.sourceCommit}\``,
    '',
    '## 1. Publish, in this order, from /tmp',
    '',
    'Run each line once. npm 2FA can look stalled: check with step 3 before retrying a line.',
    '',
    '```sh',
    'cd /tmp',
    ...packages.map(p => `npm publish --access public ${path.join(candidateDir, p.tarball)}`),
    '```',
    '',
    '## 2. Expected versions',
    '',
    '| Order | Package | Version | dist.integrity |',
    '| ----- | ------- | ------- | -------------- |',
    ...packages.map(p => `| ${String(p.publishOrder)} | ${p.name} | ${p.version} | \`${integrityOf(p.sha512)}\` |`),
    '',
    '## 3. Verify, from /tmp',
    '',
    '```sh',
    'cd /tmp',
    ...packages.map(p => `npm view ${p.name}@${p.version} version dist.integrity`),
    '```',
    '',
    '## 4. Finish (records the ship, writes the ledger, syncs the mirror)',
    '',
    '```sh',
    `cd ${input.cwd} && ${finishCommand(candidateDir)}`,
    '```',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function runShip(options: ShipOptions): Promise<ShipEnvelope> {
  const deps: ShipDeps = { ...defaultDeps, ...options.deps };
  const { mode } = options;
  if (mode.kind === 'finish') return finish(options, mode.candidateDir, deps);
  const wave = options.config.waves.find(w => w.id === mode.wave);
  if (wave === undefined) {
    const message = `Wave \`${mode.wave}\` is not in arki.release.config.ts.`;
    return result('failure', mode.kind, mode.wave, [], {
      message,
      errors: [shipError(SHIP_ERROR_CODES.usage, message, `Use one of: ${options.config.waves.map(w => w.id).join(', ')}.`, mode.wave)],
    });
  }
  return mode.kind === 'start' ? start(options, wave.id, mode.dryRun, deps) : resume(options, wave.id, mode.dryRun, deps);
}

function shipError(code: string, message: string, remediation: string, target?: string, severity: ReleaseError['severity'] = 'error'): ReleaseError {
  return { code, severity, message, remediation, ...(target === undefined ? {} : { target }) };
}

function result(
  status: ReleaseStatus,
  phase: ShipPhase,
  wave: string | null,
  steps: readonly ShipStep[],
  extra: {
    readonly message: string;
    readonly errors?: readonly ReleaseError[];
    readonly candidateDir?: string | null;
    readonly packet?: string | null;
    readonly next?: string | null;
  },
): ShipEnvelope {
  return createEnvelope<ShipStep, ShipSummary>({
    command: 'ship',
    status,
    summary: {
      message: extra.message,
      phase,
      wave,
      candidateDir: extra.candidateDir ?? null,
      packet: extra.packet ?? null,
      next: extra.next ?? null,
    },
    items: [...steps],
    errors: [...(extra.errors ?? [])],
  });
}

// ---------------------------------------------------------------------------
// start: order -> changesets -> version -> build -> stop for the commit
// ---------------------------------------------------------------------------

async function start(options: ShipOptions, wave: string, dryRun: boolean, deps: ShipDeps): Promise<ShipEnvelope> {
  const { cwd, config } = options;
  const steps: ShipStep[] = [];
  const fail = (message: string, errors: readonly ReleaseError[]): ShipEnvelope =>
    result('failure', 'start', wave, steps, { message, errors });

  // 1. Order: the publish set, with unpublished @arki deps first.
  const order = await deps.order({ cwd, config, wave, npmRunner: deps.npm });
  const orderErrors = order.errors.filter(e => e.severity === 'error');
  if (orderErrors.length > 0) {
    steps.push({ id: 'order', status: 'failed', detail: order.summary.message });
    return fail('The release order failed; nothing was changed.', orderErrors);
  }
  if (order.items.length === 0) {
    steps.push({ id: 'order', status: 'done', detail: 'no package to publish' });
    return fail(`Nothing to release in ${wave}.`, [
      shipError(SHIP_ERROR_CODES.usage, `No package in ${wave} has a pending changeset.`, 'Add a changeset (`.changeset/*.md`) for the package you changed.', wave),
    ]);
  }
  const publishSet = new Set(order.items.map(i => i.name));
  steps.push({ id: 'order', status: 'done', detail: order.items.map(i => `${String(i.publishOrder)}. ${i.name}@${i.version}`).join(', ') });

  // 2. Split the pending changesets. `changeset version --ignore <every package
  // outside the set>` consumes only the set's changesets and leaves the other
  // waves' ones pending. A changeset that bumps a package inside AND outside
  // the set cannot be split, so ship refuses before anything changes.
  const { changesets, errors: changesetErrors } = await loadChangesets(cwd);
  const { manifests } = await discoverManifests(cwd);
  const versionOf = Object.fromEntries(manifests.map(m => [m.name, m.version]));
  const ours = changesets.filter(c => Object.keys(c.bumps).some(name => publishSet.has(name)));
  const refusals: ReleaseError[] = [...changesetErrors.filter(e => e.severity === 'error'), ...checkBumps(ours, versionOf)];
  for (const changeset of ours) {
    for (const pkg of Object.keys(changeset.bumps).filter(name => !publishSet.has(name))) {
      refusals.push(
        shipError(
          SHIP_ERROR_CODES.foreignChangeset,
          `.changeset/${changeset.file} bumps ${pkg}, which is not in the ${wave} publish set.`,
          `Split .changeset/${changeset.file}: keep the ${wave} bumps there and move the ${pkg} bump to its own changeset.`,
          pkg,
        ),
      );
    }
  }
  const changesetBin = path.join(cwd, 'node_modules', '.bin', 'changeset');
  const missingBin = existsSync(changesetBin)
    ? null
    : shipError(
        SHIP_ERROR_CODES.stepFailed,
        `${path.relative(cwd, changesetBin)} does not exist, so \`changeset version\` cannot run.`,
        '@changesets/cli is a dev dependency of tooling/arki-release; run `bun install` at the repo root so node_modules/.bin/changeset exists (never bunx).',
      );
  if (refusals.length > 0) {
    steps.push({ id: 'changesets', status: 'failed', detail: `${String(refusals.length)} refusal(s)` });
    return fail('A pending changeset cannot ship with this wave; nothing was changed.', missingBin === null ? refusals : [...refusals, missingBin]);
  }
  const ignored = manifests.map(m => m.name).filter(name => !publishSet.has(name));
  const versionArgs = [changesetBin, 'version', ...ignored.flatMap(name => ['--ignore', name])];
  steps.push({
    id: 'changesets',
    status: 'done',
    detail: `${String(ours.length)} changeset(s) for the set; ${String(changesets.length - ours.length)} for other waves stay pending`,
  });

  const turboBin = path.join(cwd, 'node_modules', '.bin', 'turbo');
  const buildArgs = ['run', 'build', ...[...publishSet].map(name => `--filter=${name}`)];
  if (dryRun) {
    steps.push(
      {
        id: 'version',
        status: missingBin === null ? 'planned' : 'failed',
        detail: `bun ${path.relative(cwd, changesetBin)} version --ignore <${String(ignored.length)} packages outside the set>`,
      },
      { id: 'build', status: 'planned', detail: `${turboBin} ${buildArgs.join(' ')}` },
      { id: 'upgrade-guide', status: 'deferred', detail: 'the upgrade guide check for Stack minor bumps lands in T2.11' },
      { id: 'commit', status: 'planned', detail: 'orchestrator commits the bumps by pathspec (SHIP_E001 prints the line)' },
      { id: 'resume', status: 'planned', detail: `bun release:arki ship --wave ${wave} --resume` },
    );
    return result(missingBin === null ? 'success' : 'warning', 'start', wave, steps, {
      message: `Dry run: ${String(publishSet.size)} package(s) would be versioned and built: ${[...publishSet].join(', ')}.`,
      errors: missingBin === null ? [] : [{ ...missingBin, severity: 'warning' }],
      next: `bun release:arki ship --wave ${wave}`,
    });
  }
  if (missingBin !== null) {
    steps.push({ id: 'version', status: 'failed', detail: missingBin.message });
    return fail('`changeset version` cannot run; nothing was changed.', [missingBin]);
  }

  // 3. Version through the workspace binary (never bunx).
  const version = await deps.exec('bun', versionArgs, { cwd });
  if (version.code !== 0) {
    steps.push({ id: 'version', status: 'failed', detail: version.stderr.trim() });
    return fail('`changeset version` failed.', [
      shipError(SHIP_ERROR_CODES.stepFailed, `changeset version exited ${String(version.code)}: ${version.stderr.trim()}`, 'Fix the error, restore the changed files, then run ship again.'),
    ]);
  }
  const after = await discoverManifests(cwd);
  const bumped = after.manifests.filter(m => versionOf[m.name] !== undefined && versionOf[m.name] !== m.version);
  const strays = bumped.filter(m => !publishSet.has(m.name));
  if (strays.length > 0) {
    steps.push({ id: 'version', status: 'failed', detail: `bumped outside the set: ${strays.map(m => m.name).join(', ')}` });
    return fail('`changeset version` bumped packages outside the publish set.', strays.map(m =>
      shipError(
        SHIP_ERROR_CODES.foreignChangeset,
        `${m.name} went from ${versionOf[m.name] ?? '?'} to ${m.version}, but it is not in the ${wave} publish set.`,
        `Restore ${relativeDir(cwd, m.manifestPath)}/package.json and CHANGELOG.md, then check the changesets' dependent-bump settings.`,
        m.name,
      ),
    ));
  }
  steps.push({ id: 'version', status: 'done', detail: bumped.map(m => `${m.name}@${m.version}`).join(', ') });

  // 4. Build the set.
  const build = await deps.exec(turboBin, buildArgs, { cwd });
  if (build.code !== 0) {
    steps.push({ id: 'build', status: 'failed', detail: build.stderr.trim().slice(-400) });
    return fail('The build failed after versioning.', [
      shipError(SHIP_ERROR_CODES.stepFailed, `turbo build exited ${String(build.code)}.`, `Fix the build, then run \`${turboBin} ${buildArgs.join(' ')}\` and the commit line.`),
    ]);
  }
  steps.push(
    { id: 'build', status: 'done', detail: [...publishSet].join(', ') },
    { id: 'upgrade-guide', status: 'deferred', detail: 'the upgrade guide check for Stack minor bumps lands in T2.11' },
  );

  // 5. Stop: committing is the orchestrator's job.
  const paths = [
    ...bumped.flatMap(m => {
      const dir = relativeDir(cwd, m.manifestPath);
      return [`${dir}/package.json`, ...(existsSync(path.join(cwd, dir, 'CHANGELOG.md')) ? [`${dir}/CHANGELOG.md`] : [])];
    }),
    ...ours.map(c => `.changeset/${c.file}`),
  ];
  const line = commitLine(paths);
  steps.push({ id: 'commit', status: 'planned', detail: line });
  return result('warning', 'start', wave, steps, {
    message: 'Versions bumped and built. Commit them, then run ship --resume.',
    errors: [
      shipError(SHIP_ERROR_CODES.commitNeeded, 'commit the version bumps, then re-run with --resume', `${line} && bun release:arki ship --wave ${wave} --resume`, wave, 'warning'),
    ],
    next: line,
  });
}

function relativeDir(cwd: string, manifestPath: string): string {
  return path.relative(cwd, path.dirname(path.resolve(cwd, manifestPath)));
}

// ---------------------------------------------------------------------------
// resume: candidate -> smoke -> docs -> demos -> scorecard -> packet
// ---------------------------------------------------------------------------

const scriptsSchema = z.object({ scripts: z.record(z.string(), z.string()).optional() }).loose();

async function resume(options: ShipOptions, wave: string, dryRun: boolean, deps: ShipDeps): Promise<ShipEnvelope> {
  const { cwd, config } = options;
  const steps: ShipStep[] = [];
  if (dryRun) {
    for (const id of ['candidate', 'smoke', 'docs', 'demos', 'scorecard', 'packet']) steps.push({ id, status: 'planned', detail: '' });
    return result('success', 'resume', wave, steps, { message: 'Dry run: resume would freeze a candidate, check it and write the packet.' });
  }

  // 1. Freeze the tarballs; every later step reads only these bytes.
  const frozen = await deps.candidate({ cwd, config, target: { kind: 'versioned', id: wave }, gitRunner: deps.git, npmRunner: deps.npm });
  const candidateDir = frozen.summary.directory;
  if (frozen.status === 'failure' || candidateDir === null) {
    steps.push({ id: 'candidate', status: 'failed', detail: frozen.summary.message });
    return result('failure', 'resume', wave, steps, { message: 'Freezing the candidate failed.', errors: frozen.errors });
  }
  steps.push({ id: 'candidate', status: 'done', detail: frozen.summary.message });

  // 2. Install the tarballs in a clean consumer (records checks.smoke).
  const smoke = await deps.smoke({ candidateDir, repoRoot: cwd, config });
  steps.push({ id: 'smoke', status: smoke.status === 'failure' ? 'failed' : 'done', detail: `${String(smoke.summary.failed)} of ${String(smoke.summary.checks)} check(s) failed` });

  // 3. Doc examples: the producer docs-fresh reads.
  const read = await readCandidate(candidateDir);
  if (!read.ok) return result('failure', 'resume', wave, steps, { message: 'The candidate changed under ship.', errors: read.errors, candidateDir });
  const { manifests } = await discoverManifests(cwd);
  const errors: ReleaseError[] = [...smoke.errors.filter(e => e.severity === 'error')];
  for (const pkg of read.candidate.packages) {
    const manifest = manifests.find(m => m.name === pkg.name);
    const dir = manifest === undefined ? null : path.dirname(path.resolve(cwd, manifest.manifestPath));
    const check = dir === null ? docsEntry({ kind: 'error', message: 'package not found in packages/' }) : await runDocExamples(dir, deps.exec);
    await appendCandidateCheck(candidateDir, docsCheckId(pkg.name), check, deps.now);
    steps.push({ id: docsCheckId(pkg.name), status: check.status === 'failure' ? 'failed' : check.status === 'warning' ? 'skipped' : 'done', detail: docsDetail(check) });
  }

  // 4. Demo candidate checks: recorded as deferred, never as a pass.
  const registry = await loadDemos(cwd, config);
  const present = new Set(registry.demos.filter(d => d.present).map(d => d.entry.name));
  const demos = new Set(read.candidate.packages.flatMap(p => demosUsing(registry, p.name).map(u => u.demo)).filter(name => present.has(name)));
  for (const demo of demos) {
    await appendCandidateCheck(candidateDir, `demo:${demo}`, { status: 'deferred', envelope: { reason: DEMO_DEFERRED_REASON } }, deps.now);
    steps.push({ id: `demo:${demo}`, status: 'deferred', detail: DEMO_DEFERRED_REASON });
  }

  // 5. The gate over the frozen bytes and every recorded check.
  const scorecard = await deps.scorecard({
    cwd,
    config,
    candidateDir,
    npmRunner: deps.npm,
    gitRunner: deps.git,
    allowDeferred: options.allowDeferred === true,
    ...(options.allowDemoLag === undefined ? {} : { allowDemoLag: options.allowDemoLag }),
  });
  const gateOpen = scorecard.summary.stableReleaseGate === 'open';
  await appendCandidateCheck(candidateDir, 'scorecard', { status: gateOpen ? 'success' : 'failure', envelope: scorecard.summary }, deps.now);
  steps.push({ id: 'scorecard', status: gateOpen ? 'done' : 'failed', detail: scorecard.summary.message });
  if (!gateOpen) {
    errors.push(
      ...scorecard.summary.stableReleaseBlockers.map(blocker =>
        shipError(SHIP_ERROR_CODES.checksFailed, `scorecard: ${blocker}`, `Run \`bun release:arki scorecard --candidate ${candidateDir}\` and fix each blocker.`),
      ),
    );
  }
  if (smoke.status === 'failure') {
    errors.push(shipError(SHIP_ERROR_CODES.checksFailed, 'smoke failed on the frozen tarballs.', `Run \`bun release:arki smoke --candidate ${candidateDir} --keep\` and inspect the consumer.`));
  }
  if (errors.length > 0) {
    return result('failure', 'resume', wave, steps, { message: 'Candidate checks failed; no packet was written.', errors, candidateDir });
  }

  // 6. The packet.
  const final = await readCandidate(candidateDir);
  if (!final.ok) return result('failure', 'resume', wave, steps, { message: 'The candidate changed under ship.', errors: final.errors, candidateDir });
  const packet = path.join(candidateDir, PACKET_FILE);
  await writeFile(packet, renderPacket({ cwd, candidateDir, candidate: final.candidate }));
  steps.push({ id: 'packet', status: 'done', detail: packet });
  debug('packet %s', packet);
  return result('success', 'resume', wave, steps, {
    message: `Packet ready: ${packet}. The founder publishes, then runs --finish.`,
    candidateDir,
    packet,
    next: finishCommand(candidateDir),
  });
}

function docsEntry(check: DocsCheck): CandidateCheckEntry {
  if (check.kind === 'no-script') return { status: 'warning', envelope: check };
  if (check.kind === 'error') return { status: 'failure', envelope: check };
  return { status: check.report.failures.length > 0 ? 'failure' : 'success', envelope: check };
}

function docsDetail(entry: CandidateCheckEntry): string {
  if (entry.status === 'warning') return 'no test:docs script';
  return entry.status === 'success' ? 'doc examples pass' : 'doc examples failed';
}

/** Runs `test:docs --json` (arki-doc-examples) when the package has the script. */
async function runDocExamples(dir: string, exec: ExecRunner): Promise<CandidateCheckEntry> {
  const manifest = scriptsSchema.safeParse(JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8')));
  if (!manifest.success || manifest.data.scripts?.['test:docs'] === undefined) return docsEntry({ kind: 'no-script' });
  const out = await exec('bun', ['run', 'test:docs', '--json'], { cwd: dir });
  let json: unknown;
  try {
    json = JSON.parse(out.stdout) as unknown;
  } catch {
    return docsEntry({ kind: 'error', message: `test:docs printed no JSON (exit ${String(out.code)}): ${out.stderr.trim().slice(-300)}` });
  }
  const report = docExamplesReportSchema.safeParse(json);
  return report.success
    ? docsEntry({ kind: 'report', report: report.data })
    : docsEntry({ kind: 'error', message: `test:docs JSON is not an arki-doc-examples report: ${report.error.message}` });
}

// ---------------------------------------------------------------------------
// finish: verify on npm -> shipped -> ledger -> sync -> demo pins
// ---------------------------------------------------------------------------

const integritySchema = z.string().min(1);

async function finish(options: ShipOptions, dir: string, deps: ShipDeps): Promise<ShipEnvelope> {
  const { cwd, config } = options;
  const steps: ShipStep[] = [];
  const candidateDir = path.resolve(cwd, dir);
  const agent = (deps.env['CLAUDECODE'] ?? '') !== '';
  if (agent || !deps.isTTY) {
    return result('failure', 'finish', null, steps, {
      message: '`ship --finish` is founder-only.',
      candidateDir,
      errors: [
        shipError(
          SHIP_ERROR_CODES.founderOnly,
          agent ? 'ship --finish refuses to run inside an agent (CLAUDECODE is set).' : 'ship --finish refuses to run without a terminal on stdin.',
          `The founder runs \`${finishCommand(candidateDir)}\` in a terminal after publishing the packet.`,
        ),
      ],
    });
  }

  const read = await readCandidate(candidateDir);
  if (!read.ok) return result('failure', 'finish', null, steps, { message: 'The candidate is unusable.', errors: read.errors, candidateDir });
  const { candidate } = read;
  const errors: ReleaseError[] = [];

  // 1. Verify each version on npm. Never publish, never republish.
  const packages = [...candidate.packages].sort((a, b) => a.publishOrder - b.publishOrder);
  for (const pkg of packages) {
    const expected = integrityOf(pkg.sha512);
    const spec = `${pkg.name}@${pkg.version}`;
    const publishLine = `npm publish --access public ${path.join(candidateDir, pkg.tarball)}`;
    const view = await deps.npm(['view', spec, 'dist.integrity', '--json'], { cwd: tmpdir() });
    const missing = (view.code !== 0 && /E404|404 Not Found/.test(view.stderr)) || (view.code === 0 && view.stdout.trim() === '');
    if (missing) {
      steps.push({ id: `verify:${pkg.name}`, status: 'failed', detail: `${spec} is not on npm` });
      errors.push(shipError(SHIP_ERROR_CODES.notPublished, `${spec} is not on npm yet.`, `Publish it from /tmp: \`${publishLine}\`, then rerun --finish.`, pkg.name));
      continue;
    }
    let actual: string | null = null;
    if (view.code === 0) {
      try {
        const parsed = integritySchema.safeParse(JSON.parse(view.stdout) as unknown);
        actual = parsed.success ? parsed.data : null;
      } catch {
        actual = null;
      }
    }
    if (actual === null) {
      steps.push({ id: `verify:${pkg.name}`, status: 'failed', detail: 'npm view failed' });
      errors.push(shipError(SHIP_ERROR_CODES.npmViewFailed, `npm view ${spec} failed: ${view.stderr.trim() || view.stdout.trim()}`, 'Check the network and npm login, then rerun --finish.', pkg.name));
      continue;
    }
    if (actual !== expected) {
      steps.push({ id: `verify:${pkg.name}`, status: 'failed', detail: `integrity ${actual} != ${expected}` });
      errors.push(
        shipError(
          SHIP_ERROR_CODES.integrityMismatch,
          `${spec} on npm has dist.integrity ${actual}, but the candidate tarball is ${expected}. Different bytes were published.`,
          'Do not republish (npm forbids it). Find which tarball was published, then ship a new patch version from a fresh candidate.',
          pkg.name,
        ),
      );
      continue;
    }
    steps.push({ id: `verify:${pkg.name}`, status: 'skipped', detail: `${spec} already on npm with matching integrity` });
    await appendCandidateCheck(candidateDir, `published:${pkg.name}`, { status: 'success', envelope: { spec, integrity: actual } }, deps.now);
  }
  if (errors.length > 0) {
    return result('failure', 'finish', candidate.wave, steps, { message: 'Not every package is verified on npm; nothing was recorded as shipped.', errors, candidateDir });
  }

  // 2. Record the ship; docs-impact diffs from this commit next time.
  await appendCandidateCheck(
    candidateDir,
    'shipped',
    { status: 'success', envelope: { packages: packages.map(p => ({ name: p.name, version: p.version, integrity: integrityOf(p.sha512) })) } },
    deps.now,
  );
  steps.push({ id: 'shipped', status: 'done', detail: `${String(packages.length)} package(s)` });

  // 3. Ledger entry, newest first. Idempotent on rerun.
  const ledgerFile = path.join(cwd, LEDGER_PATH);
  const candidateId = path.basename(candidateDir);
  const recorded = await readCandidate(candidateDir);
  const ledgerCandidate = recorded.ok ? recorded.candidate : candidate;
  const waveLabel = config.waves.find(w => w.id === candidate.wave)?.label ?? candidate.wave;
  const written = await writeLedgerEntry(ledgerFile, renderLedgerEntry({ candidate: ledgerCandidate, candidateId, waveLabel, date: deps.now() }), candidateId);
  await appendCandidateCheck(candidateDir, 'ledger', { status: 'success', envelope: { file: LEDGER_PATH, result: written } }, deps.now);
  steps.push({ id: 'ledger', status: written === 'written' ? 'done' : 'skipped', detail: `${LEDGER_PATH}: ${written}` });

  // 4. Mirror sync.
  const warnings: ReleaseError[] = [];
  if (deps.syncApply === undefined) {
    steps.push({ id: 'sync', status: 'deferred', detail: 'sync --apply is not wired into ship yet' });
    warnings.push(
      shipError(SHIP_ERROR_CODES.syncFailed, 'The mirror sync is not wired into ship --finish yet.', `Run \`bun release:arki sync --apply --candidate ${candidateDir}\` in a terminal.`, undefined, 'warning'),
    );
  } else {
    const sync = await deps.syncApply(candidateDir);
    await appendCandidateCheck(candidateDir, 'sync', { status: sync.status, envelope: sync.summary }, deps.now);
    steps.push({ id: 'sync', status: sync.status === 'failure' ? 'failed' : 'done', detail: `status ${sync.status}` });
    if (sync.status === 'failure') {
      errors.push(
        shipError(SHIP_ERROR_CODES.syncFailed, `The mirror sync failed: ${sync.errors.map(e => `${e.code} ${e.message}`).join('; ')}`, `Fix it, then rerun \`${finishCommand(candidateDir)}\` (npm, shipped and the ledger are already done).`),
      );
    }
  }

  // 5. Demo pin bumps: printed for T4.2's `arki:npm`, never applied here.
  const registry = await loadDemos(cwd, config);
  for (const demo of registry.demos.filter(d => d.present)) {
    const bumps = packages.flatMap(p => {
      const pinned = demo.pins.get(p.name)?.pinned;
      return pinned !== undefined && pinned !== p.version ? [`${p.name} ${pinned} -> ${p.version}`] : [];
    });
    if (bumps.length === 0) continue;
    steps.push({
      id: `pin:${demo.entry.name}`,
      status: 'planned',
      detail: `set in ${demo.entry.path}/arki.deps.json: ${bumps.join(', ')}; then: cd ${demo.entry.path} && bun run arki:npm`,
    });
  }

  return result(errors.length > 0 ? 'failure' : warnings.length > 0 ? 'warning' : 'success', 'finish', candidate.wave, steps, {
    message: errors.length > 0 ? 'Shipped on npm, but a later step failed.' : `Shipped ${String(packages.length)} package(s) from ${candidateId}.`,
    errors: [...errors, ...warnings],
    candidateDir,
  });
}
