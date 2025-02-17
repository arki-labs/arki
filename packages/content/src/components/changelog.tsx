import Image from 'next/image';
import Link from 'next/link';
import { ChevronLeft, ChevronRight } from 'lucide-react';

import { Button } from '@arki/base-ui/button';
import { toHumanReadableDate } from '@arki/date/format';

import type { Changelog } from '../collections/changelog';
import { Mdx } from './mdx';

export function ChangelogPagination({ prev, next }: { prev?: Changelog; next?: Changelog }) {
  return (
    <div className="mx-auto flex w-full max-w-prose items-center justify-between">
      <div />
      {prev ? (
        <div className="w-1/2 flex-1 text-left">
          <Button asChild variant="link">
            <Link href={`/changelog/${prev.slug}`} className="group">
              <ChevronLeft className="text-muted-foreground group-hover:text-foreground mr-2 h-4 w-4" />
              <span className="truncate">{prev.title}</span>
            </Link>
          </Button>
        </div>
      ) : (
        <div />
      )}
      {next ? (
        <div className="w-1/2 flex-1 text-right">
          <Button asChild variant="link">
            <Link href={`/changelog/${next.slug}`} className="group">
              <span className="truncate">{next.title}</span>
              <ChevronRight className="text-muted-foreground group-hover:text-foreground ml-2 h-4 w-4" />
            </Link>
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
        <p className="text-muted-foreground font-mono text-sm">{toHumanReadableDate(new Date(post.publishedAt))}</p>
        <h1 className="font-cal mb-5 text-3xl">{post.title}</h1>
        <div className="border-border relative aspect-video w-full overflow-hidden rounded-lg border">
          <Image
            src={post.image.url}
            fill={true}
            alt={post.title}
            className="object-cover"
            blurDataURL={post.image.blurDataURL}
            placeholder="blur"
          />
        </div>
      </div>
      <Mdx code={post.content.mdx} />
    </article>
  );
}
