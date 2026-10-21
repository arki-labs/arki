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
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

import { buildApiIndex } from '@arki/library-tooling/src/api-index';
import { buildErrorIndex } from '@arki/library-tooling/src/error-index';
import debugFactory from 'debug';
import { z } from 'zod';

import { docExamplesReportSchema } from './docs-fresh';
import { exportPublicTree } from './export-public';
import { discoverManifests } from './inventory';
import { createEnvelope } from './json-output';
import { npmVersionLookup, pendingPackages, planOrder } from './order';
import type { OrderItem } from './order';
import { createSourceSnapshot } from './snapshot';
import { defaultGitRunner, defaultNpmRunner, type GitRunner, type NpmRunner } from './runners';
import type { ExportOptions, NpmPackFileEntry, ReleaseCommandEnvelope, ReleaseConfig, ReleaseError } from './types';

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

/**
 * `deferred` marks a check that cannot run yet (its tool lands in a later
 * task). It is never read as a pass: every reader asks for `success`.
 */
export const CHECK_STATUSES = ['success', 'warning', 'failure', 'pending', 'deferred'] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

/** Payload of `checks["docs:<pkg>"]`: what `test:docs` (`arki-doc-examples --json`) produced. */
export const docsCheckSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('report'), report: docExamplesReportSchema }),
  /** The package has no `test:docs` script, so nothing could run. */
  z.object({ kind: z.literal('no-script') }),
  /** The script ran but printed no readable report. */
  z.object({ kind: z.literal('error'), message: z.string() }),
]);
export type DocsCheck = z.infer<typeof docsCheckSchema>;

/** Check id under which `ship --resume` records a package's doc examples. */
export function docsCheckId(pkg: string): string {
  return `docs:${pkg}`;
}

/** Reads a package's doc-examples check from a candidate; `null` when none was recorded. */
export function docsCheckOf(candidate: Candidate, pkg: string): DocsCheck | null {
  const parsed = docsCheckSchema.safeParse(candidate.checks[docsCheckId(pkg)]?.envelope);
  return parsed.success ? parsed.data : null;
}

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
  | { readonly kind: 'affected'; readonly ref: string }
  /**
   * Wave packages whose `package.json` version is not on npm yet. `ship
   * --resume` uses it: `changeset version` has consumed the changesets by
   * then, so the pending-changeset seeds of `wave` would be empty.
   */
  | { readonly kind: 'versioned'; readonly id: string };

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

/** What `npm pack --json` prints: one object per tarball. */
export const npmPackOutputSchema = z.array(z.object({ filename: z.string() })).min(1);

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
  const label = target.kind === 'affected' ? 'affected' : target.id;

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

  // 3b. Write the indexes every tarball carries, from the exported bytes.
  for (const item of order.items) {
    const problem = await writeIndexes(path.join(treeDir, 'packages', item.name.replace(/^@arki\//, '')));
    if (problem !== null) {
      errors.push(buildError(`${item.name}: writing ${INDEX_FILES.join(' and ')} failed: ${problem}`, item.name, 'Fix the package build (its dist/ types and package.json), then run candidate again.'));
    }
  }
  if (errors.length > 0) return failure(label, `${errors.length.toString()} packages have no indexes.`, errors, sourceCommit);

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
  if (target.kind === 'wave' || target.kind === 'versioned') {
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
    if (target.kind === 'versioned') {
      const lookup = npmVersionLookup(options.npmRunner ?? defaultNpmRunner, cwd);
      const versionOf = new Map(manifests.map(m => [m.name, m.version]));
      const seeds: string[] = [];
      for (const name of wave.packages) {
        const version = versionOf.get(name);
        if (version === undefined) continue;
        const found = await lookup(name);
        if ('error' in found) return { error: buildError(found.error, name, 'Check the network and npm access, then rerun.') };
        if (!found.versions.includes(version)) seeds.push(name);
      }
      return { seeds };
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

/**
 * Shipped in every tarball: `dist/api.json` (the public surface; the next
 * minor's upgrade guide diffs against it) and `dist/errors.json` (the error codes).
 */
export const INDEX_FILES = ['dist/api.json', 'dist/errors.json'] as const;

const DIST_WHOLE = /^(?:\.\/)?dist(?:\/|\/\*\*)?$/;

/**
 * The exported manifest's `files`, with the index files added when no entry
 * ships `dist/` whole. Only the exported copy changes; `packages/*` stays as it is.
 */
export function withIndexFiles(files: readonly string[]): readonly string[] {
  if (files.some(entry => DIST_WHOLE.test(entry))) return files;
  return [...files, ...INDEX_FILES.filter(file => !files.includes(file))];
}

const filesFieldSchema = z.object({ files: z.array(z.string()).optional() }).loose();

/** Writes both indexes into one exported package folder; returns the problem, or null. */
async function writeIndexes(folder: string): Promise<string | null> {
  try {
    const { index } = buildApiIndex(folder);
    await writeFile(path.join(folder, INDEX_FILES[0]), `${JSON.stringify(index, null, 2)}\n`);
    await writeFile(path.join(folder, INDEX_FILES[1]), `${JSON.stringify(buildErrorIndex(folder), null, 2)}\n`);
    const manifestFile = path.join(folder, 'package.json');
    const manifest = filesFieldSchema.parse(JSON.parse(await readFile(manifestFile, 'utf8')));
    if (manifest.files !== undefined) {
      const files = withIndexFiles(manifest.files);
      if (files !== manifest.files) await writeFile(manifestFile, `${JSON.stringify({ ...manifest, files }, null, 2)}\n`);
    }
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
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
  const parsed = npmPackOutputSchema.safeParse(json);
  const filename = parsed.success ? path.basename(parsed.data[0]?.filename ?? '') : '';
  if (filename.length === 0) return { error: buildError(`npm pack output for ${item.name} has no filename.`, item.name) };
  const sha512 = await sha512OfFile(path.join(tarballsDir, filename)).catch(() => null);
  if (sha512 === null) return { error: buildError(`npm pack did not write ${filename} for ${item.name}.`, item.name) };
  return {
    pkg: { name: item.name, version: item.version, tarball: path.join('tarballs', filename), sha512, publishOrder: item.publishOrder },
  };
}

// ---------------------------------------------------------------------------
// Reading a frozen tarball
// ---------------------------------------------------------------------------

/** What a candidate tarball holds: its file list and its `package/package.json`. */
export interface TarballContents {
  readonly files: readonly NpmPackFileEntry[];
  /** Parsed `package/package.json`; `null` when absent or not JSON. */
  readonly manifest: unknown;
  /** Size of the `.tgz` on disk. */
  readonly packedSize: number;
}

const BLOCK = 512;

function tarString(block: Buffer, start: number, length: number): string {
  const raw = block.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? raw.length : end).toString('utf8');
}

function tarOctal(block: Buffer, start: number, length: number): number {
  const text = tarString(block, start, length).trim();
  return text === '' ? 0 : Number.parseInt(text, 8);
}

/** The `path=` record of a pax extended header, if any. */
function paxPath(body: Buffer): string | null {
  for (const record of body.toString('utf8').split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(record);
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/** Each regular file of an uncompressed tar, with its path without the `package/` prefix. */
function* tarFiles(tar: Buffer): Generator<{ readonly path: string; readonly size: number; readonly mode: number; readonly body: Buffer }> {
  let nextPath: string | null = null;
  for (let offset = 0; offset + BLOCK <= tar.length; ) {
    const header = tar.subarray(offset, offset + BLOCK);
    if (header.every(byte => byte === 0)) break;
    const size = tarOctal(header, 124, 12);
    const type = tarString(header, 156, 1);
    const body = tar.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (type === 'x') {
      nextPath = paxPath(body);
      continue;
    }
    const prefix = tarString(header, 345, 155);
    const name = nextPath ?? (prefix === '' ? tarString(header, 0, 100) : `${prefix}/${tarString(header, 0, 100)}`);
    nextPath = null;
    if (type !== '0' && type !== '') continue;
    yield { path: name.replace(/^package\//, ''), size, mode: tarOctal(header, 100, 8), body };
  }
}

/**
 * Lists a `.tgz` the way `npm pack --json` does (paths without the
 * `package/` prefix) without unpacking it to disk or re-packing. The scorecard
 * audits these bytes, which are the ones the founder publishes.
 */
export async function readTarball(file: string): Promise<TarballContents> {
  const packed = await readFile(file);
  const files: NpmPackFileEntry[] = [];
  let manifest: unknown = null;
  for (const entry of tarFiles(gunzipSync(packed))) {
    files.push({ path: entry.path, size: entry.size, mode: entry.mode });
    if (entry.path === 'package.json') {
      try {
        manifest = JSON.parse(entry.body.toString('utf8')) as unknown;
      } catch {
        manifest = null;
      }
    }
  }
  return { files, manifest, packedSize: packed.length };
}

/** Every regular file of a `.tgz` with its bytes (paths without `package/`). `site` copies docs from these. */
export async function readTarballEntries(file: string): Promise<ReadonlyArray<{ readonly path: string; readonly body: Buffer }>> {
  return [...tarFiles(gunzipSync(await readFile(file)))].map(entry => ({ path: entry.path, body: entry.body }));
}

/** The text of one file in a `.tgz` (path without `package/`), or null when it is not there. */
export async function readTarballText(file: string, relative: string): Promise<string | null> {
  for (const entry of tarFiles(gunzipSync(await readFile(file)))) {
    if (entry.path === relative) return entry.body.toString('utf8');
  }
  return null;
}

// ---------------------------------------------------------------------------
// Shipped history
// ---------------------------------------------------------------------------

/**
 * `sourceCommit` of the most recent candidate whose `checks.shipped`
 * succeeded, per package it contains. docs-impact diffs from there, so docs
 * edited after the last real release are what counts. Tarballs are not
 * hashed here: only `candidate.json` metadata is read.
 */
export async function lastShippedCommits(candidatesRoot: string): Promise<ReadonlyMap<string, string>> {
  const entries = await readdir(candidatesRoot).catch(() => []);
  const latest = new Map<string, { readonly at: string; readonly commit: string }>();
  for (const entry of entries) {
    const raw = await readFile(path.join(candidatesRoot, entry, CANDIDATE_FILE), 'utf8').catch(() => null);
    if (raw === null) continue;
    let json: unknown;
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      continue;
    }
    const parsed = candidateSchema.safeParse(json);
    const shipped = parsed.success ? parsed.data.checks['shipped'] : undefined;
    if (!parsed.success || shipped?.status !== 'success') continue;
    for (const pkg of parsed.data.packages) {
      const seen = latest.get(pkg.name);
      if (seen === undefined || seen.at < shipped.at) latest.set(pkg.name, { at: shipped.at, commit: parsed.data.sourceCommit });
    }
  }
  return new Map([...latest].map(([name, { commit }]) => [name, commit]));
}
