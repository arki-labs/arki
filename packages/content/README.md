# @arki/content

Content helpers for blogs and docs. Parse and generate RSS and Atom feeds, build a search index over posts, and sort the collections an app generates at build time.

It pairs with `@arki/content-build`, which produces the collections. This package reads them. It has no framework dependency.

## Install

```sh
bun add @arki/content
```

## Quick start

`parseFeed` reads RSS or Atom text. It returns a failure value for bad input and never throws. `generateRss` writes a feed back out.

```ts
import { isFailure } from '@arki/failure';
import { parseFeed } from '@arki/content/rss';
import { generateRss } from '@arki/content/rss/generate';

const xml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Example</title><link>https://example.com</link><description>Notes</description>
  <item><title>Hello</title><link>https://example.com/hello</link><guid>hello</guid></item>
</channel></rss>`;

const feed = parseFeed(xml);
if (isFailure(feed)) throw new Error(feed.code);

console.log(feed.title, feed.items.length);
console.log(generateRss(feed).includes('<title>Hello</title>'));
```

Search a set of posts:

```ts
import { createPostSearchIndex, searchPosts } from '@arki/content';

const index = createPostSearchIndex([
  {
    url: '/posts/hello',
    title: 'Hello world',
    description: 'A first post',
    publishedAt: new Date('2026-01-01'),
    readingTime: '1 min read',
    image: { url: '/hello.png' },
    tags: ['intro'],
    content: { raw: 'Welcome to the blog.' },
  },
]);

console.log(searchPosts(index, 'welcome').map(result => result.title));
```

Sort what the app generated. Only the collections the app has get keys.

```ts skip="fragment: needs the content-collections module that @arki/content-build generates"
import * as generated from 'content-collections';
import { contentQueries } from '@arki/content';

export const { posts, postBySlug, changelogs, legals, faqs } = contentQueries(generated);
```

## What it does

- `parseFeed(xml, options?)` reads RSS 2.0 and Atom. It returns a `Feed` or one of `FeedTooLarge`, `FeedMalformed`, `FeedUnsupported`, `FeedLimitExceeded`. DOCTYPE and entity declarations are refused.
- `generateRss`, `generateAtom`, `generateFeed` write a `Feed` as text.
- `buildPostFeed` and `buildChangelogFeed` make an RSS 2.0 feed from posts or changelog entries.
- `createPostSearchIndex`, `loadPostSearchIndex`, `searchPosts` wrap MiniSearch. The index can be saved with `JSON.stringify` at build time and loaded in the browser.
- `contentQueries` sorts posts and changelogs newest first, legals by title and FAQs by order. It returns sorted copies.

## When not to use this

- You need to compile MDX or markdown. Use `@arki/content-build`.
- You need components to render content. Use `@arki/content-react`.
- You need full text search over a large corpus. This index lives in memory.

## Runtime support

Node, Bun, Deno and browsers. The package has no Node-only imports.

## Public imports

| Import | What it gives you |
| --- | --- |
| `@arki/content` | Feed builders, post search, `contentQueries` |
| `@arki/content/rss` | `parseFeed`, feed types, feed failures |
| `@arki/content/rss/generate` | `generateRss`, `generateAtom`, `generateFeed` |

## Failure behaviour

Parsing returns failures from `@arki/failure` with the codes `content.feed_too_large`, `content.feed_malformed`, `content.feed_unsupported` and `content.feed_limit_exceeded`. Check with `isFailure`.

## Limits

`parseFeed` reads at most 10 MiB of text and 10,000 items by default. Pass `maxBytes` or `maxItems` to change them.
