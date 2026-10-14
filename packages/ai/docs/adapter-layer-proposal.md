# Proposal: `@arki/ai` agent-runtime + UI adapter layer

Status: draft / RFC. Author evidence: the brandability runtime+UI bake-off
(`apps/brandability/backend/spikes/EVALUATION.md`), 2026-06-01.

## Problem

We just proved (5 runtimes × 1 tool-loop, all behaviorally equivalent) that the agentic
tool-loop is a **commodity**. Yet today a feature that picks Mastra (or LangGraph, or
TanStack AI) couples itself to that framework's tool API, event model, memory, and UI wire
format. Swapping later = rewrite. Meanwhile `@arki/ai` already owns the cross-cutting
concerns every framework lacks: LAW-1 provider precedence, cost/budget enforcement, safety.

We want: **pick a runtime/UI for its platform strengths, without making it load-bearing.**

## Key insight (why this is feasible, not aspirational)

The bake-off is the proof. Every runtime ran the **same `ToolLoopResult` contract** over the
**same `tool({inputSchema, execute})` tools**, and every UI consumed a **streaming event
protocol**. The differences are spelling. An adapter sits exactly on those two seams — both
of which `@arki/ai` already has:

| Seam | Existing neutral contract | Adapt outward to |
|---|---|---|
| **Tool / evidence** | AI-SDK `tool()` + `AssessmentEvidenceItem` | Mastra `createTool`, LangChain `tool`, TanStack `toolDefinition`, MCP tool |
| **Runtime events** | `Flow`'s `FlowEvent` (`node:*`, `tool:*`, `flow:*`) | AI-SDK `onStepFinish`, Mastra steps, LangGraph stream, TanStack chunks |
| **UI** | the same `FlowEvent`/UI-message stream | assistant-ui, CopilotKit, TanStack AI, bespoke War Room |

## Proposed shape

### 1. Runtime adapter (backend)

```ts
// @arki/ai/runtime
export interface AgentRuntime {
  /** Run an agentic tool-loop; emit a normalized event stream. */
  runToolLoop(input: ToolLoopInput): AsyncIterable<RuntimeEvent>;
}
export type RuntimeEvent =
  | { type: 'tool:start'; tool: string; args: unknown }
  | { type: 'tool:result'; tool: string; evidence: AssessmentEvidenceItem[] }
  | { type: 'text-delta'; delta: string }
  | { type: 'finish'; usage?: Usage };

// backends — each ~50-110 LOC (the bake-off arms ARE these, minus the contract)
createAiSdkRuntime(opts)      // wraps generateText/streamText (the @arki/ai baseline)
createMastraRuntime(opts)     // wraps Mastra Agent (+ optional memory/evals/MCP)
createLangGraphRuntime(opts)  // wraps a StateGraph (note: overlaps Flow — pick one)
createTanStackRuntime(opts)   // wraps @tanstack/ai chat()
```

`ToolLoopInput` carries `tools` in the neutral `tool()` form; each adapter converts to its
framework's tool type at the boundary (the conversion functions already exist:
`convertToolsToProviderFormat`, Mastra `createTool`, LC `tool`, `toolDefinition`).

LAW-1 provider resolution, `@arki/ai/cost`, and `@arki/ai/safety` wrap **every** runtime —
they live in the adapter layer, not in any one framework.

### 2. UI adapter (frontend)

`@arki/ai/react` already exports hooks/components, and **`@arki/chat-ui` already maps the
event stream onto assistant-ui** — so one UI adapter exists in practice. Generalize it:

```ts
// @arki/ai/react
function useAgentStream(source): { messages, status, send }   // normalized
// renderers: assistant-ui (default, via @arki/chat-ui) · TanStack AI · CopilotKit · War Room
```

## The hard caveat (the part that keeps this from rotting)

**Adapt the two narrow, stable seams — NOT each framework's full surface.** A god-wrapper
over Mastra's memory + LangGraph's graph + TanStack's hooks becomes a leaky
lowest-common-denominator that loses every framework's reason to exist. Specifically:

- Adapt: tool contract, run→event stream, model/provider selection (LAW-1), cost, safety.
- **Do NOT** abstract: memory APIs, eval harnesses, graph builders, generative-UI. If a
  feature needs Mastra memory, it depends on Mastra memory directly — the adapter covers the
  loop, the feature owns the depth.

## Phasing

1. **P0 (✅ SHIPPED 2026-06-01):** `RuntimeEvent` + `AgentTool` + `ToolLoopInput` + `AgentRuntime`
   in `src/runtime/types.ts`; `createAiSdkRuntime` + `toAiSdkToolSet` in `src/runtime/ai-sdk-runtime.ts`
   (zero new deps — uses `ai` already in `@arki/ai`). Exported from the main `@arki/ai` barrel.
   4 mock-model tests (`src/runtime/ai-sdk-runtime.test.ts`); full package suite 27/27 green,
   typecheck clean. `debugRuntime` (`DEBUG=ai:runtime`) added.
2. **P1 (✅ SHIPPED 2026-06-01):** `createMastraRuntime` at the `@arki/ai/mastra`
   subpath, same `AgentRuntime` interface (decision "b"). `@mastra/core` is an OPTIONAL peer
   dependency (NOT in the main barrel), so the ~18 `@arki/ai` consumers don't transitively pull
   Mastra. Model typed as Mastra's `MastraModelConfig` (sidesteps the ai-v6 `LanguageModel`
   string-arm skew). 3 tests incl. a mock-model stream-mapping test. Memory/evals/MCP stay
   Mastra-specific, NOT abstracted.
   **Wired live:** the brandability assessment-agent `evidence` node now runs its OPTIONAL tools
   (linguistic-form, distinctiveness) as an agentic loop through this runtime against local
   Ollama (LAW-1), with a deterministic fallback if no model is reachable (LAW-2). Verified
   end-to-end: model chose both tools, emitted War Room `tool:*` events, produced 5 evidence
   items. See `apps/brandability/backend/src/features/assessment-agent/optional-tools-runtime.ts`.
3. **P2 (✅ SHIPPED 2026-06-01):** UI adapter generalized. `runtimeEventReducer` +
   `RuntimeUiState`/`RuntimeToolCall` in `src/runtime/ui-state.ts` — a PURE, framework-agnostic
   fold of the `RuntimeEvent` stream into renderable state (5 committed tests). React binding
   `useRuntimeStream` in `src/react/hooks/useRuntimeStream.tsx` consumes any
   `AsyncIterable<RuntimeEvent>` (a runtime's `runToolLoop()` directly, or an SSE-decoded
   client stream) and applies the reducer with abort lifecycle. The War Room, `@arki/chat-ui`,
   and any TanStack surface now reduce ONE event shape uniformly.
   **SSE transport (client story complete):** `toRuntimeEventStreamResponse` (server) +
   `readRuntimeEventStream` / `fetchRuntimeEventStream` (client) in `src/runtime/sse.ts` —
   web-standard SSE framing, round-trip tested. Full chain proven end-to-end against Ollama:
   `createMastraRuntime.runToolLoop()` → SSE → `fetchRuntimeEventStream` → `runtimeEventReducer`
   → `RuntimeUiState`. `@arki/ai` suite **38/38**.
   **`@arki/chat-ui` flipped:** new `@arki/chat-ui/runtime-conversation` `<RuntimeConversation
   state={RuntimeUiState} />` renders the reduced runtime stream through chat-ui's styled
   primitives (AgentStatus / ToolCall / MarkdownMessage) — a runtime-agnostic counterpart to the
   assistant-ui-backed `Thread`. So any backend renders through one component via
   `useRuntimeStream` + `fetchRuntimeEventStream`. (chat-ui gained a type-only `@arki/ai` dep;
   render-verified via react-dom/server.) Remaining (future): a TanStack-AI renderer when it matures.
4. **P3 (only if needed):** `createLangGraphRuntime` / `createTanStackRuntime`. Note
   LangGraph's `StateGraph` overlaps our `Flow` — adopting it is a *replacement* decision.

## Risks

- **Over-abstraction** (covered above) — the #1 failure mode.
- **LangGraph vs Flow duplication** — they're the same primitive; don't run both.
- **CopilotKit local-Ollama** — its v2 runtime rejects the native Ollama adapter; only the
  OpenAI-compat `/v1` shim works. Gate any CopilotKit renderer on resolving this.
- **TanStack AI maturity** (0.24) — adapter insulates us, so we can wait and watch.
