# @arki/chat-ui

Chat and agent UI for React: styled assistant-ui primitives, tool call cards, thinking blocks, approval cards, step indicators, and a renderer for `@arki/ai` runtime streams. Styled with `@arki/ui` tokens and Tailwind.

## Install

```sh
bun add @arki/chat-ui react react-dom
```

Import the stylesheet once, in your app's CSS entry or root route: `import '@arki/chat-ui/styles/chat.css'`. It adds the chat animations to your Tailwind theme.

## Quick start

Render a running agent. `RuntimeConversation` takes the `RuntimeUiState` that `@arki/ai` builds from a run's events, and draws the status pill, the tool calls and the text.

```tsx from="examples/render-agent-run.tsx#run"
const state: RuntimeUiState = {
  status: 'running',
  text: 'Looking up the order.',
  toolCalls: [{ tool: 'lookupOrder', status: 'running' }],
};

const html = renderToStaticMarkup(<RuntimeConversation state={state} />);
```

In an app you pass `state` from `useRuntimeStream()` in `@arki/ai` and render the component directly, with no `renderToStaticMarkup`. Map a tool name to your own widget with the tool registry:

```tsx from="examples/render-agent-run.tsx#registry"
function OrderCard({ args }: { args: Record<string, unknown>; result: unknown; status: string }) {
  return <p>Order {String(args.id)}</p>;
}

const registry = createToolRegistry({ lookupOrder: OrderCard });

function ToolView({ toolName }: { toolName: string }) {
  const Component = useToolRegistry().getComponent(toolName);
  return Component ? <Component args={{ id: 7 }} result={null} status="complete" /> : <p>No widget</p>;
}

const widget = renderToStaticMarkup(
  <ToolRegistryProvider registry={registry}>
    <ToolView toolName="lookupOrder" />
  </ToolRegistryProvider>,
);
```

The full file is [examples/render-agent-run.tsx](examples/render-agent-run.tsx). Every component is listed in [Components](docs/components.md).

## When not to use this

- You build a React Native app. These components render DOM elements.
- You need a chat UI with no Tailwind. The classes assume Tailwind and the `@arki/ui` tokens.
- You want a full chat product with accounts and history. This is the view layer only.
- You do not use `@arki/ai`. `RuntimeConversation` and `AgentPanel` need its `RuntimeUiState`. The other components do not.

## Runtime support

Browsers, and React 18 or 19 (`react` and `react-dom` peers). Components render on the server too, and every file is marked `'use client'`. The package ships TypeScript and TSX source, so your bundler must compile TSX (Vite does). The export condition is `browser`, then `import`. Not for Node scripts without a bundler.

## Public imports

One subpath per component file, plus `types` and the stylesheet.

| Import                                                                                             | Gives you                                                                          |
| -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `@arki/chat-ui/runtime-conversation`                                                               | `RuntimeConversation`, `runtimeStatusToAgentStatus`                                |
| `@arki/chat-ui/agent-panel`                                                                        | `AgentPanel`                                                                       |
| `@arki/chat-ui/thread`, `/message`, `/composer`, `/action-bar`, `/branch-picker`                   | assistant-ui backed chat surface                                                   |
| `@arki/chat-ui/tool-call`, `/thinking-block`, `/approval-card`, `/step-indicator`, `/agent-status` | agent building blocks                                                              |
| `@arki/chat-ui/code-block`, `/markdown-message`                                                    | message content                                                                    |
| `@arki/chat-ui/tool-registry`                                                                      | `createToolRegistry`, `ToolRegistryProvider`, `useToolRegistry`                    |
| `@arki/chat-ui/types`                                                                              | `ToolCallStatus`, `AgentStatusType`, `ApprovalResult`, `AgentStep`, `ToolCallMeta` |
| `@arki/chat-ui/styles/chat.css`                                                                    | the animations                                                                     |

The full list with export names is in [llms.txt](llms.txt).

## Failure behaviour

Components do not return failures. They render what they are given.

- `useToolRegistry` throws `useToolRegistry must be used within a ToolRegistryProvider` outside a provider. Wrap the tree in `ToolRegistryProvider`.
- `getComponent(name)` returns `undefined` for a tool with no widget. Fall back to `ToolCall`.
- A tool call with `status: 'error'` shows its `error` text. A `failed` call shows `failure.message`.
- `RuntimeConversation` renders `state.error` when `state.status` is `error`.

## Limits

- **Text is not parsed as markdown.** `RuntimeConversation` prints `state.text` as is. Pass `renderText` (for example from `react-markdown`) to format it. `MarkdownMessage` only styles content you already rendered.
- **Tool call keys are the tool name plus its index.** Reordering `state.toolCalls` remounts the cards. Append only.
- **Tool names map to one widget.** `createToolRegistry({ search: A })` and a later `register('search', B)` replace A for every reader of that registry.
- **`Thread`, `Composer` and message parts need an assistant-ui runtime.** Render them inside assistant-ui's runtime provider.
- **No styles without Tailwind.** Without the stylesheet and the `@arki/ui` tokens, components render unstyled and the animations are missing.

## Documentation

- [Components](docs/components.md): every component and its props.
- [Recipe: render an agent run](docs/recipes/render-agent-run.md): one command and its expected output.
- [Agent guide](docs/agent-guide.md): tasks and rules for agents.
- [llms.txt](llms.txt): the import map.

## Support

Report bugs at [github.com/arki-labs/arki/issues](https://github.com/arki-labs/arki/issues).
