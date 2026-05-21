import { createFileRoute, notFound } from '@tanstack/react-router';

import { Article } from '@arki/content/components/article';
import { Shell } from '@arki/sitekit/components/shell';
import { PageContainer } from '@arki/sitekit/layout/workspace/page-container.tsx';

import { posts } from '~/content/util';
import { getDefaultMeta } from '~/shared-metadata';

export const Route = createFileRoute('/posts/$slug')({
  loader: ({ params }) => {
    const post = posts.find(p => p.slug === params.slug);
    if (!post) throw notFound();
    return { post };
  },
  head: ({ loaderData }) => {
    if (!loaderData) return {};
    const { title, description } = loaderData.post;
    return getDefaultMeta({ title, description });
  },
  component: PostPage,
});

function PostPage() {
  const { post } = Route.useLoaderData();

  const breadcrumbs = {
    items: [
      { label: 'Posts', href: '/posts' },
      { label: post.title, href: post.url },
    ],
  };

  return (
    <PageContainer breadcrumbs={breadcrumbs}>
      <Shell className="sm:py-8 md:py-12">
        <Article post={post} />
      </Shell>
    </PageContainer>
  );
}
