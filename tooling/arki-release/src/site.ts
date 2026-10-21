/**
 * The `site` command: copies package docs from published bytes into
 * `apps/arki/start` and writes the data files the site reads.
 *
 *   site --channel published
 *     For each admitted package and each npm version with no folder yet under
 *     `src/content/packages/<short>/`, `npm pack` that version and copy its
 *     docs. A version folder is written once and never rewritten: npm bytes
 *     never change, so neither does the page built from them. A tarball with
 *     no `docs/` and no `llms.txt` keeps README (+ CHANGELOG) only and is
 *     marked `archive`.
 *   site --channel next [--candidate <dir>]
 *     Copies from the newest candidate per wave (or only `<dir>`) into
 *     `<short>/next/`, rewritten every run. Also writes `dot-new.json` from
 *     the candidate's `@arki/dot` CLI (never from source).
 *
 * Both channels then regenerate `src/generated/{packages,errors,examples,demos}.json`
 * from the snapshot folders on disk, each parsed through its schema in
 * `./site-schema`. Only docs files are copied: never `dist/` code or `src/`.
 */

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import debugFactory from 'debug';
import { z } from 'zod';

import { errorIndexSchema } from '@arki/library-tooling/src/error-index';

import type { Candidate, CandidatePackage } from './candidate';
import type { ExecRunner, NpmRunner } from './runners';
import type { DotNewFile, PackageEntry, SiteChannel, SnapshotMeta } from './site-schema';
import type { ReleaseCommandEnvelope, ReleaseConfig, ReleaseError } from './types';
import {
  CANDIDATE_FILE,
  CANDIDATES_DIR,
  candidateSchema,
  docsCheckOf,
  npmPackOutputSchema,
  readCandidate,
  readTarballEntries,
} from './candidate';
import { demosUsing, loadDemos } from './demos';
import { parseBenchProvenance } from './docs-fresh';
import { createEnvelope } from './json-output';
import { npmVersionLookup } from './order';
import { gapTitle, loadOpenDemoGaps } from './demo-issues';
import { loadReadinessBaseline, tierOf } from './readiness';
import { defaultNpmRunner, execRunner } from './runners';
import {
  demosFileSchema,
  dotNewFileSchema,
  dotNewResultSchema,
  errorsFileSchema,
  examplesFileSchema,
  packagesFileSchema,
  snapshotMetaSchema,
} from './site-schema';

const debug = debugFactory('arki:release:site');

export const SITE_ERROR_CODES = {
  /** A wave has no readable candidate, so its packages get no `next` snapshot. */
  noCandidate: 'SITE_E001',
  /** A candidate failed its sha512 check or schema. */
  candidateUnreadable: 'SITE_E002',
  /** `npm view` failed for a package. */
  npmLookupFailed: 'SITE_E003',
  /** `npm pack <name>@<version>` failed or printed no tarball. */
  packFailed: 'SITE_E004',
  /** Installing the candidate or running `dot new --dry-run --json` failed. */
  dotNewFailed: 'SITE_E005',
  /** A snapshot folder has no valid `snapshot.json`. */
  badSnapshot: 'SITE_E006',
  /** A repo doc the site copies (`REPO_DOC_COPIES`) is missing. */
  repoDocMissing: 'SITE_E007',
} as const;

/** Where `site` writes, relative to the repo root. */
export const SITE_CONTENT_DIR = path.join('apps', 'arki', 'start', 'src', 'content', 'packages');
export const SITE_GENERATED_DIR = path.join('apps', 'arki', 'start', 'src', 'generated');
export const SNAPSHOT_META_FILE = 'snapshot.json';
export const SITE_APP_CONTENT_DIR = path.join('apps', 'arki', 'start', 'src', 'content');

/**
 * Repo docs the site shows, copied into the app's content folder. The Docker image is built from `turbo prune`
 * output, which holds workspaces only, so the app must never read a file outside its own folder. `from` is relative
 * to the repo root, `to` to `SITE_APP_CONTENT_DIR`. `sourceLine` adds a `source:` frontmatter line naming the
 * original (the glossary is a content collection and shows where it comes from). An optional file that is gone
 * has its copy removed.
 */
export const REPO_DOC_COPIES = [
  { from: 'docs/arki/glossary.md', to: 'glossary/glossary.md', optional: false, sourceLine: true },
  { from: 'docs/arki/agent-bench/PROTOCOL.md', to: 'agent-bench/PROTOCOL.md', optional: false, sourceLine: false },
  { from: 'docs/arki/agent-bench/results.json', to: 'agent-bench/results.json', optional: true, sourceLine: false },
  { from: 'SECURITY.md', to: 'security/SECURITY.md', optional: false, sourceLine: false },
] as const;
const READINESS_BASELINE = path.join('tooling', 'arki-release', 'readiness-baseline.json');
const MIRROR_ORG = 'https://github.com/arki-labs';

/** The `dot new` templates the site shows. */
export const DOT_NEW_TEMPLATES = ['minimal', 'stack'] as const;

export interface SiteOptions {
  readonly cwd: string;
  readonly config: ReleaseConfig;
  readonly channel: SiteChannel;
  /** `next` only: copy from this candidate alone instead of the newest per wave. */
  readonly candidateDir?: string;
  readonly npmRunner?: NpmRunner;
  /** Runs `npm install` and `npx dot` for `dot-new.json`. */
  readonly exec?: ExecRunner;
  readonly tmpRoot?: string;
}

export const SITE_ACTIONS = ['created', 'kept', 'rewritten', 'removed'] as const;

export interface SiteItem {
  readonly name: string;
  readonly version: string;
  readonly channel: SiteChannel;
  /** `kept`: a published folder already existed and was left alone. */
  readonly action: (typeof SITE_ACTIONS)[number];
  readonly archive: boolean;
}

export interface SiteSummary {
  readonly message: string;
  readonly channel: SiteChannel;
  readonly created: number;
  readonly kept: number;
  readonly rewritten: number;
  readonly removed: number;
  /** Rows in `packages.json`. */
  readonly packages: number;
  /** Snapshot folders on disk after the run. */
  readonly versions: number;
  readonly archived: number;
  readonly errorCodes: number;
  readonly examples: number;
  /** Repo docs copied into the app (`REPO_DOC_COPIES`). */
  readonly repoDocs: number;
  readonly dotNew: 'written' | 'skipped' | 'failed' | 'not-run';
  readonly wavesWithoutCandidate: readonly string[];
}

export type SiteEnvelope = ReleaseCommandEnvelope<SiteItem, SiteSummary>;

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

export function shortName(name: string): string {
  return name.replace(/^@arki\//, '');
}

const INDEX_TARGETS: Readonly<Record<string, string>> = {
  'dist/api.json': 'api.json',
  'dist/errors.json': 'errors.json',
};
const TOP_LEVEL_DOCS = new Set(['llms.txt', 'llms-full.txt', 'AGENTS.md']);

/** Snapshot-relative path of a tarball file, or null when it is not a docs file. */
function snapshotPathOf(file: string, archive: boolean): string | null {
  const normalized = path.posix.normalize(file);
  if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) return null;
  if (/^readme\.md$/i.test(normalized)) return 'README.md';
  if (/^changelog\.md$/i.test(normalized)) return 'CHANGELOG.md';
  if (archive) return null;
  if (TOP_LEVEL_DOCS.has(normalized) || normalized.startsWith('docs/')) return normalized;
  // Names of grouped same-shape exports sit next to api.json (`api-names/*.json`).
  if (normalized.startsWith('dist/api-names/')) return normalized.slice('dist/'.length);
  return INDEX_TARGETS[normalized] ?? null;
}

const tarballManifestSchema = z.object({ engines: z.record(z.string(), z.string()).optional() }).loose();

export interface SnapshotSource {
  readonly name: string;
  readonly channel: SiteChannel;
  readonly version: string;
  readonly tarball: string;
  readonly candidate: Candidate | null;
}

/** Reads the docs files of a tarball and the metadata the site shows for them. */
export async function buildSnapshot(
  source: SnapshotSource,
): Promise<{ readonly meta: SnapshotMeta; readonly files: ReadonlyMap<string, Buffer> }> {
  const entries = await readTarballEntries(source.tarball);
  const archive = !entries.some(e => e.path.startsWith('docs/') || e.path === 'llms.txt');
  const files = new Map<string, Buffer>();
  for (const entry of entries) {
    const target = snapshotPathOf(entry.path, archive);
    if (target !== null) files.set(target, entry.body);
  }
  const manifestEntry = entries.find(e => e.path === 'package.json');
  const manifest = tarballManifestSchema.safeParse(
    manifestEntry === undefined ? {} : JSON.parse(manifestEntry.body.toString('utf8')),
  );
  const readme = files.get('README.md')?.toString('utf8') ?? '';
  const docs = source.candidate === null ? null : docsCheckOf(source.candidate, source.name);
  const meta = snapshotMetaSchema.parse({
    name: source.name,
    channel: source.channel,
    version: source.version,
    archive,
    sha512: createHash('sha512')
      .update(await readFile(source.tarball))
      .digest('hex'),
    files: [...files.keys()].toSorted(),
    candidate:
      source.candidate === null
        ? null
        : {
            wave: source.candidate.wave,
            sourceCommit: source.candidate.sourceCommit,
            createdAt: source.candidate.createdAt,
          },
    examples: docs?.kind === 'report' ? docs.report : null,
    engines: manifest.success ? (manifest.data.engines ?? {}) : {},
    benchStatus: parseBenchProvenance(readme) === null ? 'none' : 'measured',
  });
  return { meta, files };
}

/** Writes a snapshot into `dir` through a sibling temp folder, so a crash never leaves half a version. */
async function writeSnapshot(dir: string, snapshot: Awaited<ReturnType<typeof buildSnapshot>>): Promise<void> {
  const staging = `${dir}.tmp`;
  await rm(staging, { recursive: true, force: true });
  for (const [file, body] of snapshot.files) {
    const target = path.join(staging, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  await mkdir(staging, { recursive: true });
  await writeFile(path.join(staging, SNAPSHOT_META_FILE), `${JSON.stringify(snapshot.meta, null, 2)}\n`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.dirname(dir), { recursive: true });
  await rename(staging, dir);
}

/** Orders `x.y.z[-pre]` versions; a prerelease sorts before its release. */
export function compareVersions(a: string, b: string): number {
  const [coreA = '', preA] = a.split('-', 2);
  const [coreB = '', preB] = b.split('-', 2);
  const partsA = coreA.split('.').map(Number);
  const partsB = coreB.split('.').map(Number);
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsA[i] ?? 0) - (partsB[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (preA === undefined || preB === undefined) return preA === preB ? 0 : preA === undefined ? 1 : -1;
  return preA.localeCompare(preB, 'en', { numeric: true });
}

function admittedPackages(config: ReleaseConfig): ReadonlyArray<{ readonly name: string; readonly wave: string }> {
  const seen = new Set<string>();
  const out: Array<{ name: string; wave: string }> = [];
  for (const wave of config.waves) {
    for (const name of wave.packages) {
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, wave: wave.id });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

interface ChannelResult {
  readonly items: SiteItem[];
  readonly errors: ReleaseError[];
}

async function syncPublished(options: SiteOptions, contentRoot: string): Promise<ChannelResult> {
  const npm = options.npmRunner ?? defaultNpmRunner;
  const lookup = npmVersionLookup(npm, options.cwd);
  const items: SiteItem[] = [];
  const errors: ReleaseError[] = [];
  for (const { name } of admittedPackages(options.config)) {
    const found = await lookup(name);
    if ('error' in found) {
      errors.push({
        code: SITE_ERROR_CODES.npmLookupFailed,
        severity: 'error',
        message: found.error,
        target: name,
        remediation: 'Check the network and npm access, then rerun.',
      });
      continue;
    }
    for (const version of found.versions) {
      const dir = path.join(contentRoot, shortName(name), version);
      const existing = snapshotMetaSchema.safeParse(
        safeJson(await readFile(path.join(dir, SNAPSHOT_META_FILE), 'utf8').catch(() => '')),
      );
      if (existing.success) {
        items.push({ name, version, channel: 'published', action: 'kept', archive: existing.data.archive });
        continue;
      }
      const temp = await mkdtemp(path.join(options.tmpRoot ?? tmpdir(), 'arki-site-'));
      try {
        const out = await npm(['pack', `${name}@${version}`, '--json', '--pack-destination', temp], { cwd: temp });
        const parsed = out.code === 0 ? npmPackOutputSchema.safeParse(safeJson(out.stdout)) : null;
        const filename = parsed?.success === true ? path.basename(parsed.data[0]?.filename ?? '') : '';
        if (filename === '') {
          errors.push({
            code: SITE_ERROR_CODES.packFailed,
            severity: 'error',
            message: `npm pack ${name}@${version} failed: ${out.stderr.trim() || out.stdout.trim()}`,
            target: name,
            remediation: 'Rerun; the version folder was not written, so the next run retries it.',
          });
          continue;
        }
        const snapshot = await buildSnapshot({
          name,
          channel: 'published',
          version,
          tarball: path.join(temp, filename),
          candidate: null,
        });
        await writeSnapshot(dir, snapshot);
        items.push({ name, version, channel: 'published', action: 'created', archive: snapshot.meta.archive });
        debug('published %s@%s archive=%s', name, version, snapshot.meta.archive);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
  }
  return { items, errors };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

interface ReadCandidateDir {
  readonly dir: string;
  readonly candidate: Candidate;
}

/** The newest readable candidate of each wave, by `createdAt`. Unreadable ones are reported, not used. */
async function newestCandidates(
  options: SiteOptions,
): Promise<{ readonly candidates: ReadCandidateDir[]; readonly errors: ReleaseError[]; readonly missing: string[] }> {
  const errors: ReleaseError[] = [];
  if (options.candidateDir !== undefined) {
    const read = await readCandidate(path.resolve(options.cwd, options.candidateDir));
    if (!read.ok)
      return {
        candidates: [],
        errors: read.errors.map(e => ({ ...e, code: SITE_ERROR_CODES.candidateUnreadable })),
        missing: [],
      };
    return { candidates: [{ dir: read.dir, candidate: read.candidate }], errors, missing: [] };
  }
  const root = path.join(options.cwd, CANDIDATES_DIR);
  const newest = new Map<string, { readonly dir: string; readonly createdAt: string }>();
  for (const entry of await readdir(root).catch(() => [])) {
    const parsed = candidateSchema.safeParse(
      safeJson(await readFile(path.join(root, entry, CANDIDATE_FILE), 'utf8').catch(() => '')),
    );
    if (!parsed.success) continue;
    const seen = newest.get(parsed.data.wave);
    if (seen === undefined || seen.createdAt < parsed.data.createdAt)
      newest.set(parsed.data.wave, { dir: path.join(root, entry), createdAt: parsed.data.createdAt });
  }
  const candidates: ReadCandidateDir[] = [];
  const missing: string[] = [];
  for (const wave of options.config.waves) {
    const pick = newest.get(wave.id);
    if (pick === undefined) {
      missing.push(wave.id);
      continue;
    }
    const read = await readCandidate(pick.dir);
    if (read.ok) candidates.push({ dir: read.dir, candidate: read.candidate });
    else errors.push(...read.errors.map(e => ({ ...e, code: SITE_ERROR_CODES.candidateUnreadable })));
  }
  return { candidates, errors, missing };
}

/** For each package, the newest candidate that holds it. */
function sourcesByPackage(
  candidates: readonly ReadCandidateDir[],
): Map<string, { readonly from: ReadCandidateDir; readonly pkg: CandidatePackage }> {
  const out = new Map<string, { readonly from: ReadCandidateDir; readonly pkg: CandidatePackage }>();
  for (const from of candidates) {
    for (const pkg of from.candidate.packages) {
      const seen = out.get(pkg.name);
      if (seen === undefined || seen.from.candidate.createdAt < from.candidate.createdAt)
        out.set(pkg.name, { from, pkg });
    }
  }
  return out;
}

async function syncNext(
  options: SiteOptions,
  contentRoot: string,
): Promise<
  ChannelResult & {
    readonly missing: readonly string[];
    readonly dot: { readonly from: ReadCandidateDir; readonly pkg: CandidatePackage } | null;
  }
> {
  const { candidates, errors, missing } = await newestCandidates(options);
  for (const wave of missing) {
    errors.push({
      code: SITE_ERROR_CODES.noCandidate,
      severity: 'warning',
      message: `Wave ${wave} has no candidate under ${CANDIDATES_DIR}; packages only it holds get no next snapshot.`,
      target: wave,
      remediation: `Freeze one with \`bun release:arki candidate --wave ${wave}\` (needs a pending changeset), or \`ship --wave ${wave} --resume\` after the version bump.`,
    });
  }
  const sources = sourcesByPackage(candidates);
  const items: SiteItem[] = [];
  for (const { name } of admittedPackages(options.config)) {
    const dir = path.join(contentRoot, shortName(name), 'next');
    const source = sources.get(name);
    if (source === undefined) {
      // With one explicit candidate, leave the other packages' next/ alone.
      if (
        options.candidateDir === undefined &&
        (await readdir(dir).then(
          () => true,
          () => false,
        ))
      ) {
        await rm(dir, { recursive: true, force: true });
        items.push({ name, version: 'next', channel: 'next', action: 'removed', archive: false });
      }
      continue;
    }
    const snapshot = await buildSnapshot({
      name,
      channel: 'next',
      version: source.pkg.version,
      tarball: path.resolve(source.from.dir, source.pkg.tarball),
      candidate: source.from.candidate,
    });
    await writeSnapshot(dir, snapshot);
    items.push({
      name,
      version: source.pkg.version,
      channel: 'next',
      action: 'rewritten',
      archive: snapshot.meta.archive,
    });
  }
  return { items, errors, missing, dot: sources.get('@arki/dot') ?? null };
}

// ---------------------------------------------------------------------------
// dot new
// ---------------------------------------------------------------------------

const tarballDepsSchema = z.object({ dependencies: z.record(z.string(), z.string()).optional() }).loose();
const dotNewEnvelopeSchema = z.object({ ok: z.literal(true), data: dotNewResultSchema });

/**
 * Installs the candidate's tarballs in a clean folder outside the repo and
 * runs its `dot new --dry-run --json` per template. The plan comes from the
 * bytes the founder publishes, never from `packages/dot/src`.
 */
export async function planDotNew(
  exec: ExecRunner,
  from: ReadCandidateDir,
  dot: CandidatePackage,
  tmpRoot: string,
): Promise<{ readonly file: DotNewFile } | { readonly error: ReleaseError }> {
  const consumer = await mkdtemp(path.join(tmpRoot, 'arki-site-dot-'));
  const fail = (message: string): { readonly error: ReleaseError } => ({
    error: {
      code: SITE_ERROR_CODES.dotNewFailed,
      severity: 'warning',
      message,
      target: '@arki/dot',
      remediation: 'Run `bun release:arki smoke --candidate <dir> --keep` to see the install, then rerun site.',
    },
  });
  try {
    const tarballOf = new Map(from.candidate.packages.map(p => [p.name, `file:${path.resolve(from.dir, p.tarball)}`]));
    const published = new Map<string, string>();
    for (const pkg of from.candidate.packages) {
      const manifestEntry = (await readTarballEntries(path.resolve(from.dir, pkg.tarball))).find(
        e => e.path === 'package.json',
      );
      const manifest = tarballDepsSchema.safeParse(safeJson(manifestEntry?.body.toString('utf8') ?? ''));
      for (const [dep, range] of Object.entries(manifest.success ? (manifest.data.dependencies ?? {}) : {})) {
        if (dep.startsWith('@arki/') && !tarballOf.has(dep)) published.set(dep, range);
      }
    }
    const overrides = Object.fromEntries(tarballOf);
    await writeFile(
      path.join(consumer, 'package.json'),
      JSON.stringify(
        {
          name: 'arki-site-dot-new',
          private: true,
          type: 'module',
          dependencies: { ...Object.fromEntries(published), ...overrides },
          overrides,
        },
        null,
        2,
      ),
    );
    const install = await exec('npm', ['install', '--no-audit', '--no-fund'], { cwd: consumer });
    if (install.code !== 0) return fail(`npm install of the candidate failed: ${install.stderr.trim().slice(0, 400)}`);
    const templates: DotNewFile['templates'] = [];
    for (const template of DOT_NEW_TEMPLATES) {
      const out = await exec(
        'npx',
        ['--no-install', 'dot', 'new', 'arki-app', '--template', template, '--dry-run', '--json', '--cwd', consumer],
        { cwd: consumer },
      );
      const parsed = dotNewEnvelopeSchema.safeParse(safeJson(out.stdout));
      if (out.code !== 0 || !parsed.success)
        return fail(
          `dot new --template ${template} --dry-run --json failed: ${(out.stderr || out.stdout).trim().slice(0, 400)}`,
        );
      // The target is an absolute temp path; the site shows it relative to where `dot new` ran.
      const result = {
        ...parsed.data.data,
        app: { ...parsed.data.data.app, target: path.relative(consumer, parsed.data.data.app.target) },
      };
      templates.push({ template, result });
    }
    const candidate = {
      wave: from.candidate.wave,
      sourceCommit: from.candidate.sourceCommit,
      createdAt: from.candidate.createdAt,
    };
    return { file: dotNewFileSchema.parse({ version: dot.version, candidate, templates }) };
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Generated files
// ---------------------------------------------------------------------------

/** Every valid `snapshot.json` under the content root, per package name. */
async function readSnapshots(contentRoot: string, errors: ReleaseError[]): Promise<Map<string, SnapshotMeta[]>> {
  const out = new Map<string, SnapshotMeta[]>();
  for (const short of await readdir(contentRoot).catch(() => [])) {
    for (const version of await readdir(path.join(contentRoot, short)).catch(() => [])) {
      if (version.endsWith('.tmp')) continue;
      const file = path.join(contentRoot, short, version, SNAPSHOT_META_FILE);
      const parsed = snapshotMetaSchema.safeParse(safeJson(await readFile(file, 'utf8').catch(() => '')));
      if (!parsed.success) {
        errors.push({
          code: SITE_ERROR_CODES.badSnapshot,
          severity: 'error',
          message: `${path.join(short, version)} has no valid ${SNAPSHOT_META_FILE}.`,
          target: path.join(short, version),
          remediation: 'Delete the folder and rerun site for its channel.',
        });
        continue;
      }
      out.set(parsed.data.name, [...(out.get(parsed.data.name) ?? []), parsed.data]);
    }
  }
  return out;
}

type Latest = { readonly status: PackageEntry['status']; readonly snapshot: SnapshotMeta | null };

/** The latest page: published with docs, else the candidate, else the README-only archive. */
function latestOf(published: readonly SnapshotMeta[], next: SnapshotMeta | null): Latest {
  const newest = published[0] ?? null;
  if (newest !== null && !newest.archive) return { status: 'published', snapshot: newest };
  if (next !== null) return { status: 'next', snapshot: next };
  if (newest !== null) return { status: 'archive', snapshot: newest };
  return { status: 'none', snapshot: null };
}

interface GeneratedCounts {
  readonly packages: number;
  readonly versions: number;
  readonly archived: number;
  readonly errorCodes: number;
  readonly examples: number;
}

async function writeGenerated(
  options: SiteOptions,
  contentRoot: string,
  generatedRoot: string,
  errors: ReleaseError[],
): Promise<GeneratedCounts> {
  const { cwd, config } = options;
  const snapshots = await readSnapshots(contentRoot, errors);
  const registry = await loadDemos(cwd, config);
  const baseline = loadReadinessBaseline(path.join(cwd, READINESS_BASELINE));
  const demoGaps = await loadOpenDemoGaps(cwd, config);

  const packages: PackageEntry[] = [];
  const errorRows: z.input<typeof errorsFileSchema> = [];
  const exampleRows: z.input<typeof examplesFileSchema> = [];
  let versions = 0;
  let archived = 0;
  for (const { name, wave } of admittedPackages(config).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const all = snapshots.get(name) ?? [];
    const published = all
      .filter(s => s.channel === 'published')
      .toSorted((a, b) => compareVersions(b.version, a.version));
    const next = all.find(s => s.channel === 'next') ?? null;
    versions += all.length;
    archived += all.filter(s => s.archive).length;
    const latest = latestOf(published, next);
    const snap = latest.snapshot;
    if (snap !== null && snap.files.includes('errors.json')) {
      const folder = snap.channel === 'next' ? 'next' : snap.version;
      const parsed = errorIndexSchema.safeParse(
        safeJson(
          await readFile(path.join(contentRoot, shortName(name), folder, 'errors.json'), 'utf8').catch(() => ''),
        ),
      );
      if (parsed.success)
        errorRows.push(...parsed.data.map(entry => ({ ...entry, version: snap.version, channel: snap.channel })));
    }
    if (next !== null && next.examples !== null)
      exampleRows.push({ name, version: next.version, report: next.examples });
    const examples = snap?.examples ?? next?.examples ?? null;
    packages.push({
      name,
      short: shortName(name),
      tier: tierOf(config, name),
      wave,
      status: latest.status,
      npmVersion: published[0]?.version ?? null,
      nextVersion: next?.version ?? null,
      candidate: latest.status === 'next' ? (next?.candidate ?? null) : null,
      versions: [...published, ...(next === null ? [] : [next])].map(s => ({
        version: s.version,
        channel: s.channel,
        archive: s.archive,
      })),
      runtimes: snap?.engines ?? {},
      benchStatus: snap?.benchStatus ?? 'none',
      hasLlms: snap?.files.includes('llms.txt') ?? false,
      examples:
        examples === null ? null : { compiled: examples.compiled, run: examples.ran, skipped: examples.skipped },
      demos: demosUsing(registry, name).map(use => ({ name: use.demo, pin: use.pinned ?? null })),
      mirror: `${MIRROR_ORG}/${shortName(name)}`,
      openGaps: [
        ...(baseline[name] ?? []).map(title => ({ kind: 'readiness' as const, title, url: null, foundBy: null })),
        ...demoGaps
          .filter(({ row }) => row.packages.includes(name))
          .map(({ demo, row }) => ({ kind: 'demo' as const, title: gapTitle(row), url: row.issueUrl, foundBy: demo })),
      ],
    });
  }
  const demos = registry.demos.map(demo => ({
    name: demo.entry.name,
    repo: demo.entry.repo,
    present: demo.present,
    pins: [...demo.pins]
      .map(([pkg, pin]) => ({ name: pkg, pinned: pin.pinned }))
      .toSorted((a, b) => a.name.localeCompare(b.name)),
  }));

  await mkdir(generatedRoot, { recursive: true });
  const write = async (file: string, data: unknown): Promise<void> => {
    await writeFile(path.join(generatedRoot, file), `${JSON.stringify(data, null, 2)}\n`);
  };
  // No timestamps: a rerun with the same inputs writes the same bytes.
  await write('packages.json', packagesFileSchema.parse(packages));
  await write('errors.json', errorsFileSchema.parse(errorRows.toSorted((a, b) => a.code.localeCompare(b.code))));
  await write('examples.json', examplesFileSchema.parse(exampleRows));
  await write('demos.json', demosFileSchema.parse(demos));
  return { packages: packages.length, versions, archived, errorCodes: errorRows.length, examples: exampleRows.length };
}

/** Copies `REPO_DOC_COPIES` into the app; returns how many were written. */
async function copyRepoDocs(cwd: string, errors: ReleaseError[]): Promise<number> {
  let written = 0;
  for (const doc of REPO_DOC_COPIES) {
    const target = path.join(cwd, SITE_APP_CONTENT_DIR, doc.to);
    const text = await readFile(path.join(cwd, doc.from), 'utf8').catch(() => null);
    if (text === null) {
      if (doc.optional) {
        await rm(target, { force: true });
      } else {
        errors.push({
          code: SITE_ERROR_CODES.repoDocMissing,
          severity: 'error',
          message: `${doc.from} is missing, so the site has no copy of it.`,
          target: doc.from,
          remediation: `Restore ${doc.from}, or remove it from REPO_DOC_COPIES and from the routes that read it.`,
        });
      }
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, doc.sourceLine ? `---\nsource: ${doc.from}\n---\n\n${text}` : text);
    written += 1;
  }
  return written;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

export async function runSite(options: SiteOptions): Promise<SiteEnvelope> {
  const contentRoot = path.join(options.cwd, SITE_CONTENT_DIR);
  const generatedRoot = path.join(options.cwd, SITE_GENERATED_DIR);
  const items: SiteItem[] = [];
  const errors: ReleaseError[] = [];
  let missing: readonly string[] = [];
  let dotNew: SiteSummary['dotNew'] = 'not-run';

  if (options.channel === 'published') {
    const result = await syncPublished(options, contentRoot);
    items.push(...result.items);
    errors.push(...result.errors);
  } else {
    const result = await syncNext(options, contentRoot);
    items.push(...result.items);
    errors.push(...result.errors);
    missing = result.missing;
    if (result.dot === null) {
      dotNew = 'skipped';
    } else {
      const planned = await planDotNew(
        options.exec ?? execRunner,
        result.dot.from,
        result.dot.pkg,
        options.tmpRoot ?? tmpdir(),
      );
      if ('error' in planned) {
        dotNew = 'failed';
        errors.push(planned.error);
      } else {
        dotNew = 'written';
        await mkdir(generatedRoot, { recursive: true });
        await writeFile(path.join(generatedRoot, 'dot-new.json'), `${JSON.stringify(planned.file, null, 2)}\n`);
      }
    }
  }

  const counts = await writeGenerated(options, contentRoot, generatedRoot, errors);
  const repoDocs = await copyRepoDocs(options.cwd, errors);
  const count = (action: SiteItem['action']): number => items.filter(i => i.action === action).length;
  const status = errors.some(e => e.severity === 'error') ? 'failure' : errors.length > 0 ? 'warning' : 'success';
  const created = count('created');
  const rewritten = count('rewritten');
  return createEnvelope<SiteItem, SiteSummary>({
    command: 'site',
    status,
    summary: {
      message: `site --channel ${options.channel}: ${String(created)} created, ${String(rewritten)} rewritten, ${String(count('kept'))} kept; ${String(counts.packages)} packages, ${String(counts.versions)} versions.`,
      channel: options.channel,
      created,
      kept: count('kept'),
      rewritten,
      removed: count('removed'),
      ...counts,
      repoDocs,
      dotNew,
      wavesWithoutCandidate: missing,
    },
    items,
    errors,
  });
}
