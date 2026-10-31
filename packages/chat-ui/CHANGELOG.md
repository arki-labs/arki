# @arki/chat-ui

## 0.2.0

### Minor Changes

- 616437f: First public release of `@arki/chat-ui`: chat and agent UI components for React, with a renderer for `@arki/ai` runtime streams. no demo impact: no registered demo (`drop-studio`) imports `@arki/chat-ui`.

### Patch Changes

- e2958c6: `CodeBlock` now copies through `copyText` from `@arki/ui/copy-text`. The private copy of that helper in chat-ui is gone, so chat-ui needs `@arki/ui` 0.2.0 or later. Copy behaviour is unchanged.
- 772ed58: A tool's `execute` may now return a failure from `@arki/failure` for an expected outcome, such as "city not found". The model gets `{ error: { code, message, remediation, data } }` as the tool result, so the remediation can steer its next call. The `output` schema check is skipped for a failure. The run emits a new event, `{ type: 'tool:failure', tool, failure }`, and `runtimeEventReducer` marks that tool call `failed` with its `failure`. A thrown error is still a `tool:error`. The AI SDK and Mastra runtimes behave the same. `toAiSdkToolSet` and `toMastraTools` take an optional `onFailure(toolCallId, failure)`. New type: `ToolFailure`. `@arki/chat-ui`'s `RuntimeConversation` shows a failed tool call as an error with the failure's message.
- fb2103b: Fix runtime failures that plain input could trigger.

  - `@arki/string`: `words`, `wordCount` and every count built on them scan text in linear steps. One regex with a repeating group overflowed the engine's stack on Node for megabytes of text such as `a-a-a-`. Results on ordinary text are unchanged.
  - `@arki/chat-ui`: the `CodeBlock` copy button awaits the clipboard write. A refused write shows "Copy failed" for 2 seconds instead of an unhandled rejection.
  - `@arki/content-react`: a markdown image with no alt text renders as a decorative image (`alt=""`) instead of throwing during render, and an image with no source renders nothing. The code-block copy button shows a failed state when the clipboard is refused or missing. `useSearch` adds `isError` and `retry()`.
  - `@arki/ui`: the sidebar logs through `@arki/log` instead of `debug`, so importing it no longer reads `process.env.DEBUG` (Deno without env permission threw at import). Its debug output now follows the app's `@arki/log` configuration. A refused cookie write no longer throws; the sidebar just does not remember its state.

- Updated dependencies [4222ad1]
- Updated dependencies [779194e]
- Updated dependencies [a94009e]
- Updated dependencies [7f81cd5]
- Updated dependencies [7533a49]
- Updated dependencies [e132ad3]
- Updated dependencies [440c75f]
- Updated dependencies [c7199a6]
- Updated dependencies [2c57c1c]
- Updated dependencies [bcc641a]
- Updated dependencies [2544e6c]
- Updated dependencies [48313a3]
- Updated dependencies [c000457]
- Updated dependencies [b10825c]
- Updated dependencies [d7e9886]
- Updated dependencies [972c014]
- Updated dependencies [2c57c1c]
- Updated dependencies [49517e2]
- Updated dependencies [3f59d08]
- Updated dependencies [772ed58]
- Updated dependencies [01b4678]
- Updated dependencies [0faf836]
- Updated dependencies [e132ad3]
- Updated dependencies [d145ece]
- Updated dependencies [19bf607]
- Updated dependencies [ed02a2e]
- Updated dependencies [c7b7785]
- Updated dependencies [cac4bc6]
- Updated dependencies [9bb74f0]
  - @arki/ai@0.2.0

## 0.1.3

### Patch Changes

- @arki/ai@0.1.3
- @arki/ui@0.1.2

## 0.1.2

### Patch Changes

- @arki/ai@0.1.2

## 0.1.1

### Patch Changes

- @arki/ui@0.1.1
