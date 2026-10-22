import { createFileRoute, notFound } from '@tanstack/react-router';

import { getDefaultMeta } from '~/shared-metadata';
import { DrawingSet } from '~/shared/marketing/drawing-set';
import { JournalChapter } from '~/shared/marketing/journal-chapter';
import { getPackageDetailFn } from '../-package-data';
import { PackageDetailPage, packageMeta } from '../-package-detail';

/**
 * `@arki/journal`'s landing page: the `$name` page plus the homepage's journal chapter. It is its own route so the
 * chapter and its stylesheet ship in this route's lazy chunk, and no other package page downloads them.
 */
export const Route = createFileRoute('/packages/journal/')({
  loader: async () => {
    const detail = await getPackageDetailFn({ data: { short: 'journal', version: null } });
    if (detail === null) throw notFound();
    return detail;
  },
  head: ({ loaderData }) => getDefaultMeta(packageMeta(loaderData)),
  component: JournalPackagePage,
});

function JournalPackagePage() {
  return (
    <PackageDetailPage
      detail={Route.useLoaderData()}
      inVersion={false}
      walkthrough={
        <DrawingSet>
          <JournalChapter headline />
        </DrawingSet>
      }
    />
  );
}
