import type { PackageEntry } from '@arki/arki-release/site-schema';

import { latestSnapshotFolder } from '~/features/site-data/package-urls';

/** Pure rules of a package doc page (`/packages/<name>/<version>/<path>`). */

/**
 * The newest docs of the package when the folder on screen is not them: its folder and version. Null when the folder
 * on screen is the newest, or the package has no docs at all.
 */
export function newerDocs(entry: Pick<PackageEntry, 'status' | 'npmVersion' | 'nextVersion'>, folder: string) {
  const newest = latestSnapshotFolder(entry);
  const version = entry.status === 'next' ? entry.nextVersion : entry.npmVersion;
  if (newest === null || newest === folder || version === null) return null;
  return { folder: newest, version };
}

const sectionStart = /(?=<h2[\s>])/;
const tagPattern = /<[^>]*>/g;

/**
 * Wraps the "Check it" section of a compiled recipe (its `<h2>` and what follows up to the next `<h2>`) in a
 * `<section class="doc-check">`, so the page can draw it as a box. The text is the recipe's own; only a wrapper is added.
 */
export function wrapCheckSection(html: string): string {
  return html
    .split(sectionStart)
    .map(section => {
      const heading = /^<h2[\s>][\s\S]*?<\/h2>/.exec(section)?.[0];
      if (heading === undefined || heading.replaceAll(tagPattern, '').trim() !== 'Check it') return section;
      return `<section class="doc-check">${section}</section>`;
    })
    .join('');
}
