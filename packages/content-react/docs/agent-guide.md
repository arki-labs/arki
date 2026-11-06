# Agent guide: @arki/content-react

Read `llms.txt` first for the map. This guide is the detail. When this guide and the code disagree, `src/index.ts` wins.

## The model

1. `@arki/content-react` renders what `@arki/content-build` compiles: `Article`, `Mdx`, `ContentSection`, `Preview` and `mdxComponents`.
2. `ChangelogTimeline`, `ChangelogPagination`, `ChangelogCard`, `Timeline` and `PostsTimeline` show dated entries. `searchParamsParsers` and `searchParamsCache` hold the `nuqs` page state for the changelog.
3. `Pre`, `FileTree`, `Notification`, `MarkdownImage`, `DateTime`, `EmbeddedCard`, `GitHubIssue`, `GitHubPullRequest` and `StaticTweet` are building blocks used inside MDX.
4. `useSearch` calls the app's `/posts/search?query=` route with a 300 ms debounce. `useProcessor` turns markdown text into React nodes.
5. Entries are bundler-only. They import `@arki/ui` and `@arki/icons`.

## Task map

### Show a post

1. Get a `Post` from `contentQueries(generated)` in `@arki/content`.
2. Render `<Article post={post} />`. It reads `title`, `image`, `author`, `publishedAt`, `readingTime`, `tags` and `content.mdx`.

### Show a changelog

1. Render `ChangelogTimeline` with the entries and `ChangelogPagination` for the pages.
2. Use `searchParamsParsers` with `nuqs` to hold the page number.

### Search posts while typing

1. Add a route at `/posts/search` that returns a JSON list of post overviews.
2. Call `useSearch()`. Bind `search` to the input, read `result`, and show a retry button that calls `retry` when `failure` is set.

## Rules that bite

- Use this package through Vite or another bundler. It imports TypeScript source.
- `useSearch` needs the `/posts/search` route. Without it every search is a `SearchUnavailable` failure.
- On a failure `result` is empty.
- A search that you aborted by typing again also ends as `SearchUnavailable`. The hook ignores it.
- `Preview` shows a retry button when markdown fails to render.
- Match on `failure.code`, never on the message.

## Errors

| Code                                      | Meaning                                                         | What to do                                                   |
| ----------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `content_react.search_unavailable`        | The network failed, or the route answered with a non-ok status. | Retry. If it keeps failing, check the `/posts/search` route. |
| `content_react.search_response_malformed` | The body is not JSON or not a list of post overviews.           | Make the route return a JSON array of post overviews.        |

## Verify

```sh
bun run build && bun run typecheck && bun run lint && bun run test
bun run test:docs
bun ../../tooling/library/src/llms.ts --check
```
