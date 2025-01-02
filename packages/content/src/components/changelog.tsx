import Image from 'next/image';

import { toHumanReadableDate } from '@arki/date/format';

import type { Changelog } from '../collections/changelog';
import { Mdx } from './mdx';

export function ChangelogCard({ post }: { post: Changelog }) {
  return (
    <article className="relative mx-auto flex max-w-prose flex-col gap-8">
      <div className="grid w-full gap-3">
        <p className="font-mono text-sm text-muted-foreground">{toHumanReadableDate(new Date(post.publishedAt))}</p>
        <h1 className="font-cal mb-5 text-3xl">{post.title}</h1>
        <div className="aspect-video relative w-full overflow-hidden rounded-lg border border-border">
          <Image src={post.image} fill={true} alt={post.title} className="object-cover" />
        </div>
      </div>
      <Mdx code={post.mdx} />
    </article>
  );
}
