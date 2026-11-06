# Agent guide: @arki/content

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, `src/index.ts` and `src/rss/index.ts` win.

## The model

1. `@arki/content/rss` reads RSS 2.0 and Atom text into a `Feed` with `parseFeed`.
2. `@arki/content/rss/generate` writes a `Feed` as text with `generateRss`, `generateAtom` or `generateFeed`.
3. `buildPostFeed` and `buildChangelogFeed` turn posts or changelog entries into an RSS 2.0 feed.
4. `createPostSearchIndex`, `loadPostSearchIndex` and `searchPosts` wrap MiniSearch. The index is in memory.
5. `contentQueries` sorts the collections that `@arki/content-build` generates.
6. Bad input is a returned failure from `@arki/failure`. Nothing here throws for it.

## Task map

### Read a feed

1. `const feed = parseFeed(xml)` from `@arki/content/rss`.
2. `if (isFailure(feed))` handle it by `feed.code`.
3. To read more than the defaults, pass `maxBytes` or `maxItems`.

### Write a feed

1. Build a `Feed`, or call `buildPostFeed` or `buildChangelogFeed` with your posts and `FeedSiteOptions`.
2. Call `generateRss`, `generateAtom` or `generateFeed` from `@arki/content/rss/generate`.

### Search posts

1. At build time: `createPostSearchIndex(posts)`, then `JSON.stringify` the index.
2. In the browser: `loadPostSearchIndex(json)`, then `searchPosts(index, query)`.

### Sort generated collections

1. `import * as generated from 'content-collections'`.
2. `contentQueries(generated)` returns `posts`, `postBySlug`, `changelogs`, `legals` and `faqs`. Only the collections the app has get keys.

## Rules that bite

- `parseFeed` returns a failure and never throws. Check it with `isFailure`.
- DOCTYPE and entity declarations are refused. They are an attack shape.
- The defaults are 10 MiB and 10,000 items.
- The search index is in memory. It is not for a large corpus.
- `contentQueries` sorts posts and changelogs newest first, legals by title and FAQs by order. It returns copies.
- Match on `failure.code`, never on the message.

## Errors

| Code                          | Meaning                                                      | What to do                                  |
| ----------------------------- | ------------------------------------------------------------ | ------------------------------------------- |
| `content.feed_too_large`      | The feed text is over `maxBytes`.                            | Raise `maxBytes`, or refuse the source.     |
| `content.feed_malformed`      | The text is not well-formed XML, or is neither RSS nor Atom. | Fetch the feed again, or refuse the source. |
| `content.feed_unsupported`    | The feed has a DOCTYPE or entity declaration.                | Refuse the source.                          |
| `content.feed_limit_exceeded` | The feed has more than `maxItems` items.                     | Raise `maxItems`, or refuse the source.     |

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
