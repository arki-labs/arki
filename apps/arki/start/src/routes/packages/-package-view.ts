import type { PackageEntry, SnapshotMeta } from '@arki/arki-release/site-schema';

import { packageDocHref, packageHref } from '~/features/site-data/package-urls';

import type { PillKind } from './-package-list';

/** Pure view rules of the package page: what each label, banner and health pill says, from the page data alone. */

type Entry = Pick<PackageEntry, 'short' | 'npmVersion' | 'nextVersion' | 'versions'>;
type Snapshot = Pick<SnapshotMeta, 'channel' | 'version' | 'archive'>;
type ExampleReport = NonNullable<SnapshotMeta['examples']>;

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The snapshot folder a version row links to: `next` for the candidate, else the npm version. */
export function folderOf(version: PackageEntry['versions'][number]): string {
  return version.channel === 'next' ? 'next' : version.version;
}

/** True when `version` is a published version whose snapshot is an archive. */
export function isArchivedOnNpm(entry: Pick<PackageEntry, 'versions'>, version: string | null): boolean {
  return entry.versions.some(
    candidate => candidate.channel === 'published' && candidate.version === version && candidate.archive,
  );
}

/** What the version picker says next to a version: `next: not on npm yet`, `latest on npm · archive`, `archive` or nothing. */
export function versionLabel(
  entry: Pick<PackageEntry, 'npmVersion'>,
  version: PackageEntry['versions'][number],
): string {
  if (version.channel === 'next') return 'next: not on npm yet';
  return [version.version === entry.npmVersion ? 'latest on npm' : null, version.archive ? 'archive' : null]
    .filter(part => part !== null)
    .join(' · ');
}

/** The short channel word on the picker button. */
export function channelWord(entry: Pick<PackageEntry, 'npmVersion'>, snapshot: Snapshot): string {
  if (snapshot.channel === 'next') return 'next';
  if (snapshot.archive) return 'archive';
  return snapshot.version === entry.npmVersion ? 'latest' : 'older';
}

/** Status of the version on screen, the key of `STATUS_PILL`. A package with no snapshot is `none`. */
export function snapshotStatus(snapshot: Snapshot | null): PackageEntry['status'] {
  if (snapshot === null) return 'none';
  if (snapshot.channel === 'next') return 'next';
  return snapshot.archive ? 'archive' : 'published';
}

const dayFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

function dayOf(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : dayFormat.format(date);
}

export type Banner = {
  kind: 'info' | 'muted';
  glyph: string;
  title: string;
  text: string;
  more: string;
  link: { href: string; label: string } | null;
};

/**
 * The note under the header: a candidate that is not on npm yet, an archived version, or an older version that is
 * still supported. The newest supported version on npm has none.
 */
export function bannerOf(entry: Entry, snapshot: Snapshot & Pick<SnapshotMeta, 'candidate'>): Banner | null {
  const { version } = snapshot;
  const { npmVersion, nextVersion } = entry;
  const newest =
    npmVersion !== null && npmVersion !== version
      ? { href: packageHref(entry.short), label: `Read the ${npmVersion} page` }
      : null;

  if (snapshot.channel === 'next') {
    const built =
      snapshot.candidate === null
        ? ''
        : `, built from commit ${snapshot.candidate.sourceCommit.slice(0, 7)} on ${dayOf(snapshot.candidate.createdAt)}`;
    return {
      kind: 'info',
      glyph: '◐',
      title: `${version} is not on npm yet.`,
      text: `It is the release candidate for v${version}${built}. The docs on this page are for ${version}.`,
      more:
        npmVersion === null
          ? 'No version is on npm yet.'
          : `On npm now: ${npmVersion}${isArchivedOnNpm(entry, npmVersion) ? ', which is archived and not supported' : ''}.`,
      link: null,
    };
  }
  if (snapshot.archive) {
    return {
      kind: 'muted',
      glyph: '▪',
      title: `${version} is archived.`,
      text: 'It is still on npm, but it is not supported.',
      more: nextVersion === null ? '' : `The next version, ${nextVersion}, is a release candidate and not on npm yet.`,
      link: nextVersion === null ? newest : { href: packageHref(entry.short), label: `Read the ${nextVersion} page` },
    };
  }
  if (newest === null) return null;
  return {
    kind: 'muted',
    glyph: '↑',
    title: `You are reading ${version}.`,
    text: `The newest version on npm is ${npmVersion}.`,
    more: '',
    link: newest,
  };
}

/** Pills of the doc-examples panel: compiled, run, skipped, and failing only when something fails. */
export function examplePills(report: Pick<ExampleReport, 'compiled' | 'ran' | 'skipped' | 'failures'>) {
  const pills: { kind: PillKind; glyph: string; label: string }[] = [
    { kind: 'st-ok', glyph: '✓', label: `${report.compiled} compiled` },
    { kind: 'st-ok', glyph: '▶', label: `${report.ran} run` },
    { kind: 'st-muted', glyph: '–', label: `${report.skipped} skipped` },
  ];
  if (report.failures.length > 0) pills.push({ kind: 'st-bad', glyph: '✕', label: `${report.failures.length} failing` });
  return pills;
}

/**
 * When every failing example is in one file, that file and the doc page it renders as (null when the file is not a
 * page of the snapshot). Failures spread over several files are not summarised.
 */
export function failureFile(
  report: Pick<ExampleReport, 'failures'>,
  entry: Pick<PackageEntry, 'short'>,
  snapshot: Pick<SnapshotMeta, 'files'>,
  folder: string,
) {
  const [first] = report.failures;
  if (first === undefined || report.failures.some(failure => failure.file !== first.file)) return null;
  const isPage = first.file.endsWith('.md') && snapshot.files.includes(first.file);
  return {
    file: first.file,
    count: report.failures.length,
    href: isPage ? packageDocHref(entry.short, folder, first.file.slice(0, -'.md'.length)) : null,
  };
}

/** The `<summary>` over the skipped examples. */
export function skipSummary(skipped: number): string {
  return `Why ${plural(skipped, 'example was', 'examples were')} skipped`;
}

/** `2 release checks fail · 1 gap was found by demos`. Empty for no gaps. */
export function gapLine(gaps: PackageEntry['openGaps']): string {
  const checks = gaps.filter(gap => gap.kind === 'readiness').length;
  const fromDemos = gaps.length - checks;
  return [
    checks > 0 ? `${checks} ${checks === 1 ? 'release check fails' : 'release checks fail'}` : null,
    fromDemos > 0 ? `${fromDemos} ${fromDemos === 1 ? 'gap was' : 'gaps were'} found by demos` : null,
  ]
    .filter(part => part !== null)
    .join(' · ');
}

/** How a demo's pin compares with the newest npm version. An unknown pin is not called out of date. */
export function demoLag(pin: string | null, npmVersion: string | null) {
  if (pin === null) return { kind: 'st-muted', glyph: '?', text: 'pin not found', outdated: false } as const;
  if (npmVersion === null || pin === npmVersion) {
    return { kind: 'st-ok', glyph: '●', text: `pins ${pin}`, outdated: false } as const;
  }
  return { kind: 'st-warn', glyph: '▲', text: `pins ${pin}, behind ${npmVersion} on npm`, outdated: true } as const;
}

const FIRST_NAMES = 4;

type ImportRow = { names: readonly { name: string }[]; groups: readonly { count: number }[] };

/** Every export of a subpath: its named exports plus the names its groups stand for. */
export function exportCount(row: ImportRow): number {
  return row.names.length + row.groups.reduce((sum, group) => sum + group.count, 0);
}

/** The first names of a subpath, comma separated, with an ellipsis when more follow. */
export function firstNames(row: ImportRow): string {
  const shown = row.names
    .slice(0, FIRST_NAMES)
    .map(entry => entry.name)
    .join(', ');
  if (exportCount(row) <= Math.min(FIRST_NAMES, row.names.length)) return shown;
  return shown === '' ? '…' : `${shown}, …`;
}

/** `<pre>` blocks of compiled HTML become keyboard-focusable, so a long line can be scrolled without a mouse. */
export function withFocusableCode(html: string): string {
  return html.replaceAll(/<pre((?:\s[^>]*)?)>/g, (tag, attributes: string) =>
    /\btabindex\b/.test(attributes) ? tag : `<pre tabindex="0"${attributes}>`,
  );
}
