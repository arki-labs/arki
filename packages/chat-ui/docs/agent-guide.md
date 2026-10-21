# @arki/chat-ui for agents

Read this before you change a chat or agent screen. The [README](../README.md) is the overview.

## The model

- Two layers. The agent layer (`RuntimeConversation`, `AgentPanel`, `ToolCall`, `ThinkingBlock`, `ApprovalCard`, `StepIndicator`, `AgentStatus`) renders plain data and needs no runtime. The chat layer (`Thread*`, `Composer*`, messages, `ActionBar`, `BranchPicker`) wraps assistant-ui and needs its runtime provider.
- `RuntimeConversation` takes `RuntimeUiState` from `@arki/ai`. Any backend that emits runtime events renders through it.
- Tool names map to widgets with `createToolRegistry`.
- Source is TSX. The consumer's bundler compiles it.

## Task map

### Show a live agent run

Use `RuntimeConversation` or `AgentPanel` with `state` from `useRuntimeStream()`. See [the recipe](recipes/render-agent-run.md).

### Draw a custom widget for a tool

Use `createToolRegistry`, `ToolRegistryProvider` and `useToolRegistry`. See the README Quick start.

### Ask the user to approve an action

Render `ApprovalCard` with `onAction`. The result is `{ action: 'approve' | 'reject' | 'edit', feedback? }`. Feed `feedback` back to the agent.

### Build a chat page

Wrap the page in assistant-ui's runtime provider, then compose `ThreadRoot`, `ThreadViewport`, `ThreadMessages` and `Composer`. Every prop is listed in [Components](components.md).

## Rules that bite

- Import `@arki/chat-ui/styles/chat.css` once, or the animations are missing.
- `useToolRegistry` throws outside `ToolRegistryProvider`.
- `Thread`, `Composer` and message parts need an assistant-ui runtime provider above them.
- `RuntimeConversation` prints text as is. Pass `renderText` for markdown.
- Do not reorder `state.toolCalls`. Keys are tool name plus index.
- Use `ToolCallStatus` values `pending`, `running`, `complete`, `error`. A runtime `done` maps to `complete`, and `failed` and `error` both map to `error`.

## Errors

This package defines no error classes. The one thrown error is the provider check.

| Error                                                        | When                            | Fix                                     |
| ------------------------------------------------------------ | ------------------------------- | --------------------------------------- |
| `useToolRegistry must be used within a ToolRegistryProvider` | The hook ran outside a provider | Wrap the tree in `ToolRegistryProvider` |

## Verify

```sh
turbo run typecheck test test:docs --filter=@arki/chat-ui
bun ../../tooling/library/src/llms.ts --check
```
