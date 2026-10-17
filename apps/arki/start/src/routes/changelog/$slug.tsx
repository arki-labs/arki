import { createFileRoute, notFound } from '@tanstack/react-router';

import { Separator } from '@arki/ui/separator';
import { ChangelogCard, ChangelogPagination } from '@arki/content-react';
import { Shell } from '@fleet/sitekit/components/shell';
import { PageContainer } from '@fleet/sitekit/layout/workspace/page-container.tsx';

import { changelogBySlug, changelogs } from '~/content/util';
import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/changelog/$slug')({
  loader: ({ params }) => {
    const post = changelogBySlug(params.slug);
    if (!post) throw notFound();
    return { post };
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { title, description } = loaderData.post;
    return getDefaultMeta({ title, description });
  },
  component: ChangelogPage,
});

function ChangelogPage() {
  const { post } = Route.useLoaderData();
  const findIndex = changelogs.findIndex(c => c.slug === post.slug);

  const breadcrumbs = {
    items: [
      { label: 'Changelog', href: '/changelog' },
      { label: post.title, href: post.url },
    ],
  };

  return (
    <PageContainer breadcrumbs={breadcrumbs}>
      <Shell className="flex flex-col gap-8 sm:py-8 md:gap-12 md:py-12">
        <ChangelogCard post={post} />
        <Separator className="mx-auto max-w-prose" />
        <ChangelogPagination {...{ prev: changelogs[findIndex - 1], next: changelogs[findIndex + 1] }} />
      </Shell>
    </PageContainer>
  );
}
