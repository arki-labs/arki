/**
 * Docs and demo impact gate (founder decision A-27).
 *
 * Every package release must update its docs and its demos, unless a
 * changeset says why not with a line `no docs impact: <reason>` /
 * `no demo impact: <reason>`. A precise reason is the point: a vague one
 * ("n/a") hides exactly the drift this gate exists to catch. The changeset
 * may be pending or already consumed by `changeset version` since the
 * package's last release (see `releaseChangesets`).
 *
 * Everything with an effect (git, the demo registry, candidate checks) is
 * injected, so the evaluators are pure and the loaders are testable.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { createEnvelope } from './json-output';
import type { GitRunner } from './runners';
import type {
  ReleaseCommandEnvelope,
  ReleaseError,
  ScorecardDimensionResult,
  ScorecardStatus,
} from './types';

export const IMPACT_ERROR_CODES = {
  /** Docs not touched since the last release and no `no docs impact:` line. */
  docsImpact: 'IMPACT_E001',
  /** Demo check missing/failed and no `no demo impact:` line. */
  demoImpact: 'IMPACT_E002',
  /** A `no ... impact:` line exists but its reason is too short or on the deny list. */
  badReason: 'IMPACT_E003',
  /** `major` bump below 1.0 (breaking changes are MINOR while 0.x). */
  majorBelowOne: 'IMPACT_E004',
  /** A changeset file cannot be parsed. */
  badChangeset: 'IMPACT_E005',
} as const;

export const IMPACT_DIMENSIONS = ['docs-impact', 'demo-impact'] as const;
export type ImpactDimension = (typeof IMPACT_DIMENSIONS)[number];

/** Reasons that say nothing. Compared trimmed and lower-case. */
export const REASON_DENY_LIST = ['n/a', 'none', 'na', '-', 'nothing', 'internal'] as const;
export const REASON_MIN_LENGTH = 12;

/** Files whose change counts as a docs update. Paths are relative to the package dir. */
const DOC_FILES = ['README.md', 'llms.txt', 'AGENTS.md'] as const;

const bumpSchema = z.enum(['patch', 'minor', 'major']);
const frontmatterSchema = z.record(z.string(), bumpSchema);

export type Changeset = {
  readonly file: string;
  readonly bumps: Readonly<Record<string, z.infer<typeof bumpSchema>>>;
  readonly body: string;
};

export type ChangesetParse =
  | { readonly ok: true; readonly changeset: Changeset }
  | { readonly ok: false; readonly error: ReleaseError };

/** Parse one changeset file: `---` frontmatter of `'pkg': bump` lines, then the note. */
export function parseChangeset(file: string, text: string): ChangesetParse {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) return { ok: false, error: badChangeset(file, 'no --- frontmatter block') };
  const raw: Record<string, string> = {};
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const pair = /^\s*(['"]?)([^'":]+)\1\s*:\s*(['"]?)([^'"\s]+)\3\s*$/.exec(line);
    if (!pair) return { ok: false, error: badChangeset(file, `cannot read frontmatter line "${line}"`) };
    raw[pair[2] ?? ''] = pair[4] ?? '';
  }
  const parsed = frontmatterSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: badChangeset(file, parsed.error.issues.map(i => i.message).join('; ')) };
  return { ok: true, changeset: { file, bumps: parsed.data, body: match[2] ?? '' } };
}

function badChangeset(file: string, why: string): ReleaseError {
  return {
    code: IMPACT_ERROR_CODES.badChangeset,
    severity: 'error',
    message: `Changeset ${file} is invalid: ${why}.`,
    remediation: `Fix the frontmatter of ${file}: one line per package, \`'@arki/<name>': patch\` or \`minor\`.`,
    target: file,
  };
}

/**
 * Read and parse every `.changeset/*.md` (except the README). The one
 * changeset reader: `order`, `candidate`, `impact` and the scorecard all
 * call it. No `.changeset` folder means no pending changesets.
 */
export async function loadChangesets(root: string): Promise<{ changesets: Changeset[]; errors: ReleaseError[] }> {
  const dir = path.join(root, '.changeset');
  const names = (await readdir(dir).catch(() => [])).filter(n => n.endsWith('.md') && n !== 'README.md').toSorted();
  const changesets: Changeset[] = [];
  const errors: ReleaseError[] = [];
  for (const name of names) {
    const parsed = parseChangeset(name, await readFile(path.join(dir, name), 'utf8'));
    if (parsed.ok) changesets.push(parsed.changeset);
    else errors.push(parsed.error);
  }
  return { changesets, errors };
}

/** Names of the packages the changesets bump (any bump). */
export function bumpedPackages(changesets: readonly Changeset[]): Set<string> {
  return new Set(changesets.flatMap(c => Object.keys(c.bumps)));
}

/** `major` below 1.0 is refused: while 0.x, breaking changes are MINOR bumps. */
export function checkBumps(
  changesets: readonly Changeset[],
  versions: Readonly<Record<string, string>>,
): ReleaseError[] {
  const errors: ReleaseError[] = [];
  for (const changeset of changesets) {
    for (const [pkg, bump] of Object.entries(changeset.bumps)) {
      const version = versions[pkg];
      if (bump !== 'major' || version === undefined || !version.startsWith('0.')) continue;
      errors.push({
        code: IMPACT_ERROR_CODES.majorBelowOne,
        severity: 'error',
        message: `${pkg} is at ${version} but ${changeset.file} asks for a major bump.`,
        remediation: `Change \`'${pkg}': major\` to \`'${pkg}': minor\` in .changeset/${changeset.file}. Breaking changes are MINOR below 1.0.`,
        target: pkg,
      });
    }
  }
  return errors;
}

/**
 * IMPACT_E004 blocks the release: a major bump below 1.0 fails docs-impact
 * (the changeset dimension) whatever the docs say, so the gate closes
 * instead of the error sitting unread in the envelope.
 */
export function withBumpErrors(result: ScorecardDimensionResult, bumpErrors: readonly ReleaseError[]): ScorecardDimensionResult {
  if (bumpErrors.length === 0) return result;
  return {
    status: 'fail',
    details: `${String(bumpErrors.length)} major bump(s) below 1.0; ${result.details}`,
    evidence: [...result.evidence, ...bumpErrors],
  };
}

export type ImpactKind = 'docs' | 'demo';

export type ReasonScan = {
  /** First acceptable reason found, if any. */
  readonly reason: string | null;
  /** Lines that start the marker but whose reason is rejected. */
  readonly rejected: readonly string[];
};

export function isPreciseReason(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length >= REASON_MIN_LENGTH && !(REASON_DENY_LIST as readonly string[]).includes(trimmed.toLowerCase());
}

/** Look for `no <kind> impact: <reason>` lines in the changesets that bump `pkg`. */
export function scanReasons(kind: ImpactKind, pkg: string, changesets: readonly Changeset[]): ReasonScan {
  const marker = new RegExp(`^no ${kind} impact:(.*)$`);
  let reason: string | null = null;
  const rejected: string[] = [];
  for (const changeset of changesets) {
    if (!(pkg in changeset.bumps)) continue;
    for (const line of changeset.body.split(/\r?\n/)) {
      const hit = marker.exec(line.trim());
      if (!hit) continue;
      const text = (hit[1] ?? '').trim();
      if (isPreciseReason(text)) reason ??= text;
      else rejected.push(line.trim());
    }
  }
  return { reason, rejected };
}

function result(status: ScorecardStatus, details: string, evidence: readonly ReleaseError[] = []): ScorecardDimensionResult {
  return { status, details, evidence };
}

function missingReasonErrors(kind: ImpactKind, pkg: string, scan: ReasonScan, why: string, suggestion: string): ReleaseError[] {
  const code = kind === 'docs' ? IMPACT_ERROR_CODES.docsImpact : IMPACT_ERROR_CODES.demoImpact;
  const line = `no ${kind} impact: ${suggestion}`;
  const errors: ReleaseError[] = [
    {
      code,
      severity: 'error',
      message: `${pkg}: ${why}`,
      remediation: `Update the ${kind === 'docs' ? 'docs (README.md, llms.txt, AGENTS.md or docs/)' : 'demos'}, or paste this line into the package's changeset (the reason must be specific, at least ${String(REASON_MIN_LENGTH)} characters):\n${line}`,
      target: pkg,
    },
  ];
  for (const rejected of scan.rejected) {
    errors.push({
      code: IMPACT_ERROR_CODES.badReason,
      severity: 'error',
      message: `${pkg}: "${rejected}" is not accepted. A reason needs at least ${String(REASON_MIN_LENGTH)} characters and cannot be one of: ${REASON_DENY_LIST.join(', ')}.`,
      remediation: `Replace it with a specific reason, for example:\n${line}`,
      target: pkg,
    });
  }
  return errors;
}

export type DocsImpactInput = {
  readonly pkg: string;
  /** Package folder, repo-relative (`packages/kv`, `tooling/typescript`). */
  readonly dir: string;
  /** Output of `git diff --name-only base..HEAD -- <dir>`; `null` when the package never shipped. */
  readonly changedFiles: readonly string[] | null;
  readonly changesets: readonly Changeset[];
};

export function touchesDocs(dir: string, changedFiles: readonly string[]): boolean {
  const prefix = `${dir}/`;
  return changedFiles.some(file => {
    if (!file.startsWith(prefix)) return false;
    const rel = file.slice(prefix.length);
    return (DOC_FILES as readonly string[]).includes(rel) || rel.startsWith('docs/');
  });
}

export function evaluateDocsImpact(input: DocsImpactInput): ScorecardDimensionResult {
  const { pkg, dir, changedFiles, changesets } = input;
  // A first release has nothing to diff against, and docs-fresh already gates its docs: warning here would block every first publish.
  if (changedFiles === null) return result('pass', 'no previous release to diff against (first release); docs are checked by docs-fresh');
  if (touchesDocs(dir, changedFiles)) return result('pass', 'docs changed since the last release');
  const scan = scanReasons('docs', pkg, changesets);
  if (scan.reason !== null) return result('pass', `no docs impact: ${scan.reason}`);
  return result(
    'fail',
    'docs not touched since the last release and no accepted reason',
    missingReasonErrors('docs', pkg, scan, 'no change to README.md, llms.txt, AGENTS.md or docs/ since the last release.', '<what changed and why no doc describes it>'),
  );
}

export type DemoImpactInput = {
  readonly pkg: string;
  /** Names of registered demos that use the package (from the demo registry). */
  readonly demos: readonly string[];
  /** `candidate.json` `checks`, keyed `demo:<name>`. */
  readonly candidateChecks: Readonly<Record<string, { readonly status: string }>>;
  readonly changesets: readonly Changeset[];
};

export function evaluateDemoImpact(input: DemoImpactInput): ScorecardDimensionResult {
  const { pkg, demos, candidateChecks, changesets } = input;
  const unchecked = demos.filter(name => candidateChecks[`demo:${name}`]?.status !== 'success');
  // No demo imports it: the registry already states the reason (founder, 2026-10-21).
  if (demos.length === 0) return result('pass', 'no registered demo uses this package');
  if (unchecked.length === 0) return result('pass', `demo check passed: ${demos.join(', ')}`);
  const scan = scanReasons('demo', pkg, changesets);
  if (scan.reason !== null) return result('pass', `no demo impact: ${scan.reason}`);
  const why = `no passing candidate check for demo ${unchecked.join(', ')}.`;
  return result('fail', why, missingReasonErrors('demo', pkg, scan, why, '<why the demos need no change>'));
}

/** The commit a package's docs must be diffed from: the last candidate that shipped it, else the commit that set its npm version. */
export async function resolveBase(input: {
  /** Repository root, where git runs. */
  readonly root: string;
  readonly dir: string;
  readonly npmVersion: string | null;
  readonly lastShippedCommit: string | null;
  readonly git: GitRunner;
}): Promise<string | null> {
  if (input.lastShippedCommit !== null) return input.lastShippedCommit;
  if (input.npmVersion === null) return null;
  const manifest = `${input.dir}/package.json`;
  const versionLine = `"version": "${input.npmVersion}"`;
  // -G also matches the commit that bumped the version away, so take the
  // newest match whose package.json still holds the npm version afterwards.
  const out = await input.git(['log', '--format=%H', `-G${versionLine}`, '--', manifest], { cwd: input.root });
  if (out.code !== 0) return null;
  for (const sha of out.stdout.split('\n').map(l => l.trim()).filter(l => l !== '')) {
    const after = await input.git(['show', `${sha}:${manifest}`], { cwd: input.root });
    if (after.code === 0 && after.stdout.includes(versionLine)) return sha;
  }
  return null;
}

export async function changedSince(root: string, base: string, dir: string, git: GitRunner): Promise<string[]> {
  const out = await git(['diff', '--name-only', `${base}..HEAD`, '--', dir], { cwd: root });
  return out.stdout.split('\n').map(l => l.trim()).filter(l => l !== '');
}

/**
 * The changesets that `changeset version` consumed since `base`: every
 * `.changeset/*.md` (not the README) deleted in `base..HEAD`, read back from
 * the commit before the deleting one. `ship` runs `changeset version` in
 * phase 1 and the scorecard runs in phase 2, so a `no ... impact:` reason
 * lives only in these by then. Newest deletion first. A file git cannot read
 * back or parse is skipped: `changeset version` already parsed it, and the
 * pending changesets stay the ones that report parse errors.
 */
export async function consumedChangesets(root: string, base: string, git: GitRunner): Promise<Changeset[]> {
  const out = await git(['log', '--diff-filter=D', '--name-only', '--format=commit %H', `${base}..HEAD`, '--', '.changeset'], { cwd: root });
  if (out.code !== 0) return [];
  const changesets: Changeset[] = [];
  let commit: string | null = null;
  for (const line of out.stdout.split('\n').map(l => l.trim())) {
    if (line.startsWith('commit ')) {
      commit = line.slice('commit '.length);
      continue;
    }
    const name = path.posix.basename(line);
    if (commit === null || path.posix.dirname(line) !== '.changeset' || !name.endsWith('.md') || name === 'README.md') continue;
    const shown = await git(['show', `${commit}^:${line}`], { cwd: root });
    if (shown.code !== 0) continue;
    const parsed = parseChangeset(name, shown.stdout);
    if (parsed.ok) changesets.push(parsed.changeset);
  }
  return changesets;
}

/**
 * The changesets a package's release is judged by: the pending ones, plus
 * those consumed since `base` (its last release). A first release (`base`
 * null) has only pending ones. A file both pending and consumed counts once,
 * as its pending text.
 */
export async function releaseChangesets(root: string, base: string | null, pending: readonly Changeset[], git: GitRunner): Promise<Changeset[]> {
  if (base === null) return [...pending];
  const seen = new Set(pending.map(c => c.file));
  const consumed = (await consumedChangesets(root, base, git)).filter(c => {
    if (seen.has(c.file)) return false;
    seen.add(c.file);
    return true;
  });
  return [...pending, ...consumed];
}

export type ImpactPackage = {
  readonly name: string;
  readonly dir: string;
  /** Current `package.json` version. */
  readonly version: string;
  /** Version on npm, `null` if never published. */
  readonly npmVersion: string | null;
  /** `sourceCommit` of the last candidate that shipped it. */
  readonly lastShippedCommit: string | null;
};

export type ImpactOptions = {
  readonly root: string;
  readonly packages: readonly ImpactPackage[];
  readonly git: GitRunner;
  readonly demosUsing: (pkg: string) => readonly string[];
  readonly candidateChecks: Readonly<Record<string, { readonly status: string }>>;
};

export type ImpactItem = {
  readonly name: string;
  readonly dimensions: Readonly<Record<ImpactDimension, ScorecardDimensionResult>>;
};

export type ImpactSummary = { readonly message: string; readonly packages: number; readonly failing: number };

export type ImpactEnvelope = ReleaseCommandEnvelope<ImpactItem, ImpactSummary>;

/** `impact` command: evaluate docs-impact and demo-impact for every package in the release set. */
export async function runImpact(options: ImpactOptions): Promise<ImpactEnvelope> {
  const { changesets, errors } = await loadChangesets(options.root);
  const bumpErrors = checkBumps(changesets, Object.fromEntries(options.packages.map(p => [p.name, p.version])));
  const items: ImpactItem[] = [];
  for (const pkg of options.packages) {
    const base = await resolveBase({ root: options.root, dir: pkg.dir, npmVersion: pkg.npmVersion, lastShippedCommit: pkg.lastShippedCommit, git: options.git });
    const changedFiles = base === null ? null : await changedSince(options.root, base, pkg.dir, options.git);
    const judged = await releaseChangesets(options.root, base, changesets, options.git);
    const docs = withBumpErrors(
      evaluateDocsImpact({ pkg: pkg.name, dir: pkg.dir, changedFiles, changesets: judged }),
      bumpErrors.filter(e => e.target === pkg.name),
    );
    const demo = evaluateDemoImpact({ pkg: pkg.name, demos: options.demosUsing(pkg.name), candidateChecks: options.candidateChecks, changesets: judged });
    errors.push(...docs.evidence, ...demo.evidence);
    items.push({ name: pkg.name, dimensions: { 'docs-impact': docs, 'demo-impact': demo } });
  }
  const failing = items.filter(i => Object.values(i.dimensions).some(d => d.status === 'fail')).length;
  return createEnvelope<ImpactItem, ImpactSummary>({
    command: 'impact',
    status: errors.some(e => e.severity === 'error') ? 'failure' : 'success',
    summary: { message: `Impact: ${String(failing)} of ${String(items.length)} package(s) failing.`, packages: items.length, failing },
    items,
    errors,
  });
}
