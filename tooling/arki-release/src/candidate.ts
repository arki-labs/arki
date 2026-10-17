/**
 * Frozen release candidate.
 *
 * A candidate is the exact set of tarballs a wave would publish, built once
 * from a clean commit. Every later step (scorecard, smoke, demos) reads these
 * tarballs and records its result in `candidate.json`; none of them rebuild.
 * That way the bytes that passed the checks are the bytes the founder
 * publishes. The sha512 of each tarball is verified on every read.
 *
 * Layout: `<root>/.release/candidates/<wave>-<shortsha>/{candidate.json, tarballs/*.tgz}`.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

import debugFactory from 'debug';
import { z } from 'zod';

import { exportPublicTree } from './export-public';
import { discoverManifests } from './inventory';
import { createEnvelope } from './json-output';
import { pendingPackages, planOrder } from './order';
import type { OrderItem } from './order';
import { createSourceSnapshot } from './snapshot';
import { defaultGitRunner, defaultNpmRunner, type GitRunner, type NpmRunner } from './runners';
import type { ExportOptions, ReleaseCommandEnvelope, ReleaseConfig, ReleaseError, ReleaseStatus } from './types';

const debug = debugFactory('arki:release:candidate');

export const CANDIDATE_FILE = 'candidate.json';
export const CANDIDATES_DIR = path.join('.release', 'candidates');

export const CANDIDATE_ERROR_CODES = {
  /** A package to publish has uncommitted changes. */
  dirtyPackage: 'CAND_E001',
  /** A package has no built `dist/` in the exported tree. */
  missingDist: 'CAND_E002',
  /** A tarball's sha512 differs from `candidate.json`. */
  checksumMismatch: 'CAND_E003',
  /** `candidate.json` is missing, unreadable or invalid. */
  unreadable: 'CAND_E004',
  /** git, export or npm pack failed. */
  buildFailed: 'CAND_E005',
  /** Nothing to put in the candidate, or bad options. */
  nothingToRelease: 'CAND_E006',
} as const;

export const CHECK_STATUSES = ['success', 'warning', 'failure', 'pending'] as const satisfies readonly ReleaseStatus[];

export const candidateCheckSchema = z.object({
  status: z.enum(CHECK_STATUSES),
  at: z.string(),
  envelope: z.unknown(),
});

export const candidateSchema = z.object({
  wave: z.string(),
  sourceCommit: z.string(),
  createdAt: z.string(),
  packages: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      /** Path relative to the candidate directory. */
      tarball: z.string(),
      /** Hex sha512, the same value `shasum -a 512` prints. */
      sha512: z.string(),
      publishOrder: z.number().int().positive(),
    }),
  ),
  checks: z.record(z.string(), candidateCheckSchema),
});

export type Candidate = z.infer<typeof candidateSchema>;
export type CandidatePackage = Candidate['packages'][number];
export type CandidateCheck = z.infer<typeof candidateCheckSchema>;
/** What a later step passes to {@link appendCandidateCheck}; `at` defaults to now. */
export type CandidateCheckEntry = Omit<CandidateCheck, 'at'> & { readonly at?: string };

export type CandidateRead =
  | { readonly ok: true; readonly dir: string; readonly candidate: Candidate }
  | { readonly ok: false; readonly errors: readonly ReleaseError[] };

function unreadable(dir: string, why: string): CandidateRead {
  return {
    ok: false,
    errors: [
      {
        code: CANDIDATE_ERROR_CODES.unreadable,
        severity: 'error',
        message: `Candidate ${dir} is unusable: ${why}.`,
        target: dir,
        remediation: 'Build a fresh candidate with `candidate --wave <id>`.',
      },
    ],
  };
}

async function sha512OfFile(file: string): Promise<string> {
  return createHash('sha512')
    .update(await readFile(file))
    .digest('hex');
}

/** Loads `candidate.json` and checks every tarball's sha512. Later steps call this before they trust the bytes. */
export async function readCandidate(dir: string): Promise<CandidateRead> {
  const absolute = path.resolve(dir);
  let raw: string;
  try {
    raw = await readFile(path.join(absolute, CANDIDATE_FILE), 'utf8');
  } catch {
    return unreadable(dir, `${CANDIDATE_FILE} is missing`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw) as unknown;
  } catch {
    return unreadable(dir, `${CANDIDATE_FILE} is not valid JSON`);
  }
  const parsed = candidateSchema.safeParse(json);
  if (!parsed.success) return unreadable(dir, `${CANDIDATE_FILE} does not match the schema (${parsed.error.message})`);

  const errors: ReleaseError[] = [];
  for (const pkg of parsed.data.packages) {
    const tarball = path.resolve(absolute, pkg.tarball);
    if (path.relative(absolute, tarball).startsWith('..')) {
      return unreadable(dir, `tarball path ${pkg.tarball} leaves the candidate directory`);
    }
    let actual: string;
    try {
      actual = await sha512OfFile(tarball);
    } catch {
      return unreadable(dir, `tarball ${pkg.tarball} is missing`);
    }
    if (actual !== pkg.sha512) {
      errors.push({
        code: CANDIDATE_ERROR_CODES.checksumMismatch,
        severity: 'error',
        message: `${pkg.name}: ${pkg.tarball} has sha512 ${actual.slice(0, 16)}..., candidate.json says ${pkg.sha512.slice(0, 16)}....`,
        target: pkg.name,
        remediation: 'The tarball changed after the candidate was frozen. Do not use it; build a new candidate.',
      });
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, dir: absolute, candidate: parsed.data };
}

/** Records one check result in `candidate.json` without rebuilding. Verifies the tarballs first. */
export async function appendCandidateCheck(
  dir: string,
  check: string,
  entry: CandidateCheckEntry,
  now: () => Date = () => new Date(),
): Promise<CandidateRead> {
  const read = await readCandidate(dir);
  if (!read.ok) return read;
  const candidate: Candidate = {
    ...read.candidate,
    checks: { ...read.candidate.checks, [check]: { ...entry, at: entry.at ?? now().toISOString() } },
  };
  await writeCandidate(read.dir, candidate);
  return { ok: true, dir: read.dir, candidate };
}

// Write then rename so a crash never leaves a half-written candidate.json.
async function writeCandidate(dir: string, candidate: Candidate): Promise<void> {
  const target = path.join(dir, CANDIDATE_FILE);
  const temp = `${target}.tmp`;
  await writeFile(temp, `${JSON.stringify(candidate, null, 2)}\n`);
  await rename(temp, target);
}

// ---------------------------------------------------------------------------
// Building a candidate
// ---------------------------------------------------------------------------

export interface ExportedTree {
  readonly packages: ReadonlyArray<{ readonly name: string; readonly status: 'exported' | 'skipped' | 'failed' }>;
  /** Repo-relative package dirs exported without `dist/` because their files differ from the commit. */
  readonly dirtyPackages: readonly string[];
  readonly errors: readonly ReleaseError[];
}

export type TreeExporter = (options: ExportOptions) => Promise<ExportedTree>;

/** Exports the committed tree (HEAD snapshot plus built `dist/`) without the workspaces root, so `npm pack` stays standalone. */
const exportCommittedTree: TreeExporter = async options => {
  const snapshot = await createSourceSnapshot({ rootCwd: options.rootCwd });
  try {
    const envelope = await exportPublicTree({ ...options, sourceRoot: snapshot.dir, skipWorkspacesRoot: true });
    return { packages: envelope.items, dirtyPackages: snapshot.dirtyPackages, errors: envelope.errors };
  } finally {
    await snapshot.cleanup();
  }
};

export type CandidateTarget =
  | { readonly kind: 'wave'; readonly id: string }
  /** Public packages changed since this git ref; used by CI. */
  | { readonly kind: 'affected'; readonly ref: string };

export interface RunCandidateOptions {
  readonly cwd: string;
  readonly config: ReleaseConfig;
  readonly target: CandidateTarget;
  /** Default `<cwd>/.release/candidates`. */
  readonly outRoot?: string;
  readonly gitRunner?: GitRunner;
  /** Used for `npm view` and `npm pack`. */
  readonly npmRunner?: NpmRunner;
  readonly exportTree?: TreeExporter;
  readonly now?: () => Date;
}

export interface CandidateSummary {
  readonly message: string;
  readonly wave: string;
  readonly sourceCommit: string;
  readonly directory: string | null;
  readonly packages: number;
}

export type CandidateEnvelope = ReleaseCommandEnvelope<CandidatePackage, CandidateSummary>;

const packOutput = z.array(z.object({ filename: z.string() })).min(1);

function failure(wave: string, message: string, errors: ReleaseError[], commit = ''): CandidateEnvelope {
  return createEnvelope<CandidatePackage, CandidateSummary>({
    command: 'candidate',
    status: 'failure',
    summary: { message, wave, sourceCommit: commit, directory: null, packages: 0 },
    errors,
  });
}

function buildError(message: string, target?: string, remediation?: string): ReleaseError {
  return { code: CANDIDATE_ERROR_CODES.buildFailed, severity: 'error', message, target, remediation };
}

export async function runCandidate(options: RunCandidateOptions): Promise<CandidateEnvelope> {
  const { cwd, config, target } = options;
  const git = options.gitRunner ?? defaultGitRunner;
  const npm = options.npmRunner ?? defaultNpmRunner;
  const exportTree = options.exportTree ?? exportCommittedTree;
  const now = options.now ?? (() => new Date());
  const label = target.kind === 'wave' ? target.id : 'affected';

  // 1. Which packages go in.
  const { manifests } = await discoverManifests(cwd);
  const picked = await pickSeeds(options, manifests);
  if ('error' in picked) return failure(label, picked.error.message, [picked.error]);
  const order = await planOrder({ cwd, config, seeds: picked.seeds, npmRunner: npm });
  if (order.errors.length > 0) return failure(label, 'Release order failed.', [...order.errors]);
  if (order.items.length === 0) {
    return failure(label, 'Nothing to release.', [
      {
        code: CANDIDATE_ERROR_CODES.nothingToRelease,
        severity: 'error',
        message: `No package in ${label} needs publishing.`,
        remediation: 'Add a changeset for the package you changed, or pick another wave or ref.',
      },
    ]);
  }
  const dirOf = new Map(manifests.map(m => [m.name, path.dirname(m.manifestPath)]));

  // 2. The commit, and a clean tree for every package we will pack.
  const head = await git(['rev-parse', 'HEAD'], { cwd });
  if (head.code !== 0) return failure(label, 'git rev-parse failed.', [buildError(head.stderr.trim(), undefined, 'Run inside the git repository.')]);
  const sourceCommit = head.stdout.trim();
  const errors: ReleaseError[] = [];
  for (const item of order.items) {
    const dir = dirOf.get(item.name) ?? '';
    const status = await git(['status', '--porcelain', '--', dir], { cwd });
    if (status.code !== 0 || status.stdout.trim().length > 0) {
      errors.push({
        code: CANDIDATE_ERROR_CODES.dirtyPackage,
        severity: 'error',
        message: `${item.name} has uncommitted changes in ${dir}.`,
        target: item.name,
        remediation: `Commit or discard the changes in ${dir}, then run candidate again.`,
      });
    }
  }
  if (errors.length > 0) return failure(label, `${errors.length.toString()} packages are not clean.`, errors, sourceCommit);

  // 3. Export HEAD and require a built dist/ for each package.
  const candidateDir = path.join(options.outRoot ?? path.join(cwd, CANDIDATES_DIR), `${label}-${sourceCommit.slice(0, 7)}`);
  const treeDir = path.join(candidateDir, 'tree');
  const tarballsDir = path.join(candidateDir, 'tarballs');
  await rm(candidateDir, { recursive: true, force: true });
  await mkdir(tarballsDir, { recursive: true });
  const exported = await exportTree({ rootCwd: cwd, outputPath: treeDir, config });
  const treeFailures = exported.errors.filter(e => e.severity === 'error');
  if (treeFailures.length > 0) return failure(label, 'Exporting the public tree failed.', [...treeFailures], sourceCommit);
  for (const item of order.items) {
    const folder = path.join(treeDir, 'packages', item.name.replace(/^@arki\//, ''));
    const built = exported.packages.some(p => p.name === item.name && p.status === 'exported') && (await isDirectory(path.join(folder, 'dist')));
    if (!built) {
      errors.push({
        code: CANDIDATE_ERROR_CODES.missingDist,
        severity: 'error',
        message: `${item.name} has no built dist/ in the exported tree.`,
        target: item.name,
        remediation: `Run \`turbo build --filter=${item.name}\`, make sure the package has no uncommitted changes, then run candidate again.`,
      });
    }
  }
  if (errors.length > 0) return failure(label, `${errors.length.toString()} packages are not built.`, errors, sourceCommit);

  // 4. Pack each package and hash the tarball.
  const packages: CandidatePackage[] = [];
  for (const item of order.items) {
    const packed = await packOne(npm, item, path.join(treeDir, 'packages', item.name.replace(/^@arki\//, '')), tarballsDir);
    if ('error' in packed) errors.push(packed.error);
    else packages.push(packed.pkg);
  }
  if (errors.length > 0) return failure(label, `${errors.length.toString()} packages failed to pack.`, errors, sourceCommit);

  // 5. Freeze.
  const candidate: Candidate = { wave: label, sourceCommit, createdAt: now().toISOString(), packages, checks: {} };
  await writeCandidate(candidateDir, candidate);
  await rm(treeDir, { recursive: true, force: true });
  debug('candidate %s: %d packages', candidateDir, packages.length);
  return createEnvelope<CandidatePackage, CandidateSummary>({
    command: 'candidate',
    status: 'success',
    summary: {
      message: `Candidate ${label}@${sourceCommit.slice(0, 7)}: ${packages.length.toString()} tarballs in ${candidateDir}.`,
      wave: label,
      sourceCommit,
      directory: candidateDir,
      packages: packages.length,
    },
    items: packages,
  });
}

async function isDirectory(p: string): Promise<boolean> {
  return stat(p).then(s => s.isDirectory(), () => false);
}

async function pickSeeds(
  options: RunCandidateOptions,
  manifests: Awaited<ReturnType<typeof discoverManifests>>['manifests'],
): Promise<{ readonly seeds: readonly string[] } | { readonly error: ReleaseError }> {
  const { cwd, config, target } = options;
  if (target.kind === 'wave') {
    const wave = config.waves.find(w => w.id === target.id);
    if (wave === undefined) {
      return {
        error: {
          code: CANDIDATE_ERROR_CODES.nothingToRelease,
          severity: 'error',
          message: `Wave \`${target.id}\` is not in arki.release.config.ts.`,
          target: target.id,
          remediation: `Use one of: ${config.waves.map(w => w.id).join(', ')}.`,
        },
      };
    }
    const pending = await pendingPackages(cwd);
    return { seeds: wave.packages.filter(name => pending.names.has(name)) };
  }
  const git = options.gitRunner ?? defaultGitRunner;
  const diff = await git(['diff', '--name-only', target.ref, 'HEAD', '--', 'packages'], { cwd });
  if (diff.code !== 0) {
    return {
      error: buildError(`git diff against ${target.ref} failed: ${diff.stderr.trim()}`, target.ref, 'Pass a ref that exists, for example origin/master.'),
    };
  }
  const changed = diff.stdout.split('\n').filter(line => line.length > 0);
  const admitted = new Set(config.waves.flatMap(w => w.packages));
  const seeds = manifests
    .filter(m => !m.private && admitted.has(m.name) && changed.some(file => file.startsWith(`${path.dirname(m.manifestPath)}/`)))
    .map(m => m.name);
  return { seeds };
}

async function packOne(
  npm: NpmRunner,
  item: OrderItem,
  packageDir: string,
  tarballsDir: string,
): Promise<{ readonly pkg: CandidatePackage } | { readonly error: ReleaseError }> {
  const out = await npm(['pack', '--json', '--pack-destination', tarballsDir], { cwd: packageDir });
  if (out.code !== 0) {
    return { error: buildError(`npm pack failed for ${item.name}: ${out.stderr.trim() || out.stdout.trim()}`, item.name) };
  }
  let json: unknown;
  try {
    json = JSON.parse(out.stdout) as unknown;
  } catch {
    return { error: buildError(`npm pack printed invalid JSON for ${item.name}.`, item.name) };
  }
  const parsed = packOutput.safeParse(json);
  const filename = parsed.success ? path.basename(parsed.data[0]?.filename ?? '') : '';
  if (filename.length === 0) return { error: buildError(`npm pack output for ${item.name} has no filename.`, item.name) };
  const sha512 = await sha512OfFile(path.join(tarballsDir, filename)).catch(() => null);
  if (sha512 === null) return { error: buildError(`npm pack did not write ${filename} for ${item.name}.`, item.name) };
  return {
    pkg: { name: item.name, version: item.version, tarball: path.join('tarballs', filename), sha512, publishOrder: item.publishOrder },
  };
}
