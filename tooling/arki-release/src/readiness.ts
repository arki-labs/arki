/**
 * Per-package readiness table (plan T1.5).
 *
 * One row per public package, one column per item. Items read from disk
 * (files, README headings, package.json fields) are computed here. Items
 * produced by other modules (install smoke, docs-fresh, demo proof, mirror
 * state, runtimes) arrive as optional inputs; absent means `missing`, never
 * a crash.
 *
 * Blocking items fail the dimension and are never averaged away. A shrink-only
 * baseline (`readiness-baseline.json`) turns today's known gaps into
 * non-blocking `fail`s; an item that passes while still baselined reports
 * `baseline-stale` so the baseline has to shrink.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { readmeSectionProblem } from '@arki/library-tooling/src/docs';
import { z } from 'zod';

import { RELEASE_ROOTS } from './inventory';
import type { ReleaseConfig, ReleaseError, ScorecardDimensionResult } from './types';

export const READINESS_ERROR_CODES = {
  /** A blocking item failed. */
  itemFailed: 'READY_E001',
  /** A blocking item has no evidence (its producer did not run). */
  itemMissing: 'READY_E002',
  /** An item passes but is still in the baseline. */
  baselineStale: 'READY_E003',
  /** The baseline file is unreadable or has the wrong shape. */
  baselineInvalid: 'READY_E004',
} as const;

// ---------------------------------------------------------------------------
// Tiers: `tiers` in arki.release.config.ts (mirrors docs/arki/core-packages.md)
// ---------------------------------------------------------------------------

export type ReadinessTier = 1 | 2;

type TierSource = Pick<ReleaseConfig, 'tiers'>;

/** Tier of a package name; null for untiered packages (and when config has no tiers). */
export function tierOf(config: TierSource, name: string): ReadinessTier | null {
  if (config.tiers?.stack.includes(name) === true) return 1;
  if (config.tiers?.libraries.includes(name) === true) return 2;
  return null;
}

/** The manifest fields the leaf predicate reads. */
export type LeafManifest = {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>> | undefined;
  readonly peerDependencies?: Readonly<Record<string, string>> | undefined;
};

/**
 * A leaf library is a Tier 2 package with no `@arki/*` dependency or peer.
 * The one definition both readiness (`runtimes`) and `bench-fresh` use.
 */
export function isLeafLibrary(config: TierSource, manifest: LeafManifest): boolean {
  if (tierOf(config, manifest.name) !== 2) return false;
  const deps = { ...manifest.dependencies, ...manifest.peerDependencies };
  return !Object.keys(deps).some((d) => d.startsWith('@arki/'));
}

// ---------------------------------------------------------------------------
// README H2 order — the section list lives in @arki/library-tooling (README_SECTIONS).
// ---------------------------------------------------------------------------

/** H2 texts of a markdown file, ignoring fenced code blocks. */
export function readmeH2s(markdown: string): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const f = /^\s*(```+|~~~+)/.exec(line);
    if (f) {
      const mark = f[1]?.[0] ?? '`';
      fence = fence === null ? mark : fence === mark ? null : fence;
      continue;
    }
    if (fence !== null) continue;
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line);
    if (h?.[1]) out.push(h[1]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

export const EXTERNAL_ITEM_IDS = [
  'install-smoke',
  'docs-fresh',
  'demo-proof',
  'mirror-tag',
  'mirror-release',
  'mirror-security',
  'mirror-integrity',
  'runtimes',
] as const;

export type ExternalItemId = (typeof EXTERNAL_ITEM_IDS)[number];

export const DISK_ITEM_IDS = [
  'file-readme',
  'file-changelog',
  'file-license',
  'file-llms-txt',
  'file-agents-md',
  'file-agent-guide',
  'readme-h2-order',
  'pkg-description',
  'pkg-keywords',
  'pkg-homepage',
  'pkg-repository-directory',
  'pkg-funding',
  'pkg-side-effects',
  'pkg-engines',
  'files-ship-dist-docs',
  'types',
  'licence',
] as const;

export const READINESS_ITEM_IDS = [...DISK_ITEM_IDS, ...EXTERNAL_ITEM_IDS] as const;
export type ReadinessItemId = (typeof READINESS_ITEM_IDS)[number];

/** Items whose failure never blocks (optional marketing or proof signals). */
const NON_BLOCKING: ReadonlySet<ReadinessItemId> = new Set([
  'pkg-funding',
  'demo-proof',
  'mirror-security',
]);

export type ItemStatus = 'pass' | 'fail' | 'missing' | 'n/a' | 'baseline-stale';

export type ReadinessItem = {
  readonly id: ReadinessItemId;
  readonly status: ItemStatus;
  /** Effective: false for baselined gaps and optional items. */
  readonly blocking: boolean;
  /** True when a failing item is excused by the baseline. */
  readonly baselined: boolean;
  readonly detail: string;
};

/** What other modules report for an external item; absent = `missing`. */
export type ExternalOutcome = 'pass' | 'fail' | 'n/a';
export type ExternalResults = Partial<Record<ExternalItemId, ExternalOutcome>>;

export type ReadinessBaseline = Readonly<Record<string, readonly ReadinessItemId[]>>;

export type ReadinessInput = {
  /** Supplies `tiers`. */
  readonly config: TierSource;
  /** Repository root; `repository.directory` is checked against the package folder's path from it. */
  readonly root: string;
  /** Absolute package directory (contains package.json). */
  readonly dir: string;
  readonly external?: ExternalResults;
  /** Item ids excused for this package. */
  readonly baseline?: readonly ReadinessItemId[];
};

export type ReadinessResult = {
  readonly name: string;
  readonly tier: ReadinessTier | null;
  readonly items: readonly ReadinessItem[];
  readonly dimension: ScorecardDimensionResult;
};

type Check = { readonly ok: boolean; readonly detail: string };

const manifestShape = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    keywords: z.array(z.string()).optional(),
    homepage: z.string().optional(),
    repository: z.union([z.string(), z.object({ directory: z.string().optional() }).passthrough()]).optional(),
    funding: z.unknown().optional(),
    sideEffects: z.union([z.boolean(), z.array(z.string())]).optional(),
    engines: z.record(z.string(), z.string()).optional(),
    files: z.array(z.string()).optional(),
    types: z.string().optional(),
    exports: z.unknown().optional(),
    license: z.string().optional(),
    dependencies: z.record(z.string(), z.string()).optional(),
    peerDependencies: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

type Manifest = z.infer<typeof manifestShape>;

const hasFile = (dir: string, rel: string): Check => ({
  ok: existsSync(path.join(dir, rel)),
  detail: `${rel} ${existsSync(path.join(dir, rel)) ? 'present' : 'missing'}`,
});

const nonEmpty = (value: string | undefined, label: string): Check => ({
  ok: typeof value === 'string' && value.trim() !== '',
  detail: `${label} ${typeof value === 'string' && value.trim() !== '' ? 'set' : 'missing'}`,
});

function hasTypes(manifest: Manifest): boolean {
  if (manifest.types) return true;
  const root = manifest.exports;
  if (typeof root !== 'object' || root === null) return false;
  const entries = root as Record<string, unknown>;
  const dot = entries['.'];
  if (dot !== undefined) return typeof dot === 'object' && dot !== null && 'types' in dot;
  // Subpath-only packages (@arki/ui): every code entry must declare types.
  // String entries are assets such as ./package.json or a stylesheet.
  const code = Object.values(entries).filter((value): value is object => typeof value === 'object' && value !== null);
  return code.length > 0 && code.every(value => 'types' in value);
}

function shipsDistAndDocs(files: readonly string[] | undefined): Check {
  const list = files ?? [];
  const norm = list.map((f) => f.replace(/^\.\//, ''));
  const dist = norm.some((f) => /^dist(\/|$)/.test(f));
  const docs = norm.some((f) => /^docs(\/|$)/.test(f));
  return {
    ok: dist && docs,
    detail: `files ${dist ? 'ships' : 'misses'} dist, ${docs ? 'ships' : 'misses'} docs`,
  };
}

function readmeOrder(dir: string): Check {
  const file = path.join(dir, 'README.md');
  if (!existsSync(file)) return { ok: false, detail: 'README.md missing' };
  const problem = readmeSectionProblem(readmeH2s(readFileSync(file, 'utf8')));
  return problem === undefined ? { ok: true, detail: 'H2 order matches' } : { ok: false, detail: problem };
}

function repoDirectory(manifest: Manifest, root: string, dir: string): Check {
  const expected = path.relative(root, dir).split(path.sep).join('/');
  const repo = manifest.repository;
  const actual = typeof repo === 'object' ? repo.directory : undefined;
  return { ok: actual === expected, detail: `repository.directory is ${actual ?? 'missing'}, want ${expected}` };
}

function diskChecks(root: string, dir: string, manifest: Manifest): Record<(typeof DISK_ITEM_IDS)[number], Check> {
  return {
    'file-readme': hasFile(dir, 'README.md'),
    'file-changelog': hasFile(dir, 'CHANGELOG.md'),
    'file-license': hasFile(dir, 'LICENSE'),
    'file-llms-txt': hasFile(dir, 'llms.txt'),
    'file-agents-md': hasFile(dir, 'AGENTS.md'),
    'file-agent-guide': hasFile(dir, 'docs/agent-guide.md'),
    'readme-h2-order': readmeOrder(dir),
    'pkg-description': nonEmpty(manifest.description, 'description'),
    'pkg-keywords': {
      ok: (manifest.keywords?.length ?? 0) > 0,
      detail: `keywords ${(manifest.keywords?.length ?? 0) > 0 ? 'set' : 'missing'}`,
    },
    'pkg-homepage': nonEmpty(manifest.homepage, 'homepage'),
    'pkg-repository-directory': repoDirectory(manifest, root, dir),
    'pkg-funding': { ok: Boolean(manifest.funding), detail: `funding ${manifest.funding ? 'set' : 'missing'}` },
    'pkg-side-effects': {
      ok: manifest.sideEffects !== undefined,
      detail: `sideEffects ${manifest.sideEffects === undefined ? 'missing' : 'set'}`,
    },
    'pkg-engines': {
      ok: Object.keys(manifest.engines ?? {}).length > 0,
      detail: `engines ${Object.keys(manifest.engines ?? {}).length > 0 ? 'set' : 'missing'}`,
    },
    'files-ship-dist-docs': shipsDistAndDocs(manifest.files),
    types: { ok: hasTypes(manifest), detail: `types ${hasTypes(manifest) ? 'declared' : 'missing'}` },
    licence: { ok: manifest.license === 'MIT', detail: `license is ${manifest.license ?? 'missing'}, want MIT` },
  };
}

function externalStatus(id: ExternalItemId, manifest: Manifest, external: ExternalResults, config: TierSource): { status: ItemStatus; detail: string } {
  // Runtimes only bind leaf libraries: they run on five runtimes.
  if (id === 'runtimes' && !isLeafLibrary(config, manifest)) return { status: 'n/a', detail: 'not a leaf library' };
  const outcome = external[id];
  if (outcome === undefined) return { status: 'missing', detail: 'no result from its producer' };
  return { status: outcome, detail: `reported ${outcome}` };
}

/** Evaluate one package. Reads the package directory; never throws on bad input. */
export function evaluateReadiness(input: ReadinessInput): ReadinessResult {
  const raw = readManifest(input.dir);
  const name = raw.ok ? raw.manifest.name : `@arki/${path.basename(input.dir)}`;
  const tier = tierOf(input.config, name);
  const excused = new Set<ReadinessItemId>(input.baseline ?? []);

  if (!raw.ok) {
    const evidence: ReleaseError[] = [
      { code: READINESS_ERROR_CODES.itemFailed, severity: 'error', message: raw.detail, remediation: 'Fix package.json so it parses.', target: name },
    ];
    return { name, tier, items: [], dimension: { status: 'fail', details: raw.detail, evidence } };
  }
  if (tier === null) {
    return { name, tier, items: [], dimension: { status: 'pass', details: 'untiered: readiness not evaluated', evidence: [] } };
  }

  const checks = diskChecks(input.root, input.dir, raw.manifest);
  const items: ReadinessItem[] = READINESS_ITEM_IDS.map((id) => {
    const base = isDisk(id)
      ? { status: (checks[id].ok ? 'pass' : 'fail') as ItemStatus, detail: checks[id].detail }
      : externalStatus(id, raw.manifest, input.external ?? {}, input.config);
    const optional = NON_BLOCKING.has(id);
    if (base.status === 'fail' && excused.has(id)) return { id, ...base, blocking: false, baselined: true };
    if (base.status === 'pass' && excused.has(id)) {
      return { id, status: 'baseline-stale', detail: `${base.detail}; remove from baseline`, blocking: false, baselined: false };
    }
    return { id, ...base, blocking: !optional && base.status !== 'n/a', baselined: false };
  });

  return { name, tier, items, dimension: summarize(name, path.relative(input.root, input.dir), items) };
}

function isDisk(id: ReadinessItemId): id is (typeof DISK_ITEM_IDS)[number] {
  return (DISK_ITEM_IDS as readonly string[]).includes(id);
}

function readManifest(dir: string): { ok: true; manifest: Manifest } | { ok: false; detail: string } {
  try {
    const parsed = manifestShape.safeParse(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')));
    return parsed.success ? { ok: true, manifest: parsed.data } : { ok: false, detail: `package.json invalid: ${parsed.error.message}` };
  } catch (error) {
    return { ok: false, detail: `package.json unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function summarize(name: string, folder: string, items: readonly ReadinessItem[]): ScorecardDimensionResult {
  const evidence: ReleaseError[] = [];
  let failed = 0;
  let missing = 0;
  let stale = 0;
  for (const item of items) {
    if (item.status === 'fail' && item.blocking) {
      failed++;
      evidence.push({ code: READINESS_ERROR_CODES.itemFailed, severity: 'error', message: `${item.id}: ${item.detail}`, remediation: `Fix "${item.id}" in ${folder}.`, target: name });
    } else if (item.status === 'missing' && item.blocking) {
      missing++;
      evidence.push({ code: READINESS_ERROR_CODES.itemMissing, severity: 'warning', message: `${item.id}: ${item.detail}`, remediation: `Run the command that produces "${item.id}" and pass its result in.`, target: name });
    } else if (item.status === 'baseline-stale') {
      stale++;
      evidence.push({ code: READINESS_ERROR_CODES.baselineStale, severity: 'warning', message: `${item.id}: now passes but is still in readiness-baseline.json`, remediation: `Delete "${item.id}" from "${name}" in tooling/arki-release/readiness-baseline.json.`, target: name });
    }
  }
  const status = failed > 0 ? 'fail' : missing > 0 || stale > 0 ? 'warn' : 'pass';
  const baselined = items.filter((i) => i.baselined).length;
  return {
    status,
    details: `${failed} blocking fail, ${missing} missing, ${stale} stale baseline, ${baselined} baselined`,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Loading: packages, baseline
// ---------------------------------------------------------------------------

const baselineShape = z.record(z.string(), z.array(z.enum(READINESS_ITEM_IDS)));

/** Read the baseline. A missing file is an empty baseline; a bad one throws with a fix. */
export function loadReadinessBaseline(file: string): ReadinessBaseline {
  if (!existsSync(file)) return {};
  const parsed = baselineShape.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) {
    throw new Error(`${READINESS_ERROR_CODES.baselineInvalid}: ${file} is invalid (${parsed.error.message}). Regenerate it with the one-off command in readiness.ts.`);
  }
  return parsed.data;
}

/** Directories of public packages (`private` not true) under each of `RELEASE_ROOTS`. */
export function listPublicPackageDirs(root: string): string[] {
  return RELEASE_ROOTS.flatMap((releaseRoot) => {
    const base = path.join(root, releaseRoot);
    if (!existsSync(base)) return [];
    return readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(path.join(base, e.name, 'package.json')))
      .map((e) => path.join(base, e.name))
      .filter((dir) => {
        try {
          return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).private !== true;
        } catch {
          return false;
        }
      })
      .sort();
  });
}

/** Evaluate every public package under `root`. */
export function evaluateReadinessForRoot(
  root: string,
  config: TierSource,
  baseline: ReadinessBaseline,
  external: Readonly<Record<string, ExternalResults>> = {},
): ReadinessResult[] {
  return listPublicPackageDirs(root).map((dir) => {
    const read = readManifest(dir);
    const name = read.ok ? read.manifest.name : `@arki/${path.basename(dir)}`;
    return evaluateReadiness({ config, root, dir, baseline: baseline[name] ?? [], external: external[name] });
  });
}

/**
 * Today's blocking gaps as a baseline: every failing blocking item of every tiered package.
 * One-off, from the repo root (overwrites the file; run only to seed it, the
 * baseline may only shrink afterwards):
 *
 *   bun -e "import {writeFileSync} from 'node:fs'; import {evaluateReadinessForRoot,generateReadinessBaseline} from './tooling/arki-release/src/readiness.ts'; import {config} from './arki.release.config.ts'; writeFileSync('tooling/arki-release/readiness-baseline.json', JSON.stringify(generateReadinessBaseline(evaluateReadinessForRoot(process.cwd(), config, {})), null, 2) + '\n')"
 */
export function generateReadinessBaseline(results: readonly ReadinessResult[]): Record<string, ReadinessItemId[]> {
  const out: Record<string, ReadinessItemId[]> = {};
  for (const r of results) {
    const gaps = r.items.filter((i) => i.status === 'fail' && !NON_BLOCKING.has(i.id)).map((i) => i.id);
    if (gaps.length > 0) out[r.name] = gaps;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

const CELL: Record<ItemStatus, string> = { pass: 'ok', fail: 'FAIL', missing: 'miss', 'n/a': '-', 'baseline-stale': 'stale' };

function header(_id: ReadinessItemId, index: number): string {
  return `${index + 1}`;
}

/**
 * Plain-text fixed-width table for `scorecard --table`. Columns are numbered;
 * a legend below maps each number to its item id. A baselined fail shows
 * `base`.
 */
export function renderReadinessTable(results: readonly ReadinessResult[]): string {
  const rows = results.filter((r) => r.items.length > 0);
  const nameWidth = Math.max(7, ...rows.map((r) => r.name.length));
  const heads = READINESS_ITEM_IDS.map(header);
  const widths = heads.map((h) => Math.max(h.length, 5));
  const line = (name: string, cells: readonly string[]) =>
    `${name.padEnd(nameWidth)} T  ${cells.map((c, i) => c.padEnd(widths[i] ?? 5)).join(' ')}`.trimEnd();
  const out = [line('package', heads)];
  for (const r of rows) {
    const cells = READINESS_ITEM_IDS.map((id) => {
      const item = r.items.find((i) => i.id === id);
      if (!item) return '-';
      if (item.baselined) return 'base';
      // An optional item (funding, demo proof) never blocks, so its fail reads as a warning.
      return item.status === 'fail' && !item.blocking ? 'warn' : CELL[item.status];
    });
    out.push(`${r.name.padEnd(nameWidth)} ${String(r.tier ?? '-')}  ${cells.map((c, i) => c.padEnd(widths[i] ?? 5)).join(' ')}`.trimEnd());
  }
  out.push('', 'ok pass, FAIL blocking gap, warn non-blocking gap, base baselined gap, stale baseline entry to delete, miss no result, - n/a');
  out.push(READINESS_ITEM_IDS.map((id, i) => `${i + 1}=${id}`).join('  '));
  return out.join('\n');
}
