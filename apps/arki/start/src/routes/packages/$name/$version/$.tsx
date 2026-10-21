import { createFileRoute, notFound } from '@tanstack/react-router';

import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';

import { DocBody } from '~/features/site-data/doc-body';
import { packageHref } from '~/features/site-data/package-urls';
import { getPackageDocFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';

/** Any doc of a snapshot by its path without `.md`: `/packages/dot/next/docs/quickstart`. */
export const Route = createFileRoute('/packages/$name/$version/$')({
  loader: async ({ params }) => {
    const page = await getPackageDocFn({ data: { short: params.name, version: params.version, path: params._splat ?? '' } });
    if (page === null) throw notFound();
    return page;
  },
  head: ({ loaderData }) => {
    if (loaderData === undefined) return {};
    return getDefaultMeta({ title: `${loaderData.doc.title} | ${loaderData.package.name}@${loaderData.snapshot.version}` });
  },
  component: PackageDocPage,
});

function PackageDocPage() {
  const { package: entry, snapshot, doc } = Route.useLoaderData();
  const { version } = Route.useParams();
  const versionHref = `${packageHref(entry.short)}/${version}`;

  const breadcrumbs = {
    items: [
      { label: 'Packages', href: '/packages' },
      { label: entry.name, href: packageHref(entry.short) },
      { label: snapshot.version, href: versionHref },
      { label: doc.title, href: `${versionHref}/${doc.path}` },
    ],
  };

  return (
    <PageContainer breadcrumbs={breadcrumbs}>
      <Shell className="sm:py-8 md:py-12">
        <DocBody html={doc.html} headings={doc.headings} snapshot={snapshot} />
        <p>
          <a href={versionHref}>All docs for {`${entry.name}@${snapshot.version}`}</a>
        </p>
      </Shell>
    </PageContainer>
  );
}
