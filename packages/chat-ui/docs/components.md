# Components

Every component accepts the props of its root element (`className`, `data-*`, and so on) and sets a `data-slot` attribute you can style. Imports are one subpath per file, for example `@arki/chat-ui/tool-call`.

## Agent run

| Component                                                         | Props                                                                            | Use                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------- |
| `RuntimeConversation`                                             | `state: RuntimeUiState`, `renderText?`, `hideStatus?`                            | Status pill, tool calls and text of one run |
| `AgentPanel`                                                      | `name`, `state`, `statusOverride?`, `headerAccessory?`, `footer?`, `renderText?` | A titled card around `RuntimeConversation`  |
| `AgentStatus`                                                     | `status: AgentStatusType`, `label?`                                              | The status pill                             |
| `ToolCall`, `ToolCallHeader`, `ToolCallContent`, `ToolCallResult` | `toolName`, `status: ToolCallStatus`                                             | One tool call card                          |
| `ThinkingBlock`                                                   | `label?`, `duration?` (ms)                                                       | Collapsible reasoning                       |
| `ApprovalCard`                                                    | `title`, `description?`, `onAction(result: ApprovalResult)`                      | Approve, edit or reject with feedback       |
| `StepIndicator`                                                   | `steps: AgentStep[]`, `orientation?: 'vertical' \| 'horizontal'`                 | Multi-step progress                         |

`runtimeStatusToAgentStatus(status, hasRunningTool)` maps a runtime status to the pill: `running` is `executing` when a tool is running and `thinking` otherwise, `done` is `complete`, `error` is `error`, anything else is `idle`.

```tsx run expect
import { renderToStaticMarkup } from 'react-dom/server';

import { ApprovalCard } from '@arki/chat-ui/approval-card';
import { runtimeStatusToAgentStatus } from '@arki/chat-ui/runtime-conversation';
import { StepIndicator } from '@arki/chat-ui/step-indicator';

const html = renderToStaticMarkup(
  <>
    <ApprovalCard title="Send 3 emails?" onAction={() => undefined} />
    <StepIndicator steps={[{ id: 'a', label: 'Plan', status: 'complete' }]} />
  </>,
);

console.log(runtimeStatusToAgentStatus('running', true), html.includes('Send 3 emails?'), html.includes('Plan'));
```

```text
executing true true
```

## Chat surface (assistant-ui)

These wrap `@assistant-ui/react` primitives and must sit inside its runtime provider.

`ThreadRoot`, `ThreadViewport`, `ThreadMessages`, `ThreadEmpty`, `ThreadScrollToBottom`; `UserMessage`, `AssistantMessage`, `SystemMessage` and their content parts; `Composer`, `ComposerInput`, `ComposerSend`, `ComposerCancel`, `ComposerAttachments`; `ActionBar` (copy, reload, edit); `BranchPicker`.

## Content

`CodeBlock` (`code`, `language?`) shows code with a copy button. `MarkdownMessage` styles markdown you rendered yourself.

## Generative UI

`createToolRegistry({ toolName: Component })` maps a tool name to a component that takes `{ args, result, status }`. Provide it with `ToolRegistryProvider` and read it with `useToolRegistry()`. See the Quick start in the [README](../README.md).
