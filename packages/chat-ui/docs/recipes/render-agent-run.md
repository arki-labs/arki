# Render an agent run

Goal: show a live `@arki/ai` run in a React page.

1. Import the stylesheet once: `import '@arki/chat-ui/styles/chat.css'`.
2. In the component, call `useRuntimeStream()` from `@arki/ai`. Start the run with `run(fetchRuntimeEventStream('/api/assess'))`.
3. Render `<RuntimeConversation state={state} />` from `@arki/chat-ui/runtime-conversation`.
4. For text with markdown, pass `renderText={text => <Markdown>{text}</Markdown>}`.
5. For a custom widget per tool, wrap the tree in `ToolRegistryProvider` (see [Components](../components.md)).

Check that the component renders a running tool call:

```sh
bun examples/render-agent-run.tsx
```

Expected output:

```text
true true <p>Order ord_42</p>
```
