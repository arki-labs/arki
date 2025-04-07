import Image from 'next/image';
import Link from 'next/link';

import { Avatar, AvatarFallback, AvatarImage } from '@arki/base-ui/avatar';
import { Badge } from '@arki/base-ui/badge';
import { toHumanReadableDate } from '@arki/date/format';
import { ScrollToTop } from '@arki/sitekit/components/scroll-to-top';

import type { Post } from '../collections/post';
import { Mdx } from './mdx';

export function Article({ post }: { post: Post }) {
  const getNameInitials = (name: string) => {
    const individualNames = name.split(' ');
    return individualNames[0]![0]! + individualNames.at(-1)![0];
  };

  return (
    <article className="relative mx-auto flex max-w-prose flex-col gap-8">
      <div className="grid w-full gap-3">
        <h1 className="font-cal mb-5 text-3xl">{post.title}</h1>
        <figure className="border-border relative aspect-video w-full overflow-hidden rounded-lg border">
          <Image
            src={post.image.url}
            blurDataURL={post.image.blurDataURL}
            placeholder="blur"
            fill
            alt={post.title}
            className="border-base-200 dark:border-base-700 h-40 w-64 shrink-0 rounded-md border-2 object-cover"
          />
        </figure>
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarImage src={post.author.avatar} />
            <AvatarFallback>{getNameInitials(post.author.name)}</AvatarFallback>
          </Avatar>
          <div className="text-muted-foreground text-sm font-light">
            <Link
              href={post.author.url ?? '#'}
              target="_blank"
              className="text-foreground cursor-pointer font-medium hover:underline"
            >
              {post.author.name}
            </Link>
            <div className="flex flex-wrap items-center gap-1.5">
              <time className="font-mono">{toHumanReadableDate(post.publishedAt)}</time>
              <span className="text-muted-foreground/70">&bull;</span>
              <span className="font-mono">{post.readingTime}</span>
              <span className="text-muted-foreground/70">&bull;</span>
              {post.tags.map(tag => (
                <Badge key={tag} variant="outline" className="font-normal capitalize">
                  {tag}
                </Badge>
              ))}
            </div>
          </div>
        </div>
      </div>
      <Mdx code={post.content.mdx} />
      <ScrollToTop />
    </article>
  );
}
