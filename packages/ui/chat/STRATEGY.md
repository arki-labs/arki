# @arki/chat-ui — Agentic UI Strategy

## Stack Decision

**Vercel AI SDK + assistant-ui + @arki/ui design system**

All three research documents (`packages/ai/docs/ui/`) independently converge on this recommendation. The key insight: assistant-ui is "the shadcn of chat" — headless composable primitives where we own the rendering layer.

### Why assistant-ui over CopilotKit

| Criterion          | assistant-ui                        | CopilotKit                            |
| ------------------ | ----------------------------------- | ------------------------------------- |
| Architecture       | Composable primitives (Radix-style) | Batteries-included framework          |
| npm downloads/week | ~240,000                            | ~90,000                               |
| UI control         | Full (headless, own every pixel)    | Limited (headless requires paid plan) |
| Middleware         | None required                       | CopilotRuntime required               |
| Vendor lock-in     | MIT, standard AI SDK protocol       | AG-UI protocol, cloud services        |
| Best for           | AI-as-the-app (our use case)        | AI-as-a-sidecar to existing apps      |

### Why a separate `@arki/chat-ui` package

- `@arki/ui` is general-purpose. Adding `@assistant-ui/react` as a dep forces ALL apps to pull it in.
- Chat components are specialized — not every app needs them.
- Follows existing `packages/ui/` workspace pattern: `base/`, `icons/`, `spinners/`, `native/`, `chat/`.

## Architecture

```
@arki/chat-ui
├── @arki/ui              (Card, Button, Badge, Skeleton, etc.)
├── @arki/icons           (Lucide icons)
├── @assistant-ui/react   (chat runtime & headless primitives)
├── @assistant-ui/react-ai-sdk  (Vercel AI SDK adapter)
└── ai                    (Vercel AI SDK — peer dependency)
```

## Component Layers

### Layer 1: Chat Primitives

Styled wrappers over assistant-ui primitives with our design tokens:

- `thread.tsx` — Container, viewport, messages, scroll-to-bottom
- `message.tsx` — User/assistant/system message bubbles
- `composer.tsx` — Input area with send button
- `action-bar.tsx` — Copy, regenerate, edit buttons
- `branch-picker.tsx` — Message version navigation

### Layer 2: Agentic Components

New components for agent-specific UX patterns:

- `tool-call.tsx` — Tool call visualization (pending → running → complete → error)
- `thinking-block.tsx` — Collapsible chain-of-thought (wraps ChainOfThoughtPrimitive)
- `approval-card.tsx` — HITL confirmation with approve/edit/reject
- `agent-status.tsx` — Agent status badge with icon + label
- `step-indicator.tsx` — Multi-step agent flow progress

### Layer 3: Structured Outputs

- `code-block.tsx` — Code with copy button + language label
- `markdown-message.tsx` — Styled markdown container

### Layer 4: Infrastructure

- `tool-registry.tsx` — Map tool names → React components (Generative UI pattern)
- `types.ts` — Shared type definitions
- `styles/chat.css` — Tailwind v4 keyframe animations

## UX Patterns to Follow

1. **Progressive Disclosure**: Collapse tool cards after completion. Show compact summaries by default. Expand on click.
2. **Inline Tool Cards**: Render tool calls as styled cards within the message stream, not in modals.
3. **Three-Tier Thinking**: Level 1 = "Thinking..." pill. Level 2 = collapsed summary. Level 3 = full reasoning.
4. **HITL with Autonomy Dial**: Low-risk actions execute silently. High-risk actions require approval. Target 5-15% approval rate.
5. **Streaming Feedback**: Always show what the agent is doing. No "spinning void" > 2 seconds.
6. **Artifact Pattern**: For complex outputs (reports, code), render in side panel, not inline.

## Anti-Patterns to Avoid

1. **Raw JSON dumps** — Always render structured components
2. **Spinning void** — No generic spinner > 2 seconds without context
3. **Over-confirmation** — Don't ask approval for reads/searches (only writes/sends/deletes)
4. **Silent failures** — Always show retry buttons on errors
5. **Doom scroll** — Use artifacts panel for long outputs, keep chat thread lean

## App Integration Pattern

```tsx
// 1. Backend: /api/chat route
import { openai } from '@ai-sdk/openai';
// 2. Frontend: Chat page
import { useChatRuntime } from '@assistant-ui/react-ai-sdk';
import { streamText } from 'ai';

import { Composer, ComposerInput, ComposerSend } from '@arki/chat-ui/composer';
import { AssistantMessage, UserMessage } from '@arki/chat-ui/message';
import { ThreadMessages, ThreadRoot, ThreadScrollToBottom, ThreadViewport } from '@arki/chat-ui/thread';

export async function POST(req: Request) {
  const { messages } = await req.json();
  const result = await streamText({
    model: openai('gpt-4o'),
    messages,
    tools: {
      /* your tools */
    },
    maxSteps: 5,
  });
  return result.toDataStreamResponse();
}

function ChatPage() {
  const runtime = useChatRuntime({ api: '/api/chat' });

  return (
    <ThreadRoot runtime={runtime}>
      <ThreadViewport>
        <ThreadMessages
          components={{
            UserMessage: MyUserMessage,
            AssistantMessage: MyAssistantMessage,
          }}
        />
      </ThreadViewport>
      <Composer>
        <ComposerInput placeholder="Ask anything..." />
        <ComposerSend />
      </Composer>
      <ThreadScrollToBottom />
    </ThreadRoot>
  );
}
```

## Migration Guide

### From Everseek (Next.js API route)

1. Keep the existing `/api/ai/chat/route.ts` backend (already uses `streamText`)
2. Replace custom `AIChat` component with `@arki/chat-ui` primitives
3. Replace custom `useAIChat` hook with `useChatRuntime` from `@assistant-ui/react-ai-sdk`

### From Brandability (tRPC subscriptions)

1. The tRPC streaming approach is more complex. Options:
   a. Add a separate `/api/chat` Next.js route alongside tRPC for the chat feature
   b. Use `ExternalStoreRuntime` from assistant-ui to bridge tRPC data to the chat UI
2. Replace `ChatPanel` and `ChatMessage` components with `@arki/chat-ui` primitives
