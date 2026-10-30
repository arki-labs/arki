---
'@arki/content-react': minor
---

`useSearch` returns `failure` (`SearchUnavailable` or `SearchResponseMalformed`) in place of `isError`, and parses the `/posts/search` response with a schema instead of trusting the JSON. New `searchPosts` function and `postOverviewSchema`. `useProcessor` returns `{ value, isPending, failure, retry }`, and `Preview` shows an alert with a Retry button when rendering fails. Markdown now renders with `rehype-react` 8's `jsx`/`jsxs` options (the old `createElement` option made every `Preview` fail). Publish dates that are not valid dates show as written instead of throwing a `RangeError`. `FileTree` skips a negative or non-finite size. `Pre` uses the shared `copyText`.
