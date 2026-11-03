import { createParser, createSearchParamsCache, parseAsInteger } from 'nuqs/server';
import { useTranslations } from 'use-intl';

import type { LinkComponent } from '@arki/intl/react';
import { Rss } from '@arki/icons/phosphor';
import { Button } from '@arki/ui/button';
import { Pagination, PaginationContent, PaginationLink } from '@arki/ui/pagination';

import { Timeline } from './timeline.js';

/** What the posts timeline reads from each post. A content-build `Post` has these fields. */
export type TimelinePost = {
  slug: string;
  title: string;
  description: string;
  publishedAt: Date;
  image: { url: string; blurDataURL?: string | undefined };
};

const parseAsPageIndex = createParser({
  parse(queryValue) {
    const parsed = parseAsInteger.parse(queryValue);
    if (!parsed || parsed < 0) return 0;

    return parsed;
  },
  serialize(value) {
    return value.toString();
  },
});

const ITEMS_PER_PAGE = 10;

const searchParamsParsers = {
  p: parseAsPageIndex.withDefault(0),
};

const searchParamsCache = createSearchParamsCache(searchParamsParsers);

export const PostsTimeline = ({
  appTitle,
  posts,
  searchParams,
  Link,
}: {
  appTitle: string;
  posts: readonly TimelinePost[];
  searchParams: Record<'p', string | string[] | undefined>;
  Link: LinkComponent;
}) => {
  const { p } = searchParamsCache.parse(searchParams);
  const maxPageIndex = Math.ceil(posts.length / ITEMS_PER_PAGE) - 1;

  const page = Math.min(p, maxPageIndex);

  const paginatedPosts = posts.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

  const t = useTranslations('PostsTimeline');

  return (
    <Timeline
      title={t('title')}
      description={t('description', { appTitle })}
      actions={
        <Button variant="outline" size="icon" asChild>
          <Link href="/posts/feed.xml" target="_blank" rel="noreferrer">
            <Rss className="h-4 w-4" />
            <span className="sr-only">{t('rssFeed')}</span>
          </Link>
        </Button>
      }
    >
      {paginatedPosts.map(post => (
        <Timeline.Article
          key={post.slug}
          publishedAt={post.publishedAt}
          imageSrc={post.image.url}
          title={post.title}
          href={`/posts/${post.slug}`}
          blurDataURL={post.image.blurDataURL}
          Link={Link}
        >
          <div className="prose dark:prose-invert">
            <p>{post.description}</p>
          </div>
          <div>
            <Button variant="outline" className="rounded-full" asChild>
              <Link href={`/posts/${post.slug}`}>{t('readMore')}</Link>
            </Button>
          </div>
        </Timeline.Article>
      ))}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-5 md:gap-6">
        <div className="row-span-2" />
        <div className="w-full md:order-2 md:col-span-4">
          <Pagination>
            <PaginationContent>
              {Array.from({ length: maxPageIndex + 1 }).map((_, index) => {
                return (
                  <PaginationLink key={index} href={`?p=${index}`} isActive={p === index}>
                    {index + 1}
                  </PaginationLink>
                );
              })}
            </PaginationContent>
          </Pagination>
        </div>
      </div>
    </Timeline>
  );
};
