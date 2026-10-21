import { createFileRoute, notFound } from '@tanstack/react-router';

import { getDefaultMeta } from '~/shared-metadata';

import { getPackageDetailFn } from '../-package-data';
import { PackageDetailPage, packageMeta } from '../-package-detail';

/** A package's landing page: its latest snapshot (`next` while a candidate is newer than npm). */
export const Route = createFileRoute('/packages/$name/')({
  loader: async ({ params }) => {
    const detail = await getPackageDetailFn({ data: { short: params.name, version: null } });
    if (detail === null) throw notFound();
    return detail;
  },
  head: ({ loaderData }) => getDefaultMeta(packageMeta(loaderData)),
  component: LatestPackagePage,
});

function LatestPackagePage() {
  return <PackageDetailPage detail={Route.useLoaderData()} />;
}
