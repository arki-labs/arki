import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';
import { createFileRoute, notFound } from '@tanstack/react-router';

import { DocBody } from '~/features/site-data/doc-body';
import { getGuideFn } from '~/features/site-data/site-data';
import { getDefaultMeta } from '~/shared-metadata';

/** A cross-package guide from `src/content/guides/`. Package recipes stay on their package doc pages. */
export const Route = createFileRoute('/docs/guides/$slug')({
  loader: async ({ params }) => {
    const guide = await getGuideFn({ data: { slug: params.slug } });
    if (guide === null) throw notFound();
    return { guide };
  },
  head: ({ loaderData }) => (loaderData === undefined ? {} : getDefaultMeta({ title: loaderData.guide.title })),
  component: GuidePage,
});

function GuidePage() {
  const { guide } = Route.useLoaderData();

  return (
    <PageContainer
      breadcrumbs={{
        items: [
          { label: 'Docs', href: '/docs' },
          { label: 'Guides', href: '/docs/guides' },
          { label: guide.title, href: `/docs/guides/${guide.slug}` },
        ],
      }}
    >
      <Shell className="sm:py-8 md:py-12">
        <DocBody html={guide.html} headings={guide.headings} />
      </Shell>
    </PageContainer>
  );
}
