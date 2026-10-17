import { format } from '@arki/date/format';
import { Avatar, AvatarFallback, AvatarImage } from '@arki/ui/avatar';
import { Badge } from '@arki/ui/badge';
import { ScrollToTop } from '@arki/ui/scroll-to-top';

import { Mdx } from './mdx';

/** What an article reads from a post. A content-build `Post` has these fields. */
export type ArticlePost = {
  title: string;
  image: { url: string };
  author: { name: string; url?: string | undefined; avatar?: string | undefined };
  publishedAt: Date;
  readingTime: string;
  tags: readonly string[];
  content: { mdx: string };
};

/** The first letter of the first and the last name: "Ada King Lovelace" is "AL". */
function nameInitials(name: string): string {
  const names = name.split(' ');
  return `${names[0]?.charAt(0) ?? ''}${names.at(-1)?.charAt(0) ?? ''}`;
}

export function Article({ post }: { post: ArticlePost }) {
  return (
    <article className="relative mx-auto flex max-w-prose flex-col gap-8">
      <div className="grid w-full gap-3">
        <h1 className="font-cal mb-5 text-3xl">{post.title}</h1>
        <figure className="relative aspect-video w-full overflow-hidden rounded-lg border border-border">
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
            <AvatarFallback>{nameInitials(post.author.name)}</AvatarFallback>
          </Avatar>
          <div className="text-sm font-light text-muted-foreground">
            <a
              href={post.author.url ?? '#'}
              target="_blank"
              rel="noopener noreferrer"
              className="cursor-pointer font-medium text-foreground hover:underline"
            >
              {post.author.name}
            </a>
            <div className="flex flex-wrap items-center gap-1.5">
              <time className="font-mono">{format(post.publishedAt, 'LLL dd, y')}</time>
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
