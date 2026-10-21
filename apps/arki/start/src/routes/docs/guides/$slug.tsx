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
    <main id="content">
      <div className="gd-article">
        <nav aria-label="Breadcrumb" className="dd-crumb">
          <a href="/docs">Docs</a> / <a href="/docs/guides">Guides</a> / <span aria-current="page">{guide.title}</span>
        </nav>
        <DocBody html={guide.html} headings={guide.headings} />
      </div>
    </main>
  );
}
