# Recommendation

For a solo dev shipping an MVP, the **Vercel AI SDK + assistant-ui + tool-ui** stack is the best starting point. This combination is proven (each project has thousands of stars and active maintenance【71†L12-L19】【73†L176-L184】), supports streaming chat, tool calls, user approvals, and works with Next.js or any Node backend【73†L379-L387】【47†L160-L168】. If you need even faster integration and don’t mind some added complexity, **CopilotKit (CoAgents)** offers a highly integrated agentic UI out of the box (28.7k stars) with built-in generative UI and shared-state features【67†L394-L404】. Conversely, lightweight chat UI kits like chatscope’s **chat-ui-kit-react** (1.7k stars) or **LangUI** (3.1k stars) are easy to style but lack native agentic features (no tool-call rendering or multi-step flow support)【65†L164-L172】【73†L379-L387】. In practice, the AI SDK + assistant-ui approach strikes the best balance of speed-to-ship and flexibility: it’s production-grade yet fully customizable.

The table below compares the main libraries as of early 2026:

| **Library**                     | **Stars**             | **Activity/Maintenance**                                              | **Features**                                                                                      | **Agentic Flow Support**                                                                                    |
| ------------------------------- | --------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **assistant-ui**                | 8.5k【73†L176-L184】  | Actively maintained (frequent commits, 2.6k+ commits【73†L220-L228】) | Streaming chat, tool-call cards, JSON rendering, human approvals【73†L379-L387】                  | Full: tool calls with results, JSON UI components, inline approvals【73†L379-L387】                         |
| **chatscope/chat-ui-kit-react** | 1.7k【65†L164-L172】  | Moderately active (recent commits, 185 issues)                        | Generic chat UI components, markdown support                                                      | **None**: basic chat interface only; no agent tooling out of the box【65†L164-L172】                        |
| **CopilotKit (CoAgents)**       | 28.7k【67†L164-L172】 | Highly active (4k+ commits, 500+ issues)                              | End-to-end agent UI: chat, generative UI, shared state, tool cards, human-in-loop【67†L394-L404】 | **Full**: built for multi-step agents (AG-UI protocol), streaming, UI components generation【67†L394-L404】 |
| **LangUI (Tailwind UI)**        | 3.1k【63†L162-L170】  | Moderately active (100+ commits)                                      | Tailwind-based UI components for AI projects (cards, buttons, modals)                             | **None**: UI primitives only; no built-in agent or chat logic【63†L162-L170】                               |
| **LangChain Agent Chat UI**     | 2.5k (LangChain)      | Active (LangChain team)                                               | Next.js app for LangChain/LangGraph agents, real-time chat, tool visualization                    | **Partial**: Auto-detects and renders LangGraph tool calls and interrupts【34†L82-L90】                     |
| **agno-agi/agent-ui**           | 1.6k【32†L163-L170】  | Active (template repo by AGNO)                                        | Next.js/Tailwind agent chat template                                                              | **Yes**: shows tools and threads (by design, but acts as a boilerplate)                                     |

## Agentic UX Patterns

- **Showing Tool Calls**: Display each tool invocation as a distinct “card” or message. Begin with a spinner or “thinking…” placeholder, then stream the response or display results when ready. For example, assistant-ui renders tool calls inline with a spinner and then replaces it with the result once received【73†L379-L387】. Use visual separation (cards, colors, or icons) to distinguish agent utterances from tool results. Allow expanding details on demand to avoid clutter. Streaming text (progressive reveal) is critical for latency feedback. Spinner animations or skeletons keep users informed during long tool executions.

- **Chain-of-Thought / Reasoning**: Agentic UIs often log intermediate reasoning steps. Best practice is to _collapse_ or “show more” these by default, unless the user explicitly wants them. For instance, a summarized assistant message plus a hidden section for reasoning maintains clarity. Do **not** dump all LLM “thinking” text unfiltered – that overwhelms users. Instead, display just enough context: e.g. “(Agent is analyzing...)” with an option to expand the chain-of-thought. Use tooltips or small “info” icons for brevity, and consider formatting steps as a simple bullet list if shown. Some apps mark internal reasoning in gray or italic to differentiate it from final responses.

- **Branching Flows**: If the agent can take multiple actions (e.g. decide between tools), represent this as either an alternate conversation thread or choices. Some interfaces (like LangChain’s Agent Chat UI) allow _thread forking_ – e.g., “pause/continue here” or alternate replies for a query. Another pattern is a tree view: show the main chat plus collapsible side paths where the agent tried different tools. Always give the user context like “Tool X was called with args Y – see result below or collapse.” This prevents confusion when multiple calls interleave.

- **Human-in-the-Loop (HITL)**: Provide explicit checkpoints where the agent asks for user input or confirmation. Show prompt messages like “Agent requests approval for action” with Accept/Cancel buttons inline. assistant-ui supports inline approvals (render a prompt card with Yes/No)【73†L379-L387】. Use clear language (“Proceed?”, “Is this correct?”) and a distinct UI (e.g. a bold banner). Allow users to edit agent suggestions: for example, display the agent’s proposed next user message with an “Edit & Continue” option. An anti-pattern is auto-executing tools without consent; always visualize pending actions prominently.

- **Structured Outputs**: When the agent returns data (tables, JSON, forms, maps), render them using rich components, not raw text. Libraries like assistant-ui can convert JSON responses into React components (tables, charts, etc.)【73†L379-L387】. For example, if a tool returns a list of items, display as an HTML table or cards with headings. Map results (like location data) can embed a mini-map widget. Attachments (images, PDFs) should be previewed or downloadable. Avoid showing raw code blocks or JSON dumps to users; instead parse and format them. Use `tool-ui` or similar to render custom outputs.

- **Anti-Patterns**:
  - Dumping raw chain-of-thought without context (fills UI with noise).
  - Using purely modal dialogs for agent actions (breaks conversational flow).
  - Blocking the chat while a tool runs (instead, stream progress).
  - Mixing agent messages and user messages indistinguishably.
  - Not indicating when the agent is stuck or waiting for input (leave the user guessing).
  - Changing UI elements unexpectedly (e.g. jumping content) – ensure stable layout with spinners/placeholders.

## Stack Compatibility (Vercel AI SDK + assistant-ui + tool-ui)

The **Vercel AI SDK (“ai” package)** is framework-agnostic but optimized for Next.js/Node environments【47†L162-L170】【71†L12-L19】. It provides hooks (e.g. `useChat`) and streaming APIs. The AI SDK (21.7k stars【71†L12-L19】) is battle-tested and plays well with assistant-ui. The official assistant-ui docs explicitly note that it “works with AI SDK, LangGraph, Mastra, or any custom backend”【73†L379-L387】. In practice, people use Next.js App Router with `app/api/route.ts` to call `ai` on the server and stream to assistant-ui on the client【45†L19-L24】【73†L379-L387】. There are two common patterns:

- **Next.js Full-Stack**: Build frontend and backend in one Next.js project. Use API routes or the App Router’s server functions to run agent logic (calling OpenAI/Anthropic via AI SDK). assistant-ui’s `ExternalStoreRuntime` can connect to these endpoints seamlessly【36†L347-L356】【43†L53-L60】. This is “serverless-friendly” on Vercel or any Node host.
- **Separate Backend**: Run the agent (e.g. Mastra or a custom server) separately. assistant-ui/tool-ui on React can fetch from that backend. The docs show “Separate Server Integration” for Mastra【43†L53-L60】. AI SDK can also run in a plain Node server (or even Edge functions if you configure correctly). CopilotKit’s docs similarly assume a backend agent endpoint (e.g. FastAPI or Node) serving AG-UI events.

No major gotchas have emerged in community reports. Key points: if using AI SDK streaming, your Next.js API should return an `ai.createAgentUIStreamResponse()` (per docs) so assistant-ui can consume streams【45†L19-L24】. The stack assumes modern React (e.g. Next.js or Vite) and Node runtime (server functions or edge functions). All pieces are MIT licensed and play well together. In short, **ai-sdk + assistant-ui + tool-ui is a proven combo**: Vercel’s SDK handles LLM calls, assistant-ui renders the chat, and tool-ui has prebuilt tool result components【73†L379-L387】【41†L162-L170】.

## CopilotKit vs. AI SDK + assistant-ui + tool-ui

**CopilotKit (CoAgents)** is an all-in-one React framework specifically built for agentic UIs. It offers prebuilt components and hooks (like `useAgent`) that simplify multi-step flows. Pros:

- **Generative UI**: Out-of-the-box support for dynamic UI components and forms generated by the agent【67†L394-L404】.
- **Shared State & A2A**: Built-in AG-UI shared-state and even agent-to-agent calls.
- **Human-in-Loop**: Built support for input prompts, confirmations, edits (they call these “agent workflow events”).
- **Examples/Scaffolding**: Has CLI and templates (UI, backend, even Figma design tokens).
- **High Feature Count**: According to its README, it natively supports chat streaming, tool calls, and agent instructions【67†L394-L404】.

Cons:

- **Learning Curve & Weight**: It’s a large framework (4k commits) and enforces the AG-UI protocol. You might pull in lots of dependencies.
- **Opinionated**: Works best when you adopt its way (AG-UI event protocol). That can be great, but is less flexible if you just need a simple UI.
- **LangGraph Focus**: Currently optimized for LangGraph/Mastra patterns (some limitations noted, e.g. file uploads might not be implemented yet, per community comments).
- **UI Look**: Very functional but less aesthetic by default (you’ll style with Tailwind or CSS as needed).

By contrast, **AI SDK + assistant-ui + tool-ui**:

- **Flexibility**: You choose each piece. assistant-ui is headless (unopinionated styling) and works with any LLM provider or agent framework【73†L379-L387】.
- **Modularity**: If you only need chat + streaming, you can use just assistant-ui’s chat primitives and ignore the rest. If you prefer a different tool renderer (say a custom card), you can override it.
- **Simplicity**: The code surface is smaller. You manage state explicitly (e.g. React `useState` or external store) rather than adopting a whole new protocol.
- **However**: You will wire more glue. E.g. collecting human approvals requires you to implement an “edit/confirm” flow manually or use assistant-ui’s handlers.

**Developer Experience**: CopilotKit gives you more out of the box (fast for a turnkey agent UI) but less control. The ai-sdk + assistant-ui path requires a bit more setup (especially state management) but is well-documented and battle-tested by many teams【73†L379-L387】【47†L162-L170】. For one developer on a tight deadline, starting with CopilotKit might feel faster initially, but if you need maximum customization or are already comfortable with React/Next.js, assistant-ui is arguably more straightforward.

## State Management for Agent Flows

Neither assistant-ui nor chatscope _enforces_ a particular state store; they expect you to feed them a message array. Complex agent state (threads, tool results, shared variables) must be managed by you or the underlying framework. Options:

- **React State/Context**: Keep the entire chat history and any “thread IDs” in React `useState` or Context (the assistant-ui `ExternalStoreRuntime` example uses an external store)【36†L347-L356】.
- **Zustand/Jotai/MobX**: These lightweight stores can hold chat threads and sync components. e.g. use a Zustand store with a list of messages and mutate it as agent events arrive (like `addMessage`, `updateToolResult`).
- **XState**: Some teams use a statechart (XState) to model agent workflows (states like “thinking”, “calling API”, “awaiting user confirmation”). This can cleanly handle parallel branches and retries. CopilotKit under the hood emits state events (AG-UI protocol) which could be plugged into XState if desired.
- **Built-in protocol (AG-UI)**: If using CopilotKit or LangGraph, they follow AG-UI’s sync protocol【70†L100-L104】. This means the agent can send full state snapshots or deltas to the frontend. The Ag-UI docs highlight that _“State management is a core feature”_ enabling real-time sync of an object shared by agent and UI【70†L100-L104】. In practice, CopilotKit’s `useAgent` hook subscribes to such updates, giving you a live `agent.state` to read.
- **Assistant-UI Approach**: For assistants not using AG-UI, assistant-ui suggests you manage state in an “ExternalStoreRuntime”. For example, it demonstrates handling `onAddToolResult` to attach results to specific message IDs【36†L429-L438】【36†L454-L462】. It does not recommend a particular library, but patterns like using a `Map<threadId, messages[]>` or similar for branches, and a flat array with parent IDs for nested messages.

**Conclusion**: If you pick the ai-sdk+assistant-ui route, plan to add a small state library. Zustand is lightweight and popular. XState is powerful if you foresee many branches or parallel calls. CopilotKit already provides a hook into AG-UI state events if you use it, so less additional setup there. Overall, for a solo dev MVP, a simple store (or even React state) plus careful message threading is sufficient; you can upgrade to XState later if flows grow complex.

## Production-Ready MVP Stacks

We recommend **two top stacks** for 4–6 week MVPs, ranked by _speed vs flexibility_:

1. **AI SDK + assistant-ui + tool-ui** _(balanced, flexible, proven)_: This stack yields a clean React chat UI with streaming, tool calls, and HITL without too much boilerplate. It is highly customizable (Tailwind, shadcn themes, etc) and already used in production by Y Combinator-backed projects【73†L379-L387】【71†L12-L19】. For backend you can use Next.js API routes to host LLM calls via the AI SDK, which allows easy swapping of OpenAI/Anthropic/etc providers【47†L162-L170】. This combo directly satisfies all requirements: streaming text, visible tool cards, approval dialogues (assistant-ui supports inline approvals), mobile-responsive UI, and pluggable LLMs. Caveat: you’ll write a bit of “glue” code to feed events (see [36] for patterns). But documentation and examples are solid, and the community is active.

2. **CopilotKit (React) + Node Backend** _(rapid, integrated, opinionated)_: If you want the fastest route to an “agentic” interface and don’t need a custom look immediately, CopilotKit provides most features out of the box. Its chat UI already handles streaming, messages, tool cards, generative UI components, and user confirmations【67†L394-L404】. You still need a backend (e.g. FastAPI, Node, or Next.js) that speaks the AG-UI protocol, but the docs include CLI tools to scaffold this. The downside is its complexity and weight; customization (especially theming) takes more effort. Use this if time-to-demo > control. It also supports multiple frontends (React or Angular) and advanced paradigms (agent chaining, multi-agent), which may be overkill for MVP.

3. **LangChain Agent Chat UI + Mastra/LangGraph** _(works if you use LangChain)_: If you are already committed to LangChain/Mastra agents, use their _Agent Chat UI_. It’s a ready-made Next.js app that plugs into any LangChain agent. It handles streaming, displays tool calls, and even offers time-travel debugging【34†L82-L90】. It can be forked or used as a starter template. Downsides: less flexible (tailored to LangChain’s JSON format) and heavy if you don’t need LangChain-specific features.

(N.B. Charts, maps, or dashboards: In any stack above, you’ll embed components or rely on helper libraries. For example, a tool returning tabular data could be rendered using assistant-ui’s JSON-to-React or a custom table component.)

## Real-World Examples

- **LangChain Agent Chat UI** (https://github.com/langchain-ai/agent-chat-ui, ★2.5k): A Next.js app by LangChain that connects to any LangGraph agent. It supports real-time streaming chat, auto-detects tool calls, and even has “time-travel” debugging of agent state【34†L82-L90】. _Stack:_ Next.js, Tailwind, LangChain (Python) backend. _Patterns:_ Shows tool cards inline, uses modals for Agent interrupts, threads for conversation forks.

- **assistant-ui Cloud Playground & Examples** (https://github.com/assistant-ui/examples): Official demos showing agent chat flows. For example, a stockbroker agent demo uses assistant-ui + Mastra. _Stack:_ assistant-ui components on React, Mastra TypeScript backend. _Patterns:_ Progressive text streaming, dynamic UI for attachments, a sidebar of threads, and JSON output rendering.

- **agno-agi/agent-ui** (https://github.com/agno-agi/agent-ui, ★1.6k): A public template “modern chat interface for AI agents” using Next.js + Tailwind【32†L163-L170】. It includes example tool calls and threads. _Stack:_ Next.js + AGNO’s agent server. _Patterns:_ Clean chat bubbles, collapsible tool results, multi-tab support for conversations.

- **filiksyos/mcp-chat-ui** (https://github.com/filiksyos/mcp-chat-ui, ★4): An open-source demo for Model Context Protocol agents. _Stack:_ Vite + React frontend, Node WebSocket server with OpenRouter agent. _Patterns:_ Distinct cards for each tool call/result (with args displayed), Google Auth integration. (Though low-star, it explicitly demos agentic flows with tool call visibility.)

- **mckaywrigley/chatbot-ui** (https://github.com/mckaywrigley/chatbot-ui, ★33k): A general-purpose chat UI. While not specialized for agents, many AI projects use it with LLMs because it handles streaming, multi-modal content, and theming. _Stack:_ React, supported on Next.js/Vercel. _Patterns:_ Basic chat only (no built-in tool visualization), but it's included here for contrast: it uses markdown/chat bubbles and supports sidebar history. It would require custom integration to show tool calls.

- **ThinkInAIXYZ/DeepChat** (https://github.com/ThinkInAIXYZ/deepchat, ★3.9k): A desktop (Electron/Vite) app that unifies LLM chats, tools, and an “agent client protocol”. It _is_ React-based for the UI. _Stack:_ React (Electron) + Python backend connectors. _Patterns:_ Multiple windows/tabs for sessions, interactive visualizations (charts, code renderer), displays tool results, supports agent “forks” in the UI. (Useful as inspiration but too heavy for a quick web MVP.)

Each of the above can be explored on GitHub for concrete patterns. Most use React with either Next.js or Vite. The first three (LangChain UI, assistant-ui demos, AGNO) use Tailwind/CSS for styling and clearly separate user messages, agent reasoning, and tool outputs as described.

## Final Recommended Stack

**Vercel AI SDK + assistant-ui + tool-ui (React/Next.js)**

- **Why**: This stack is **fast to ship** (battle-tested components, built-in streaming, themeable UI) yet **high-quality**. It natively supports rich agent flows: streaming text, grouped tool call cards, and human approvals【73†L379-L387】【47†L162-L170】. You get full control over the UI and can iterate on the backend freely. It’s production-ready (complete chat UX, accessibility, mobile-friendly) with minimal coding beyond wiring your agent logic.

**Optional**: For a speedier (but more complex) alternative, consider **CopilotKit (React)** with a simple Node backend. It delivers a more “all-in-one” agent interface including generative UI widgets and shared-state sync【67†L394-L404】. However, it locks you into its protocol.

In summary, for a one-developer team with 4–6 weeks to go, we recommend starting with **Vercel’s AI SDK + assistant-ui + tool-ui**. It offers the best balance of **speed**, **customizability**, and **enterprise readiness** (streaming, tool calls, HITL, multi-provider support)【73†L379-L387】【71†L12-L19】. You can then layer in copilotKit or other libs if you later need more advanced agent orchestration features.

**Follow-Up Questions:**

- **Q1:** Which LLM providers (OpenAI, Anthropic, etc.) do you plan to support, and do you need server-side vs. client-side integration?
- **Q2:** How complex are your agent’s tool workflows (parallel tasks, loops, retries), and would a statechart (e.g. XState) help manage them?
- **Q3:** Do you require multi-user or multi-session capabilities (e.g. user accounts, session persistence)?
- **Q4:** Which UX style do you prefer: a minimal/lightweight chat or a highly customized branded interface?
- **Q5:** Are there any specific “rich outputs” (charts, maps, forms) your agent must produce, and do you have libraries ready to render them?
