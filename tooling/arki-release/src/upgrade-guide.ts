/**
 * Upgrade guides: one file per minor of a Tier 1 Stack package,
 * `packages/<name>/docs/upgrades/<from>-to-<to>.md`.
 *
 *   upgrade-guide --package <name> --from <v> --to <v> [--write] [--api-diff <file>]
 *     builds a skeleton from the package's pending `minor` changesets plus an
 *     API-diff section. The diff is `--api-diff` (the `arki-api-diff --json`
 *     output) or, without it, produced here: the published `<from>` tarball's
 *     `dist/api.json` against the local build. Every place a person or agent
 *     must write carries a `<!-- upgrade:todo ... -->` marker.
 *
 * `ship` calls `checkGuide`: a Stack package that bumps minor needs a guide
 * with no marker left (GUIDE_E001). No codemods: the first one lands with the
 * first mechanical breaking change.
 */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { diffApi, type ApiDiff } from '@arki/library-tooling/src/api-diff';
import { apiIndexSchema, buildApiIndex, type ApiGroup } from '@arki/library-tooling/src/api-index';
import { z } from 'zod';

import { npmPackOutputSchema, readTarballText } from './candidate';
import { loadChangesets, type Changeset } from './impact';
import { discoverManifests } from './inventory';
import { createEnvelope } from './json-output';
import type { NpmRunner } from './runners';
import type { ReleaseCommandEnvelope, ReleaseError } from './types';

export const GUIDE_ERROR_CODES = {
  /** A Stack package bumps minor and its guide is missing or still has a marker. */
  missingOrUnfinished: 'GUIDE_E001',
  /** Bad flags, unknown package, or unreadable api diff. */
  usage: 'GUIDE_E002',
  /** `--write` would overwrite a guide that already exists. */
  exists: 'GUIDE_E003',
} as const;

/** The text every skeleton marker starts with; `ship` fails while any is left. */
export const GUIDE_MARKER = '<!-- upgrade:todo';
const MARKER_PATTERN = /<!--\s*upgrade:todo/;

export function guideCommand(pkg: string, from: string, to: string): string {
  return `bun release:arki upgrade-guide --package ${pkg} --from ${from} --to ${to} --write`;
}

/** Repo-relative path of the guide for a package directory. */
export function guideRelativePath(packageDir: string, from: string, to: string): string {
  return path.posix.join(packageDir.split(path.sep).join('/'), 'docs', 'upgrades', `${from}-to-${to}.md`);
}

export function hasGuideMarker(text: string): boolean {
  return MARKER_PATTERN.test(text);
}

/** The next minor after `version` (`0.3.4` -> `0.4.0`), or null if it is not plain semver. */
export function nextMinor(version: string): string | null {
  const match = /^(\d+)\.(\d+)\.\d+/.exec(version);
  return match === null ? null : `${match[1] ?? '0'}.${String((Number(match[2]) || 0) + 1)}.0`;
}

function noteLines(body: string): string {
  const lines = body.trim().split('\n').map(line => line.trimEnd());
  return lines.map((line, i) => (i === 0 ? `- ${line}` : `  ${line}`)).join('\n');
}

/** How users import a subpath: `.` is the package itself. */
function importPath(pkg: string, subpath: string): string {
  return subpath === '.' ? pkg : `${pkg}/${subpath.replace(/^\.\//, '')}`;
}

function apiDiffSection(pkg: string, diff: ApiDiff | undefined): string {
  if (diff === undefined) {
    return '<!-- upgrade:todo no api diff was available; run arki-api-diff on both api.json files and describe public API changes here, or write "No public API changes." -->';
  }
  const where = (entry: { readonly subpath: string; readonly name: string }): string =>
    `\`${entry.name}\` from \`${importPath(pkg, entry.subpath)}\``;
  const parts: string[] = [];
  if (diff.removed.length > 0) parts.push(`Removed:\n${diff.removed.map(e => `- ${where(e)} (${e.kind})`).join('\n')}`);
  if (diff.changed.length > 0) {
    parts.push(`Changed:\n${diff.changed.map(c => `- ${where(c)}\n  - before: \`${c.from}\`\n  - after: \`${c.to}\``).join('\n')}`);
  }
  if (diff.changedGroups.length > 0) {
    parts.push(
      `Changed (each name below has the same change):\n${diff.changedGroups
        .map(
          c =>
            `- ${c.count.toString()} ${c.kind} exports from \`${importPath(pkg, c.subpath)}\`\n  - before: \`${c.from}\`\n  - after: \`${c.to}\``,
        )
        .join('\n')}`,
    );
  }
  if (diff.added.length > 0) parts.push(`Added:\n${diff.added.map(e => `- ${where(e)} (${e.kind})`).join('\n')}`);
  return parts.length > 0 ? parts.join('\n\n') : 'No public API changes.';
}

/**
 * The API diff from the published `from` version to the local build: the
 * `dist/api.json` of `npm pack <pkg>@<from>` against `buildApiIndex` of the
 * package folder. Null when either side is missing (that version predates
 * api.json, npm is unreachable, or the package is not built), so the guide
 * keeps its marker instead of listing a wrong diff.
 */
export async function publishedApiDiff(input: {
  readonly pkg: string;
  readonly from: string;
  /** Absolute package folder with a built `dist/`. */
  readonly packageDir: string;
  readonly npm: NpmRunner;
}): Promise<ApiDiff | null> {
  let built: ReturnType<typeof buildApiIndex>;
  try {
    built = buildApiIndex(input.packageDir);
  } catch {
    return null;
  }
  // A subpath without built types would show up as every name removed.
  if (built.skipped.length > 0) return null;
  const temp = await mkdtemp(path.join(tmpdir(), 'arki-guide-'));
  try {
    const out = await input.npm(['pack', `${input.pkg}@${input.from}`, '--json', '--pack-destination', temp], { cwd: temp });
    if (out.code !== 0) return null;
    const packed = npmPackOutputSchema.safeParse(JSON.parse(out.stdout));
    const filename = packed.success ? packed.data[0]?.filename : undefined;
    if (filename === undefined) return null;
    const text = await readTarballText(path.join(temp, path.basename(filename)), 'dist/api.json');
    const before = text === null ? null : apiIndexSchema.safeParse(JSON.parse(text));
    if (before?.success !== true) return null;
    // Group names live in sibling files of the same tarball; a missing one means no trustworthy diff.
    const namesByFile = new Map<string, readonly string[]>();
    for (const group of before.data.groups) {
      const namesText = await readTarballText(path.join(temp, path.basename(filename)), `dist/${group.namesFile}`);
      if (namesText === null) return null;
      namesByFile.set(group.namesFile, z.array(z.string()).parse(JSON.parse(namesText)));
    }
    const oldNames = (group: ApiGroup): readonly string[] => namesByFile.get(group.namesFile) ?? [];
    return diffApi(
      { index: before.data, namesOf: oldNames },
      { index: built.index, namesOf: group => built.names.get(group.namesFile) ?? [] },
    );
  } catch {
    return null;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

export interface GuideInput {
  readonly pkg: string;
  readonly from: string;
  readonly to: string;
  /** Pending changesets that bump `pkg` by `minor`. */
  readonly changesets: readonly Changeset[];
  readonly apiDiff?: ApiDiff;
}

/** The skeleton. Deterministic: same input, same bytes. */
export function renderGuide(input: GuideInput): string {
  const { pkg, from, to } = input;
  const notes = input.changesets.length > 0
    ? input.changesets.map(c => noteLines(c.body)).join('\n')
    : '<!-- upgrade:todo no minor changeset was found; list what changed in this minor. -->';
  return [
    `# Upgrade ${pkg} ${from} to ${to}`,
    '',
    '<!-- upgrade:todo one sentence: who must act on this upgrade and who can skip it. -->',
    '',
    '## What changed',
    '',
    notes,
    '',
    '## Public API changes',
    '',
    apiDiffSection(pkg, input.apiDiff),
    '',
    '## Steps',
    '',
    '<!-- upgrade:todo numbered steps, each with the before and after code, in the order a user must do them. -->',
    '',
    '## Verify',
    '',
    '<!-- upgrade:todo one command whose output proves the upgrade worked. -->',
    '',
  ].join('\n');
}

export type GuideState = 'ok' | 'missing' | 'unfinished';

/** Is the guide for this minor present and free of markers? */
export async function checkGuide(root: string, packageDir: string, from: string, to: string): Promise<GuideState> {
  const file = path.join(root, guideRelativePath(packageDir, from, to));
  if (!existsSync(file)) return 'missing';
  return hasGuideMarker(await readFile(file, 'utf8')) ? 'unfinished' : 'ok';
}

/** The GUIDE_E001 error `ship` and this command share. */
export function guideError(pkg: string, packageDir: string, from: string, to: string, state: Exclude<GuideState, 'ok'>): ReleaseError {
  const file = guideRelativePath(packageDir, from, to);
  return {
    code: GUIDE_ERROR_CODES.missingOrUnfinished,
    severity: 'error',
    message:
      state === 'missing'
        ? `${pkg} bumps minor (${from} to ${to}) but ${file} does not exist.`
        : `${file} still contains \`${GUIDE_MARKER}\` markers.`,
    remediation:
      state === 'missing'
        ? `${guideCommand(pkg, from, to)}, then replace every ${GUIDE_MARKER} marker with real text.`
        : `Replace every ${GUIDE_MARKER} marker in ${file} with real text. To start over: delete the file and run \`${guideCommand(pkg, from, to)}\`.`,
    target: pkg,
  };
}

export interface UpgradeGuideOptions {
  readonly root: string;
  readonly pkg: string;
  readonly from: string;
  readonly to: string;
  readonly write: boolean;
  /** A diff to use as it is; without it, `npm` is used to produce one (`publishedApiDiff`). */
  readonly apiDiff?: ApiDiff;
  readonly npm?: NpmRunner;
}

export interface UpgradeGuideItem {
  readonly path: string;
  readonly written: boolean;
  readonly markers: number;
  /** Where the API section came from; `none` leaves its marker. */
  readonly apiDiff: 'given' | 'produced' | 'none';
  readonly content: string;
}
export type UpgradeGuideEnvelope = ReleaseCommandEnvelope<UpgradeGuideItem, { readonly message: string }>;

function failure(message: string, code: string, remediation: string, target?: string): UpgradeGuideEnvelope {
  return createEnvelope({
    command: 'upgrade-guide',
    status: 'failure',
    summary: { message },
    errors: [{ code, severity: 'error', message, remediation, ...(target === undefined ? {} : { target }) }],
  });
}

export async function runUpgradeGuide(options: UpgradeGuideOptions): Promise<UpgradeGuideEnvelope> {
  const { root, from, to } = options;
  const pkg = options.pkg.startsWith('@arki/') ? options.pkg : `@arki/${options.pkg}`;
  const { manifests } = await discoverManifests(root);
  const manifest = manifests.find(m => m.name === pkg);
  if (manifest === undefined) {
    return failure(`${pkg} is not a workspace package.`, GUIDE_ERROR_CODES.usage, 'Pass `--package <name>` as the `@arki/*` name or the bare name.', pkg);
  }
  const packageDir = path.relative(root, path.dirname(path.resolve(root, manifest.manifestPath)));
  const { changesets } = await loadChangesets(root);
  const minors = changesets.filter(c => c.bumps[pkg] === 'minor');
  const produced =
    options.apiDiff === undefined && options.npm !== undefined
      ? await publishedApiDiff({ pkg, from, packageDir: path.resolve(root, packageDir), npm: options.npm })
      : null;
  const apiDiff = options.apiDiff ?? produced ?? undefined;
  const content = renderGuide({ pkg, from, to, changesets: minors, ...(apiDiff === undefined ? {} : { apiDiff }) });
  const relative = guideRelativePath(packageDir, from, to);
  const markers = content.split('\n').filter(line => MARKER_PATTERN.test(line)).length;
  if (options.write) {
    const file = path.join(root, relative);
    if (existsSync(file)) {
      return failure(`${relative} already exists; it was not overwritten.`, GUIDE_ERROR_CODES.exists, `Edit ${relative} by hand, or delete it first to regenerate the skeleton.`, pkg);
    }
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  return createEnvelope({
    command: 'upgrade-guide',
    status: options.write ? 'warning' : 'success',
    summary: {
      message: options.write
        ? `Wrote ${relative} with ${String(markers)} marker(s). Replace each ${GUIDE_MARKER} marker; ship fails until none is left.`
        : `Skeleton for ${relative} (${String(markers)} marker(s)). Add --write to create it.`,
    },
    items: [{ path: relative, written: options.write, markers, apiDiff: options.apiDiff !== undefined ? 'given' : produced !== null ? 'produced' : 'none', content }],
    errors: options.write
      ? [{ code: GUIDE_ERROR_CODES.missingOrUnfinished, severity: 'warning', message: `${relative} has ${String(markers)} unfinished marker(s).`, remediation: `Replace every ${GUIDE_MARKER} marker with real text.`, target: pkg }]
      : [],
  });
}
