import { createFileRoute, notFound } from '@tanstack/react-router';

import { Mdx } from '@arki/content-react';
import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';

import { legals } from '~/content/util';

export const Route = createFileRoute('/legal/$slug')({
  loader: ({ params }) => {
    const post = legals.find(p => p.slug === params.slug);
    if (!post) throw notFound();
    return { post };
  },
  component: LegalPage,
});

function LegalPage() {
  const { post } = Route.useLoaderData();

  return (
    <PageContainer>
      <Shell className="sm:py-8 md:py-12">
        <article className="grid gap-8">
          <div className="mx-auto grid w-full max-w-prose gap-3">
            <h1 className="mb-5 text-3xl font-bold">{post.title}</h1>
          </div>
          <div className="mx-auto max-w-prose">
            <Mdx code={post.mdx} />
          </div>
        </article>
      </Shell>
    </PageContainer>
  );
}
