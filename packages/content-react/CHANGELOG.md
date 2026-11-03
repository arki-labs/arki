# @arki/content-react

## 0.2.0

### Minor Changes

- ebc681b: `useSearch` returns `failure` (`SearchUnavailable` or `SearchResponseMalformed`) in place of `isError`, and parses the `/posts/search` response with a schema instead of trusting the JSON. New `searchPosts` function and `postOverviewSchema`. `useProcessor` returns `{ value, isPending, failure, retry }`, and `Preview` shows an alert with a Retry button when rendering fails. Markdown now renders with `rehype-react` 8's `jsx`/`jsxs` options (the old `createElement` option made every `Preview` fail). Publish dates that are not valid dates show as written instead of throwing a `RangeError`. `FileTree` skips a negative or non-finite size. `Pre` uses the shared `copyText`.
- fb2103b: Fix runtime failures that plain input could trigger.

  - `@arki/string`: `words`, `wordCount` and every count built on them scan text in linear steps. One regex with a repeating group overflowed the engine's stack on Node for megabytes of text such as `a-a-a-`. Results on ordinary text are unchanged.
  - `@arki/chat-ui`: the `CodeBlock` copy button awaits the clipboard write. A refused write shows "Copy failed" for 2 seconds instead of an unhandled rejection.
  - `@arki/content-react`: a markdown image with no alt text renders as a decorative image (`alt=""`) instead of throwing during render, and an image with no source renders nothing. The code-block copy button shows a failed state when the clipboard is refused or missing. `useSearch` adds `isError` and `retry()`.
  - `@arki/ui`: the sidebar logs through `@arki/log` instead of `debug`, so importing it no longer reads `process.env.DEBUG` (Deno without env permission threw at import). Its debug output now follows the app's `@arki/log` configuration. A refused cookie write no longer throws; the sidebar just does not remember its state.

### Patch Changes

- Updated dependencies [8f873ae]
- Updated dependencies [e6b9330]
- Updated dependencies [1511bbd]
- Updated dependencies [f3c95a0]
  - @arki/intl@0.2.0
  - @arki/content@0.2.0
