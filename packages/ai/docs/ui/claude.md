# Building an agentic AI chat UI in React: the definitive stack guide

**For a solo developer shipping in 4–6 weeks, the recommended stack is Vercel AI SDK + assistant-ui + tool-ui.** This combination gives you streaming, tool-call rendering, human-in-the-loop, and full UI customization with the fewest moving parts. CopilotKit is the stronger choice only if your app demands real-time shared agent↔UI state or multi-agent orchestration out of the box — features that add architectural complexity you likely don't need at MVP stage. Below is the full decision framework.

## Recommended stack and reasoning

| Layer                                   | Recommendation                                | Why                                                                                                                            |
| --------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Chat protocol & streaming**           | Vercel AI SDK v5+ (`ai`)                      | Framework-agnostic, built-in tool calling, streaming, provider-swappable (OpenAI, Anthropic, Google), Zustand-based internals  |
| **Chat UI components**                  | `assistant-ui` (`@assistant-ui/react`)        | Composable Radix-style primitives, **240k npm downloads/week**, first-class AI SDK integration, tool rendering + HITL built-in |
| **Tool call components**                | `tool-ui` (tool-ui.com)                       | Pre-built conversation-native components (charts, data tables, approval cards, progress trackers) from the assistant-ui team   |
| **App state**                           | Zustand                                       | Lightweight, proven at scale (LobeChat, 63k stars), AI SDK v5 uses it internally                                               |
| **Backend**                             | Next.js API routes or standalone Node/Express | AI SDK works with any HTTP endpoint; Next.js is fastest path                                                                   |
| **Complex workflows (if needed later)** | XState                                        | State machines for approval chains, retry logic, multi-step orchestration                                                      |

This stack requires **no middleware runtime**, has **minimal vendor lock-in** (all MIT-licensed), and the assistant-ui + AI SDK integration is officially documented and battle-tested. tool-ui is in research preview but usable — its components are copy-pasted into your codebase (shadcn-style), so breaking API changes won't affect deployed code.

---

## Library landscape comparison

The React ecosystem for agentic AI interfaces has consolidated around two serious contenders, with several others serving niche or legacy roles.

| Feature                    | assistant-ui        | CopilotKit           | chatscope         | LangUI            | @llamaindex/chat-ui |
| -------------------------- | ------------------- | -------------------- | ----------------- | ----------------- | ------------------- |
| **GitHub stars**           | ~8,200              | ~25,500              | ~1,700            | ~3,100            | ~417                |
| **NPM weekly downloads**   | **~240,000**        | ~90,000              | ~38,000           | N/A               | Newer               |
| **Last release**           | Days ago            | Days ago             | **9+ months ago** | Inactive          | ~3 months ago       |
| **Maintainer**             | YC-backed company   | CopilotKit company   | Single individual | Single individual | LlamaIndex team     |
| **Streaming**              | ✅ First-class      | ✅ First-class       | ❌                | ❌                | ✅ Via AI SDK       |
| **Tool call rendering**    | ✅                  | ✅ + Generative UI   | ❌                | ❌                | ✅ Basic            |
| **Human-in-the-loop**      | ✅ Inline approvals | ✅ renderAndWait     | ❌                | ❌                | ❌                  |
| **Multi-step agent flows** | ✅ Via LangGraph    | ✅ Native (useAgent) | ❌                | ❌                | Partial             |
| **Shared agent↔UI state**  | ❌                  | ✅ Native            | ❌                | ❌                | ❌                  |
| **Multi-agent**            | ❌                  | ✅ Native            | ❌                | ❌                | ❌                  |
| **Works with Vite**        | Yes                 | Yes                  | Yes               | Yes               | Yes                 |
| **Theming**                | shadcn/Tailwind     | CSS variables        | SCSS              | Tailwind          | shadcn/Tailwind     |

**assistant-ui** leads in npm adoption and offers the most composable architecture — Radix-style primitives you fully own. Its `makeAssistantToolUI` and `makeAssistantTool` APIs map directly to agentic UX needs: render custom components for each tool call, show loading/streaming/complete states, and interrupt execution for human approval.

**CopilotKit** has more GitHub stars and richer built-in agentic features (shared state, multi-agent, AG-UI protocol adopted by Google/AWS/Microsoft). But it requires a CopilotRuntime middleware layer and introduces tighter architectural coupling. Its headless UI mode — critical for full design control — is gated behind paid plans.

**chatscope and LangUI are not viable** for agentic UIs. chatscope is a traditional messaging UI kit with no AI features and appears semi-abandoned. LangUI is a static Tailwind snippet gallery with zero runtime functionality.

---

## How agentic UX patterns actually work in practice

The dominant design pattern emerging across ChatGPT, Claude, Manus, and OpenAI Operator is **progressive disclosure with inline tool cards** — show what the agent is doing without drowning users in details.

### Tool calls deserve first-class visual treatment

Tool calls should render as **inline expandable cards** within the message stream, following a clear status progression: pending → running (with spinner or shimmer animation) → complete (with result) or error (with retry button). The Vercel AI SDK v5 natively streams partial tool-call arguments before execution completes, enabling real-time UI updates. assistant-ui's `makeAssistantToolUI` receives `args`, `result`, and `status` as props, so you render different states declaratively:

```tsx
const WeatherUI = makeAssistantToolUI<{ location: string }, { temp: number }>({
  toolName: 'getWeather',
  render: ({ args, result, status }) => {
    if (status.type === 'running') return <Shimmer label={`Checking weather in ${args.location}...`} />;
    return <WeatherCard location={args.location} temp={result.temp} />;
  },
});
```

Auto-collapse completed tool cards as new ones begin. Show a compact summary by default ("🔍 Searched 'quarterly revenue'") with a chevron to expand full input/output. For complex multi-step flows, use **step-start markers** (AI SDK v5 exposes `step-start` message parts) to visually separate sequential tool calls.

### Chain-of-thought needs a three-tier disclosure model

Claude's approach has become the industry standard: a collapsible "Thinking" block that shows duration ("Thought for 12 seconds") and auto-collapses when streaming finishes. The optimal pattern has three tiers. **Level 1** (default): a collapsed pill showing "🧠 Thinking..." during processing. **Level 2** (click to expand): a summary of key reasoning steps. **Level 3** (developer/power-user): full chain-of-thought tokens. This respects both the casual user who wants results and the power user who wants to verify reasoning.

### Human-in-the-loop requires calibrated friction

The most important HITL pattern is the **intent preview**: before any significant action, show a clear plan summary with three paths — **Proceed**, **Edit Plan**, or **Handle it Myself**. The AI SDK supports this natively with a `needsApproval` property on tools that pauses execution and renders a confirmation component. assistant-ui extends this with `makeAssistantTool` and an `interrupt`/`resume` API for custom approval flows.

The critical design concept is the **autonomy dial** — calibrate confirmation requirements to risk level. Low-risk actions (searching, reading data) should execute autonomously. High-risk actions (sending emails, making purchases, modifying data) require explicit approval. A healthy escalation frequency is **5–15% of total tasks**. More than that creates "agentic sludge" — excessive confirmations that fatigue users and defeat the purpose of automation.

### Structured outputs render inline, not in modals

Tables, charts, cards, and forms should render directly within the message stream using the AI SDK's `message.parts` approach. Each tool result maps to a React component: a `chart` tool renders a `<Chart>`, a `table` tool renders a `<DataTable>`. tool-ui provides pre-built components for common patterns: data tables, charts, code blocks, link previews, approval cards, image galleries, and terminal output — all designed for inline conversational rendering with serializable schemas.

### Five anti-patterns that kill agentic UIs

The most damaging mistakes are: **showing raw JSON or full reasoning traces by default** (use progressive disclosure instead); **no feedback during tool execution** (the "black box" problem — always show what the agent is doing); **silent failures** where the agent errors but shows no indication (provide retry buttons and escalation pathways); **unclear agent vs. user control** (always indicate who's "driving"); and **over-confirmation for low-risk actions** that creates approval fatigue.

---

## The ai-sdk + assistant-ui + tool-ui stack in detail

This is an officially supported, well-documented combination. The integration works through `@assistant-ui/react-ai-sdk`, a dedicated adapter package (v1.3.6, 26 downstream dependents). assistant-ui provides the composable UI primitives, AI SDK handles the streaming protocol and LLM communication, and tool-ui adds pre-built components for common tool-call rendering patterns.

### Architecture and data flow

The frontend uses `useChatRuntime()` from the adapter package, which creates an assistant-ui runtime backed by AI SDK's `useChat`. The `AssistantChatTransport` sends messages plus system prompts plus frontend tool definitions to your API endpoint. The backend calls `streamText()` and returns a `UIMessageStreamResponse` — a streaming format that incrementally delivers text chunks, tool call invocations, and tool results. assistant-ui's `<Thread />` component consumes the stream in real-time with auto-scrolling, markdown rendering, and tool-call lifecycle management.

### Integration gotchas to watch for

**Transport configuration is the main pitfall.** When customizing the API URL, you must use `AssistantChatTransport` (not `DefaultChatTransport`) to maintain frontend system messages and tool forwarding. Your `/api/chat` route must explicitly read and forward the `system` and `tools` fields from the request body — the docs provide a `frontendTools()` helper for this conversion. If you skip this step, the model silently won't see your frontend tool definitions.

**tool-ui is in "Research Preview"** — APIs may change. However, since it uses a copy-paste model (like shadcn), components live in your codebase after installation. Breaking upstream changes won't affect deployed code.

**AI SDK version matters.** The assistant-ui adapter targets AI SDK v5+. The older v4 adapter (`@assistant-ui/react-data-stream`) is no longer actively maintained. AI SDK v6 was recently announced with an Agent abstraction layer.

### Backend flexibility

The stack is genuinely backend-agnostic. The primary pattern is a **Next.js API route**, but it works equally well with standalone Express/Node servers, edge functions (Vercel Edge Runtime, Cloudflare Workers), or any HTTP endpoint that returns the AI SDK streaming format. Swapping LLM providers is a one-line change — replace `openai("gpt-4o")` with `anthropic("claude-sonnet-4-20250514")` using the appropriate AI SDK provider adapter.

---

## When CopilotKit makes more sense

CopilotKit is the better choice when your application needs **real-time bidirectional state synchronization between agents and UI**, **multi-agent orchestration**, or you want the fastest path to complex agentic features without wiring them yourself.

Its `useCoAgent` hook lets the frontend subscribe to backend agent state in real-time, and `useCoAgentStateRender` declaratively renders different UI components based on the agent's current execution node. The `renderAndWait` pattern for HITL is more ergonomic than assistant-ui's approach — the agent pauses, renders a custom confirmation component, and waits for user input in a single API. CopilotKit's AG-UI protocol (adopted by Google, LangChain, AWS, Microsoft) standardizes agent↔UI communication as a typed event stream, which provides a degree of future-proofing.

**The tradeoff is architectural weight.** CopilotKit requires a CopilotRuntime middleware (self-hosted or managed via Copilot Cloud). It communicates over GraphQL rather than simple HTTP streaming. The fully headless UI mode for complete design freedom requires a paid plan (~$49/month). For a solo developer building an MVP, this adds setup complexity and operational overhead that the ai-sdk + assistant-ui stack avoids.

**Where CopilotKit wins decisively:** apps where the agent needs to read and write frontend application state (e.g., an AI that modifies a form, updates a dashboard, or controls UI elements based on conversation context). CopilotKit's shared state layer eliminates the glue code you'd otherwise write with Zustand + custom events.

---

## State management strategy for agentic flows

The emerging best practice in 2025–2026 is **layered state management**: let specialized libraries own their domain rather than forcing everything into one global store.

**AI SDK's `useChat` handles chat-specific state internally** — messages, streaming status (submitted → streaming → ready → error), tool call results, tool approval flows, stop/abort, and reload/regenerate. In v5, this is built on Zustand internally, with decoupled state that integrates cleanly with external stores.

**Zustand handles application-level state** — user preferences, selected model, sidebar visibility, multi-thread management, and any cross-feature state connecting chat to other app features. This is the pattern validated at scale by **LobeChat** (63k GitHub stars), which uses Zustand as its primary state manager for a complex multi-model AI chat application.

**XState is the right tool for complex workflow orchestration** — if your agent flows involve formal approval chains, retry logic with backoff, or multi-step pipelines where state transitions need to be predictable and debuggable. The `@statelyai/agent` package integrates XState with AI SDK directly. However, for an MVP, this is likely premature. Start with AI SDK + Zustand, and introduce XState only when workflow complexity demands it.

**What you don't need external state management for:** assistant-ui manages UI-layer concerns (auto-scrolling, message branching, composing, attachments). AI SDK manages protocol-layer concerns (streaming, tool lifecycle, message reconciliation). The gap is only application-specific state, which Zustand handles elegantly with minimal boilerplate.

---

## Production readiness: three stacks ranked by ship-speed

### Stack 1: AI SDK + assistant-ui + tool-ui (Recommended)

**Ship speed: ★★★★★ | Flexibility: ★★★★☆**

Fastest path for a solo developer. `npx assistant-ui@latest create` scaffolds a working chat app in minutes. Add tool-ui components for rich tool rendering. AI SDK handles all LLM provider switching. No middleware runtime required. Mobile-responsive out of the box (Tailwind/shadcn-based). HITL via `makeAssistantTool` with interrupt/resume. The only limitation is that tool-ui is in research preview — but components are local to your codebase after copying.

### Stack 2: CopilotKit

**Ship speed: ★★★★☆ | Flexibility: ★★★☆☆**

Nearly as fast for common patterns — `<CopilotSidebar>` gives you a working chat UI immediately. Better out-of-the-box support for shared agent state and multi-agent flows. HITL via `renderAndWait` is ergonomic. Slower initial setup due to CopilotRuntime middleware. Less granular UI control without the paid headless tier. Better choice if you're building something closer to a "copilot" embedded in an existing app rather than a standalone chat interface.

### Stack 3: AI SDK + shadcn/ui AI components (manual assembly)

**Ship speed: ★★★☆☆ | Flexibility: ★★★★★**

Maximum control. Use AI SDK's `useChat` directly and build your UI with shadcn.io's 52 purpose-built AI components (Tool, Reasoning, ChainOfThought, Confirmation, Plan, Queue, Shimmer). More assembly required but zero abstraction layers between you and the DOM. Best if you have very specific design requirements that don't fit any component library's opinions.

### MVP checklist mapped to Stack 1

| Requirement                 | How it's handled                                  |
| --------------------------- | ------------------------------------------------- |
| Streaming responses         | AI SDK `streamText()` + assistant-ui `<Thread />` |
| Visible tool-call rendering | `makeAssistantToolUI` + tool-ui components        |
| Human-in-the-loop           | `makeAssistantTool` with `interrupt`/`resume`     |
| Mobile-responsive chat      | assistant-ui's Tailwind-based primitives          |
| LLM provider swapping       | AI SDK provider adapters (one-line change)        |

---

## Real-world open-source references

**Vercel Chat SDK** (github.com/vercel/ai-chatbot) — Vercel's reference implementation using Next.js + AI SDK v5. Demonstrates streaming, generative UI, custom artifacts, and in-browser code execution. The most authoritative example of AI SDK patterns in production.

**LobeChat** (github.com/lobehub/lobe-chat, **63k+ stars**) — The largest open-source AI chat project. Next.js + Zustand + SWR + Ant Design. Demonstrates multi-model support, a plugin/tool system via function calling, agent marketplace, TTS/STT, and multi-agent collaboration. Best reference for Zustand-based state management at scale.

**CopilotKit examples** (github.com/CopilotKit/CopilotKit) — The monorepo includes multiple example applications demonstrating shared state, generative UI patterns (static, declarative, open-ended), HITL flows, and multi-agent coordination. The generative UI playground is the best reference for CopilotKit-specific patterns.

**assistant-ui examples** (github.com/assistant-ui/assistant-ui/tree/main/examples) — Templates for minimal, cloud, LangGraph, and MCP setups. The composable primitive approach is demonstrated with a Perplexity-lookalike clone showing full theming customization.

**Stately Agent** (github.com/statelyai/agent) — XState + AI SDK integration for state-machine-powered agents. Smaller project but the most theoretically rigorous approach to agent workflow management, with visual debugging via Stately Studio.

---

## Conclusion

The React agentic AI UI ecosystem has matured rapidly. The field has consolidated around two viable approaches: **composable primitives** (assistant-ui + AI SDK) and **batteries-included frameworks** (CopilotKit). For a solo developer shipping an MVP in 4–6 weeks, composable primitives win — they're lighter, faster to start, more customizable, and require no middleware infrastructure.

The critical architectural insight is to **separate your concerns into layers**: AI SDK owns the streaming protocol and LLM communication, assistant-ui owns the chat UI rendering, tool-ui provides pre-built tool-call components, and Zustand handles any application state outside the chat. This layered approach lets you swap any piece without rewriting the others — including switching from OpenAI to Anthropic with a one-line change.

Start with `npx assistant-ui@latest create`, wire up your tool UIs using `makeAssistantToolUI`, and add human-in-the-loop approval gates only on high-risk actions. Resist the urge to show users everything the agent is doing — progressive disclosure with collapsible tool cards and thinking blocks is the pattern that every successful agentic product has converged on. Ship the MVP, then evaluate whether CopilotKit's shared state or XState's workflow machines are needed based on real user feedback.
