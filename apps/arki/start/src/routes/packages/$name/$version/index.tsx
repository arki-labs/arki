import { createFileRoute, notFound } from '@tanstack/react-router';

import { getDefaultMeta } from '~/shared-metadata';

import { getPackageDetailFn } from '../../-package-data';
import { PackageDetailPage, packageMeta } from '../../-package-detail';

/** One snapshot of a package: an npm version or `next`. Same page as the landing page, pinned to that version. */
export const Route = createFileRoute('/packages/$name/$version/')({
  loader: async ({ params }) => {
    const detail = await getPackageDetailFn({ data: { short: params.name, version: params.version } });
    if (detail === null) throw notFound();
    return detail;
  },
  head: ({ loaderData }) => getDefaultMeta(packageMeta(loaderData)),
  component: PackageVersionPage,
});

function PackageVersionPage() {
  return <PackageDetailPage detail={Route.useLoaderData()} inVersion />;
}
