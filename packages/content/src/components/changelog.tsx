import { createParser, createSearchParamsCache, parseAsInteger } from 'nuqs/server';
import { useTranslations } from 'use-intl';

import type { LinkComponent } from '@arki/intl/react';
import { format } from '@arki/date/format';
import { CaretLeft, CaretRight, Rss } from '@arki/icons/phosphor';
import { Button } from '@arki/ui/button';
import { Pagination, PaginationContent, PaginationLink } from '@arki/ui/pagination';

import type { Changelog } from '../models';
import { Mdx } from './mdx';
import { Timeline } from './timeline';

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

export const ITEMS_PER_PAGE = 10;

export const searchParamsParsers = {
  p: parseAsPageIndex.withDefault(0),
};

export const searchParamsCache = createSearchParamsCache(searchParamsParsers);

export function ChangelogTimeline({
  posts,
  Link,
  searchParams,
  appTitle,
}: {
  posts: Changelog[];
  Link: LinkComponent;
  searchParams: Record<string, string | string[] | undefined>;
  appTitle: string;
}) {
  const { p } = searchParamsCache.parse(searchParams);

  const t = useTranslations('ChangelogTimeline');

  const MAX_PAGE_INDEX = Math.ceil(posts.length / ITEMS_PER_PAGE) - 1;
  const page = Math.min(p, MAX_PAGE_INDEX);

  const paginatedChangelogs = posts.slice(page * ITEMS_PER_PAGE, (page + 1) * ITEMS_PER_PAGE);

  return (
    <Timeline
      title={t('title')}
      description={t('description', { appTitle })}
      actions={
        <Button variant="outline" size="icon" asChild>
          <a href="/changelog/feed.xml" target="_blank" rel="noreferrer">
            <Rss className="h-4 w-4" />
            <span className="sr-only">{t('rssFeed')}</span>
          </a>
        </Button>
      }
    >
      {paginatedChangelogs.map(changelog => (
        <Timeline.Article
          key={changelog.slug}
          publishedAt={changelog.publishedAt}
          imageSrc={changelog.image.url}
          title={changelog.title}
          href={`/changelog/${changelog.slug}`}
          blurDataURL={changelog.image.blurDataURL}
          Link={Link}
        >
          <Mdx code={changelog.content.mdx} />
        </Timeline.Article>
      ))}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-5 md:gap-6">
        <div className="row-span-2" />
        <div className="w-full md:order-2 md:col-span-4">
          <Pagination>
            <PaginationContent>
              {Array.from({ length: MAX_PAGE_INDEX + 1 }).map((_, index) => {
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
}
export function ChangelogPagination({ prev, next }: { prev?: Changelog; next?: Changelog }) {
  return (
    <div className="mx-auto flex w-full max-w-prose items-center justify-between">
      <div />
      {prev ? (
        <div className="w-1/2 flex-1 text-left">
          <Button asChild variant="link">
            <a href={`/changelog/${prev.slug}`} className="group">
              <CaretLeft className="mr-2 h-4 w-4 text-muted-foreground group-hover:text-foreground" />
              <span className="truncate">{prev.title}</span>
            </a>
          </Button>
        </div>
      ) : (
        <div />
      )}
      {next ? (
        <div className="w-1/2 flex-1 text-right">
          <Button asChild variant="link">
            <a href={`/changelog/${next.slug}`} className="group">
              <span className="truncate">{next.title}</span>
              <CaretRight className="ml-2 h-4 w-4 text-muted-foreground group-hover:text-foreground" />
            </a>
          </Button>
        </div>
      ) : (
        <div />
      )}
    </div>
  );
}

export function ChangelogCard({ post }: { post: Changelog }) {
  return (
    <article className="relative mx-auto flex max-w-prose flex-col gap-8">
      <div className="grid w-full gap-3">
        <p className="font-mono text-sm text-muted-foreground">{format(new Date(post.publishedAt), 'LLL dd, y')}</p>
        <h1 className="font-cal mb-5 text-3xl">{post.title}</h1>
        <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-border">
          <img src={post.image.url} alt={post.title} className="absolute inset-0 h-full w-full object-cover" />
        </div>
      </div>
      <Mdx code={post.content.mdx} />
    </article>
  );
}
