/**
 * Docs freshness and bench freshness (plan T1.4; decisions A-24, #51).
 *
 * `docs-fresh` proves a package's written docs still match what ships:
 * llms.txt import paths, runnable doc examples, CHANGELOG, and every
 * `@arki/<x>@<version>` string. `bench-fresh` proves the README benchmark
 * numbers were produced after the last source change.
 *
 * Library-check and doc-examples results are inputs (the CLIs live in
 * `tooling/library`); git is injected. Nothing here runs a benchmark:
 * those are founder idle runs (F-5), never CI.
 */

import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { DocExamplesReport } from './doc-examples-report-schema';
import type { GitRunner } from './runners';
import type { ReleaseError, ScorecardDimensionResult, ScorecardStatus } from './types';

export const FRESH_ERROR_CODES = {
  /** llms.txt "Import paths" differs from exports (library-check DOC_E006). */
  llmsImportPaths: 'FRESH_E001',
  /** `arki-doc-examples` reported failures. */
  docExamples: 'FRESH_E002',
  /** Top CHANGELOG version differs from package.json. */
  changelogVersion: 'FRESH_E003',
  /** A documented `@arki/<x>@<ver>` is neither published nor in the candidate. */
  unknownVersion: 'FRESH_E004',
  /** Exported name never mentioned in README/docs/llms.txt (warning). */
  undocumentedExport: 'FRESH_E005',
  /** A documented `@arki/<x>@<ver>` could not be checked (npm unreachable; warning). */
  versionUnverified: 'FRESH_E006',
  /** The README bench block is older than the last change to `src`. */
  benchStale: 'FRESH_E010',
  /** A leaf lib README has no bench block or no `provenance:` line in it. */
  benchProvenanceMissing: 'FRESH_E011',
} as const;

export const FRESH_DIMENSIONS = ['docs-fresh', 'bench-fresh'] as const;
export type FreshDimension = (typeof FRESH_DIMENSIONS)[number];

function error(code: string, severity: ReleaseError['severity'], pkg: string, message: string, remediation: string): ReleaseError {
  return { code, severity, message: `${pkg}: ${message}`, remediation, target: pkg };
}

function worst(evidence: readonly ReleaseError[], quietStatus: ScorecardStatus): ScorecardStatus {
  if (evidence.some(e => e.severity === 'error')) return 'fail';
  if (evidence.some(e => e.severity === 'warning')) return 'warn';
  return quietStatus;
}

/** `## 0.4.1` / `## [0.4.1]` — the first version heading of a changesets CHANGELOG. */
export function topChangelogVersion(changelog: string): string | null {
  const hit = /^##\s+\[?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\]?/m.exec(changelog);
  return hit?.[1] ?? null;
}

export type VersionRef = { readonly file: string; readonly name: string; readonly version: string };

/** Every `@arki/<x>@<version>` string in a text. */
export function findVersionRefs(file: string, text: string): VersionRef[] {
  return [...text.matchAll(/(@arki\/[a-z0-9-]+)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/g)].map(m => ({
    file,
    name: m[1] ?? '',
    version: m[2] ?? '',
  }));
}

/** Exported names that appear nowhere in the given docs text. */
export function unmentionedExports(names: readonly string[], docsText: string): string[] {
  return names.filter(name => !new RegExp(`(?<![A-Za-z0-9_$])${name.replaceAll('$', String.raw`\$`)}(?![A-Za-z0-9_$])`).test(docsText));
}

export type DocsFreshInput = {
  readonly pkg: string;
  readonly packageVersion: string;
  /** Error lines from `arki-library-check` for this package (each starts with its rule, e.g. `DOC_E006 ...`). */
  readonly libraryCheckErrors: readonly string[];
  /** `arki-doc-examples --json` result; `null` when it could not be obtained. */
  readonly docExamples: DocExamplesReport | null;
  /** Top CHANGELOG version; `null` when there is no CHANGELOG. */
  readonly changelogVersion: string | null;
  readonly versionRefs: readonly VersionRef[];
  /** `name@version` strings that exist on npm or in the candidate. */
  readonly knownVersions: ReadonlySet<string>;
  /** Exported names never mentioned in docs (warning only); computed by the loader. */
  readonly undocumentedExports: readonly string[];
};

export function evaluateDocsFresh(input: DocsFreshInput): ScorecardDimensionResult {
  const { pkg } = input;
  const evidence: ReleaseError[] = [];

  for (const line of input.libraryCheckErrors) {
    if (!line.startsWith('DOC_E006')) continue;
    evidence.push(error(FRESH_ERROR_CODES.llmsImportPaths, 'error', pkg, line, 'Edit the "Import paths" section of llms.txt so it lists exactly the package exports.'));
  }

  if (input.docExamples === null) {
    evidence.push(error(FRESH_ERROR_CODES.docExamples, 'error', pkg, 'no doc-examples result.', 'Run `bun run test:docs` in the package and pass its `arki-doc-examples --json` output.'));
  } else if (input.docExamples.failures.length > 0) {
    const first = input.docExamples.failures[0];
    evidence.push(
      error(
        FRESH_ERROR_CODES.docExamples,
        'error',
        pkg,
        `${String(input.docExamples.failures.length)} doc example failure(s), first ${first ? `${first.file}:${String(first.line)} ${first.rule}` : ''}.`,
        'Run `bun run test:docs` in the package and fix each listed example.',
      ),
    );
  }

  if (input.changelogVersion !== input.packageVersion) {
    evidence.push(
      error(
        FRESH_ERROR_CODES.changelogVersion,
        'error',
        pkg,
        `CHANGELOG top version is ${input.changelogVersion ?? 'missing'} but package.json is ${input.packageVersion}.`,
        'Run `changeset version` so CHANGELOG.md and package.json agree.',
      ),
    );
  }

  for (const ref of input.versionRefs) {
    if (input.knownVersions.has(`${ref.name}@${ref.version}`)) continue;
    evidence.push(
      error(
        FRESH_ERROR_CODES.unknownVersion,
        'error',
        pkg,
        `${ref.file} names ${ref.name}@${ref.version}, which is not published or in the candidate.`,
        `Change ${ref.file} to a published or candidate version of ${ref.name}.`,
      ),
    );
  }

  if (input.undocumentedExports.length > 0) {
    evidence.push(
      error(
        FRESH_ERROR_CODES.undocumentedExport,
        'warning',
        pkg,
        `exports never mentioned in README, docs/ or llms.txt: ${input.undocumentedExports.join(', ')}.`,
        'Mention each export in the README or docs, or confirm it is meant to be internal.',
      ),
    );
  }

  const status = worst(evidence, 'pass');
  return { status, details: status === 'pass' ? 'docs match the package' : `${String(evidence.length)} finding(s)`, evidence };
}

export type DocsFreshFiles = {
  readonly changelogVersion: string | null;
  readonly versionRefs: readonly VersionRef[];
  /** README + docs + llms.txt joined, for the exported-name check. */
  readonly docsText: string;
};

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function markdownIn(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter(e => e.isFile() && e.name.endsWith('.md')).map(e => path.join(e.parentPath, e.name));
}

/** Read CHANGELOG, README, llms.txt and docs/** of one package folder. */
export async function loadDocsFiles(packageDir: string): Promise<DocsFreshFiles> {
  const changelog = await readOptional(path.join(packageDir, 'CHANGELOG.md'));
  const files = [path.join(packageDir, 'README.md'), path.join(packageDir, 'llms.txt'), ...(await markdownIn(path.join(packageDir, 'docs')))];
  const refs: VersionRef[] = [];
  const texts: string[] = [];
  for (const file of files) {
    const text = await readOptional(file);
    if (text === null) continue;
    texts.push(text);
    refs.push(...findVersionRefs(path.relative(packageDir, file), text));
  }
  return { changelogVersion: changelog === null ? null : topChangelogVersion(changelog), versionRefs: refs, docsText: texts.join('\n') };
}

/** Every `types` file named in a package.json `exports` field (any condition depth). */
function typesFiles(exportsField: unknown): string[] {
  if (typeof exportsField !== 'object' || exportsField === null) return [];
  return Object.entries(exportsField).flatMap(([key, value]) =>
    key === 'types' && typeof value === 'string' ? [value] : typesFiles(value),
  );
}

const DECLARED_VALUE = /^export declare (?:abstract )?(?:const|let|var|function|class|enum|namespace) ([A-Za-z_$][\w$]*)/gm;
const NAMED_LIST = /^export \{([^}]*)\}/gm;
const STAR_AS = /^export \* as ([A-Za-z_$][\w$]*) from/gm;
const STAR_FROM = /^export \* from ['"](\.{1,2}\/[^'"]+)['"]/gm;

/**
 * Value names a package exports, read from its built `.d.ts` entry files
 * (following relative `export *`). Type-only exports are left out: the
 * undocumented-export check is about runtime API. Unbuilt entries give no
 * names, so the warning stays quiet rather than guessing from source.
 */
export async function exportedNames(packageDir: string, exportsField: unknown): Promise<string[]> {
  const names = new Set<string>();
  const seen = new Set<string>();
  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await readOptional(file);
    if (text === null) return;
    for (const m of text.matchAll(DECLARED_VALUE)) names.add(m[1] ?? '');
    for (const m of text.matchAll(STAR_AS)) names.add(m[1] ?? '');
    for (const m of text.matchAll(NAMED_LIST)) {
      for (const part of (m[1] ?? '').split(',')) {
        const spec = part.trim();
        if (spec === '' || spec.startsWith('type ')) continue;
        const name = spec.split(/\s+as\s+/).at(-1)?.trim() ?? '';
        if (name !== '' && name !== 'default') names.add(name);
      }
    }
    for (const m of text.matchAll(STAR_FROM)) {
      const target = path.resolve(path.dirname(file), (m[1] ?? '').replace(/\.js$/, ''));
      await visit(target.endsWith('.d.ts') ? target : `${target}.d.ts`);
    }
  };
  for (const rel of typesFiles(exportsField)) await visit(path.resolve(packageDir, rel));
  return [...names].filter(n => n !== '').toSorted();
}

/**
 * Provenance format (T2.4 must write exactly this): inside the README
 * `<!-- bench:start -->` ... `<!-- bench:end -->` block, one line
 * `provenance: <sha>` where `<sha>` is 7 to 40 lowercase hex characters,
 * the commit the idle benchmark run was made at. Example:
 *
 *   <!-- bench:start -->
 *   provenance: 3ab611cf9b0d4e1f7a2c5d8e9f0a1b2c3d4e5f60
 *   | op | ... |
 *   <!-- bench:end -->
 */
export function parseBenchProvenance(readme: string): string | null {
  const block = /<!--\s*bench:start\s*-->([\s\S]*?)<!--\s*bench:end\s*-->/.exec(readme);
  if (!block) return null;
  return /^provenance: ([0-9a-f]{7,40})\s*$/m.exec(block[1] ?? '')?.[1] ?? null;
}

export type BenchFreshInput = {
  /** Repository root, where git runs. */
  readonly root: string;
  readonly pkg: string;
  readonly dir: string;
  /** From `isLeafLibrary` (readiness.ts); other packages are not applicable. */
  readonly leaf: boolean;
  readonly readme: string;
  readonly git: GitRunner;
};

export async function evaluateBenchFresh(input: BenchFreshInput): Promise<ScorecardDimensionResult> {
  const { pkg, dir, git } = input;
  const cwd = { cwd: input.root };
  if (!input.leaf) return { status: 'pass', details: 'not a leaf library; no bench block required', evidence: [] };
  const sha = parseBenchProvenance(input.readme);
  if (sha === null) {
    return {
      status: 'fail',
      details: 'README has no bench block with a provenance line',
      evidence: [
        error(
          FRESH_ERROR_CODES.benchProvenanceMissing,
          'error',
          pkg,
          'README has no `<!-- bench:start -->` block containing `provenance: <sha>`.',
          'Founder idle run (F-5): run the package benchmarks and let the bench tool write the block with its provenance line.',
        ),
      ],
    };
  }
  const last = (await git(['log', '-1', '--format=%H', '--', `packages/${dir}/src`], cwd)).stdout.trim();
  if (last === '') return { status: 'pass', details: 'no source commits to compare against', evidence: [] };
  const full = await git(['rev-parse', '--verify', `${sha}^{commit}`], cwd);
  // Fresh when the last source change is the provenance commit or an ancestor of it.
  const fresh = full.code === 0 && (await git(['merge-base', '--is-ancestor', last, full.stdout.trim()], cwd)).code === 0;
  if (fresh) return { status: 'pass', details: `bench provenance ${sha} is at or after the last source change`, evidence: [] };
  return {
    status: 'fail',
    details: `bench provenance ${sha} is older than the last change to packages/${dir}/src`,
    evidence: [
      error(
        FRESH_ERROR_CODES.benchStale,
        'error',
        pkg,
        `bench numbers were measured at ${sha}, but packages/${dir}/src changed at ${last.slice(0, 10)}.`,
        'Founder idle run (F-5): re-run the benchmarks and commit the regenerated README block. CI never regenerates it.',
      ),
    ],
  };
}
