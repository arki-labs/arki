# @arki/content-react

React components for content pages. Render compiled MDX, show a blog article, a changelog timeline, code blocks, GitHub and tweet embeds, and search posts as the reader types.

It renders what `@arki/content-build` produces. Entries are bundler-only: they import `@arki/ui` and `@arki/icons`, which ship TypeScript source, so use this package through Vite or another bundler.

## Install

```sh
bun add @arki/content-react
```

Peer dependency: `react` 18 or 19.

## Quick start

```tsx skip="fragment: needs a built content-collections module and the app's design system"
import { posts } from '@/content'; // from contentQueries(generated) in @arki/content
import { Article } from '@arki/content-react';

export function PostPage({ slug }: { slug: string }) {
  const post = posts.find(entry => entry.slug === slug);
  if (post === undefined) return null;
  return <Article post={post} />;
}
```

`Article` reads `title`, `image`, `author`, `publishedAt`, `readingTime`, `tags` and `content.mdx`. A `Post` from `@arki/content-build` has all of them.

Search posts through the app's `/posts/search?query=` route:

```tsx skip="fragment: needs an app route at /posts/search"
import { useSearch } from '@arki/content-react';

export function SearchBox() {
  const { query, result, search, isLoading, failure, retry } = useSearch();
  return (
    <>
      <input value={query} onChange={event => search(event.target.value)} />
      {isLoading ? <p>Searching</p> : null}
      {failure === undefined ? null : <button onClick={retry}>Retry</button>}
      <ul>{result.map(post => <li key={post.url}>{post.title}</li>)}</ul>
    </>
  );
}
```

## What it gives you

- `Article`, `Mdx`, `ContentSection`, `Preview`, `mdxComponents` render posts and MDX.
- `ChangelogTimeline`, `ChangelogPagination`, `ChangelogCard`, `Timeline`, `PostsTimeline` show dated entries. `searchParamsParsers` and `searchParamsCache` hold the `nuqs` page state for the changelog.
- `Pre`, `FileTree`, `Notification`, `MarkdownImage`, `DateTime`, `EmbeddedCard`, `GitHubIssue`, `GitHubPullRequest`, `StaticTweet` are the building blocks used inside MDX.
- `useSearch` searches posts with a 300 ms debounce and aborts a request still in flight. `useProcessor` turns markdown text into React nodes.

## When not to use this

- You do not use `@arki/ui`. These components use its tokens and parts.
- You need to compile MDX. Use `@arki/content-build`.
- You need feeds, sorting or a search index. Use `@arki/content`.

## Runtime support

Browsers and React server rendering, through a bundler. It does not load in plain Node.

## Public imports

| Import | What it gives you |
| --- | --- |
| `@arki/content-react` | Every component and hook above |

## Failure behaviour

`useSearch` returns failures instead of throwing: `SearchUnavailable` for a network error or non-ok response, `SearchResponseMalformed` for a body that is not a list of posts. `result` is empty then. `Preview` shows a retry button when markdown fails to render.

## Limits

`useSearch` needs a `/posts/search` route that returns a JSON list of posts.
