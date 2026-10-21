import { createServerFn } from '@tanstack/react-start';

import { z } from '@arki/contracts';

import { latestSnapshotFolder } from '~/features/site-data/package-urls';
import {
  getPackageDocFn,
  getApiIndexFn,
  getPackageFn,
  listDemosFn,
  listPackageDocsFn,
  listPackagesFn,
} from '~/features/site-data/site-data';

import { withFocusableCode } from './-package-view';
import { publicImports } from './-public-imports';
import { readmePurpose, withoutLeadingTitle } from './-readme-text';

/**
 * Server functions for the `/packages` pages. They combine the site-data functions on the server, so a page load is
 * one request and README HTML that only feeds a one-line purpose never reaches the browser.
 */

/** Every package with the purpose line of its latest README (null when it has no snapshot or no paragraph). */
export const listPackageRowsFn = createServerFn({ method: 'GET' }).handler(async () => {
  const entries = await listPackagesFn();
  return Promise.all(
    entries.map(async entry => {
      const folder = latestSnapshotFolder(entry);
      const readme =
        folder === null ? null : await getPackageDocFn({ data: { short: entry.short, version: folder, path: 'README' } });
      return { ...entry, purpose: readme === null ? null : readmePurpose(readme.doc.html) };
    }),
  );
});

/**
 * One package page. `version` is a snapshot folder (an npm version or `next`); null means the latest one. Returns
 * null for an unknown package or an unknown version. A package with no snapshot at all (`status: none`) still has a
 * page: `snapshot` is null and the page says no docs are published yet.
 */
export const getPackageDetailFn = createServerFn({ method: 'GET' })
  .validator(z.object({ short: z.string(), version: z.string().nullable() }))
  .handler(async ({ data }) => {
    const entry = await getPackageFn({ data: { short: data.short } });
    if (entry === null) return null;
    const allDemos = await listDemosFn();
    const demos = entry.demos.map(demo => ({
      ...demo,
      repo: allDemos.find(candidate => candidate.name === demo.name)?.repo ?? null,
    }));

    const folder = data.version ?? latestSnapshotFolder(entry);
    if (folder === null) {
      return { package: entry, demos, folder, purpose: null, snapshot: null, docs: [], readme: null, imports: null };
    }

    const snapshotRef = { short: entry.short, version: folder };
    const [listing, readme, apiIndex] = await Promise.all([
      listPackageDocsFn({ data: snapshotRef }),
      getPackageDocFn({ data: { ...snapshotRef, path: 'README' } }),
      getApiIndexFn({ data: snapshotRef }),
    ]);
    if (listing === null) return null;

    return {
      package: entry,
      demos,
      folder,
      purpose: readme === null ? null : readmePurpose(readme.doc.html),
      snapshot: listing.snapshot,
      docs: listing.docs.filter(doc => doc.path !== 'README').map(doc => ({ path: doc.path, title: doc.title })),
      readme: readme === null ? null : { html: withFocusableCode(withoutLeadingTitle(readme.doc.html)), headings: readme.doc.headings },
      imports: apiIndex === null ? null : publicImports(apiIndex),
    };
  });
