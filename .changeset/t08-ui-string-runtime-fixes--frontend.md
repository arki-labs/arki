---
'@arki/ui': patch
---

Fix runtime failures that plain input could trigger.

- `@arki/string`: `words`, `wordCount` and every count built on them scan text in linear steps. One regex with a repeating group overflowed the engine's stack on Node for megabytes of text such as `a-a-a-`. Results on ordinary text are unchanged.
- `@arki/chat-ui`: the `CodeBlock` copy button awaits the clipboard write. A refused write shows "Copy failed" for 2 seconds instead of an unhandled rejection.
- `@arki/content-react`: a markdown image with no alt text renders as a decorative image (`alt=""`) instead of throwing during render, and an image with no source renders nothing. The code-block copy button shows a failed state when the clipboard is refused or missing. `useSearch` adds `isError` and `retry()`.
- `@arki/ui`: the sidebar logs through `@arki/log` instead of `debug`, so importing it no longer reads `process.env.DEBUG` (Deno without env permission threw at import). Its debug output now follows the app's `@arki/log` configuration. A refused cookie write no longer throws; the sidebar just does not remember its state.
