
import { toHumanReadableDate } from '@arki/date/format';
import { Avatar, AvatarFallback, AvatarImage } from '@arki/ui/avatar';
import { Badge } from '@arki/ui/badge';
import { ScrollToTop } from '@arki/ui/scroll-to-top';

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
          <img
            src={post.image.url}
            alt={post.title}
            className="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
            decoding="async"
          />
        </figure>
        <div className="flex items-center gap-3">
          <Avatar>
            <AvatarImage src={post.author.avatar} />
            <AvatarFallback>{getNameInitials(post.author.name)}</AvatarFallback>
          </Avatar>
          <div className="text-muted-foreground text-sm font-light">
            <a
              href={post.author.url ?? '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground cursor-pointer font-medium hover:underline"
            >
              {post.author.name}
            </a>
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
