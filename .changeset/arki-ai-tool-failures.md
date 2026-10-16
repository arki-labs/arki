---
'@arki/ai': minor
'@arki/chat-ui': patch
---

A tool's `execute` may now return a failure from `@arki/failure` for an expected outcome, such as "city not found". The model gets `{ error: { code, message, remediation, data } }` as the tool result, so the remediation can steer its next call. The `output` schema check is skipped for a failure. The run emits a new event, `{ type: 'tool:failure', tool, failure }`, and `runtimeEventReducer` marks that tool call `failed` with its `failure`. A thrown error is still a `tool:error`. The AI SDK and Mastra runtimes behave the same. `toAiSdkToolSet` and `toMastraTools` take an optional `onFailure(toolCallId, failure)`. New type: `ToolFailure`. `@arki/chat-ui`'s `RuntimeConversation` shows a failed tool call as an error with the failure's message.
